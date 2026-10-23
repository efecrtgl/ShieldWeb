const express = require("express");
const mongoose = require("mongoose");
const config = require("../../config");
const { Business, DiscordUser, ServerStats } = require("../../models/ServerInfo");
const { getUserPermissions } = require("../../services/permissions");
const { actorFrom, logAction } = require("../../services/auditLog");
const { activeProcesses, pending, isConnected } = require("../../services/botRegistry");
const { verifyDiscordGuildMember } = require("../../services/discordApi");
const { sortByRank, describeGroupMembers } = require("../../services/groupMembers");
const { newRequestId, isSnowflake } = require("../../utils/http");

const router = express.Router();

const MAX_MEMBERS = 50;
const BOT_RESPONSE_TIMEOUT_MS = 10000;
const DEFAULT_BUSINESS_COLOR = "#f59e0b";

function allow(...flags) {
  return async (req, res, next) => {
    const perms = await getUserPermissions(req.session.user);
    if (!perms || (!perms.isSuperuser && !flags.some(flag => perms[flag]))) {
      return res.status(403).json({ success: false, message: "Yetersiz yetki." });
    }
    next();
  };
}

function parseMaxMembers(value) {
  const parsed = parseInt(value, 10);
  return isNaN(parsed) || parsed < 0 || parsed > MAX_MEMBERS ? MAX_MEMBERS : parsed;
}

function bossIdOrNone(bossId) {
  return bossId && String(bossId).trim() ? String(bossId).trim() : "none";
}

async function findBusiness(req, res) {
  const business = mongoose.Types.ObjectId.isValid(req.params.id) ? await Business.findById(req.params.id) : null;
  if (!business) res.status(404).json({ success: false, message: "İşletme bulunamadı." });
  return business;
}

router.post("/admin/businesses/add", allow("createTeams"), async (req, res) => {
  const botProcess = activeProcesses.moderation;
  if (!botProcess || botProcess.killed) {
    return res.status(503).json({ success: false, message: "Moderasyon botu aktif değil." });
  }
  try {
    const { name, color } = req.body;
    if (!name || !color) {
      return res.status(400).json({ success: false, message: "Lütfen işletme adı ve rengini doldurun." });
    }
    const bossId = bossIdOrNone(req.body.bossId);
    const stats = await ServerStats.findOne();
    const requestId = newRequestId();

    pending.teams[requestId] = {
      res,
      req,
      timeout: setTimeout(() => {
        delete pending.teams[requestId];
        res.status(504).json({ success: false, message: "İşlem zaman aşımına uğradı." });
      }, BOT_RESPONSE_TIMEOUT_MS),
      data: {
        name,
        color,
        bossId,
        type: "business",
        isBusinessModel: true,
        maxMembers: parseMaxMembers(req.body.maxMembers),
        createdById: req.session.user.id,
        createdByUsername: req.session.user.username
      }
    };

    botProcess.send({
      type: "CREATE_DISCORD_TEAM",
      name,
      color,
      bossId,
      teamType: "business",
      businessCategoryId: (stats && stats.businessCategoryId) || config.discord.businessCategoryId,
      bossRoleId: (stats && stats.bossRoleId) || config.discord.bossRoleId,
      executorId: req.session.user.id,
      executorUsername: req.session.user.username,
      requestId
    });
  } catch (err) {
    console.error("Add business error:", err);
    res.status(500).json({ success: false, message: "İşletme oluşturulurken sunucu hatası oluştu." });
  }
});

router.post("/admin/businesses/edit/:id", allow("editTeams"), async (req, res) => {
  try {
    const business = await findBusiness(req, res);
    if (!business) return;

    const bossId = bossIdOrNone(req.body.bossId);
    business.name = req.body.name || business.name;
    business.color = req.body.color || business.color;
    business.bossId = bossId;
    business.maxMembers = parseMaxMembers(req.body.maxMembers);
    await business.save();

    if (isSnowflake(bossId)) {
      await DiscordUser.findOneAndUpdate({ discordId: bossId }, { businessId: business._id });
    }

    const botProcess = activeProcesses.moderation;
    if (isConnected(botProcess)) {
      botProcess.send({
        type: "EDIT_DISCORD_TEAM",
        roleId: business.roleId,
        channelId: business.channelId,
        name: business.name,
        color: business.color,
        bossId,
        executorId: req.session.user.id,
        executorUsername: req.session.user.username
      });
    }

    logAction("businessEdit", {
      executor: actorFrom(req),
      target: { id: business._id.toString(), username: business.name, data: business },
      details: `İşletme düzenlendi: ${business.name}`,
      context: "Web Panel"
    });
    res.json({ success: true, message: "İşletme başarıyla güncellendi." });
  } catch (err) {
    console.error("Edit business error:", err);
    res.status(500).json({ success: false, message: "İşletme güncellenirken hata oluştu." });
  }
});

router.post("/admin/businesses/delete/:id", allow("deleteTeams"), async (req, res) => {
  try {
    const business = await findBusiness(req, res);
    if (!business) return;

    const botProcess = activeProcesses.moderation;
    if (isConnected(botProcess)) {
      botProcess.send({
        type: "DELETE_DISCORD_TEAM",
        roleId: business.roleId,
        channelId: business.channelId,
        teamName: business.name,
        executorId: req.session.user.id,
        executorUsername: req.session.user.username
      });
    }

    await DiscordUser.updateMany({ businessId: business._id }, { businessId: null });
    await Business.findByIdAndDelete(business._id);

    logAction("businessDelete", {
      executor: actorFrom(req),
      target: { id: business._id.toString(), username: business.name, data: business },
      details: `İşletme silindi: ${business.name}`,
      context: "Web Panel"
    });
    res.json({ success: true, message: "İşletme başarıyla silindi." });
  } catch (err) {
    console.error("Delete business error:", err);
    res.status(500).json({ success: false, message: "İşletme silinirken hata oluştu." });
  }
});

router.get("/admin/businesses/:id/members", allow("viewTeams", "viewOverview"), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Geçersiz işletme ID." });
    }
    const business = await findBusiness(req, res);
    if (!business) return;

    const memberConditions = [{ businessId: business._id }];
    const bossIds = business.bossId && business.bossId.trim() !== "none"
      ? business.bossId.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
      : [];
    if (bossIds.length > 0) memberConditions.push({ discordId: { $in: bossIds } });

    const members = await DiscordUser.find({ $or: memberConditions, username: { $ne: "Bilinmeyen Kullanıcı" } }).populate("rankId");

    res.json({
      success: true,
      business: {
        _id: business._id,
        name: business.name,
        color: business.color || DEFAULT_BUSINESS_COLOR,
        bossId: business.bossId,
        maxMembers: business.maxMembers || MAX_MEMBERS,
        notes: business.notes || ""
      },
      members: await describeGroupMembers(sortByRank(members))
    });
  } catch (err) {
    console.error("Get business members error:", err);
    res.status(500).json({ success: false, message: "İşletme detayları yüklenirken hata oluştu." });
  }
});

router.post("/admin/businesses/:id/members/add", allow("editTeams", "teamAddMember"), async (req, res) => {
  try {
    const discordId = String(req.body.discordId || "").trim();
    if (!isSnowflake(discordId)) {
      return res.status(400).json({ success: false, message: "Geçerli bir Discord ID giriniz." });
    }
    const business = await findBusiness(req, res);
    if (!business) return;

    const memberCheck = await verifyDiscordGuildMember(discordId);
    if (!memberCheck.inGuild) {
      return res.status(400).json({ success: false, message: memberCheck.error || "Bu kullanıcı ana Discord sunucumuzda bulunmamaktadır!" });
    }

    const user = await DiscordUser.findOne({ discordId });
    if (user) {
      user.businessId = business._id;
      await user.save();
    } else {
      await new DiscordUser({ discordId, username: memberCheck.username, avatarUrl: memberCheck.avatarUrl, businessId: business._id }).save();
    }

    const botProcess = activeProcesses.moderation;
    if (isConnected(botProcess)) {
      const stats = await ServerStats.findOne();
      botProcess.send({
        type: "ADD_USER_TO_TEAM",
        discordId,
        roleId: business.roleId,
        channelId: business.channelId,
        teamName: business.name,
        teamId: business._id.toString(),
        isBusiness: true,
        whitelistRoleId: (stats && stats.whitelistRoleId) || config.discord.whitelistRoleId,
        unregisteredRoleId: (stats && stats.unregisteredRoleId) || config.discord.unregisteredRoleId,
        executorUsername: actorFrom(req).username
      });
    }
    res.json({ success: true, message: "Üye işletmeye başarıyla eklendi ve Discord rolü/ticket kanal yetkisi verildi." });
  } catch (err) {
    console.error("Add business member error:", err);
    res.status(500).json({ success: false, message: "Üye eklenirken hata oluştu." });
  }
});

router.post("/admin/businesses/:id/members/remove", allow("editTeams", "teamRemoveMember"), async (req, res) => {
  try {
    const business = await findBusiness(req, res);
    if (!business) return;

    const targetId = req.body.userId || req.body.discordId;
    if (!targetId) {
      return res.status(400).json({ success: false, message: "Geçersiz kullanıcı ID." });
    }
    let user = mongoose.Types.ObjectId.isValid(targetId) ? await DiscordUser.findById(targetId) : null;
    if (!user) user = await DiscordUser.findOne({ discordId: String(targetId).trim() });
    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı." });
    }

    user.businessId = null;
    await user.save();

    const botProcess = activeProcesses.moderation;
    if (isConnected(botProcess)) {
      botProcess.send({
        type: "REMOVE_USER_FROM_TEAM",
        discordId: user.discordId,
        roleId: business.roleId,
        channelId: business.channelId,
        teamName: business.name,
        executorUsername: req.session.user.username
      });
    }
    res.json({ success: true, message: "Üye işletmeden çıkarıldı ve Discord rolü alındı." });
  } catch (err) {
    console.error("Remove business member error:", err);
    res.status(500).json({ success: false, message: "Üye çıkarılırken hata oluştu." });
  }
});

router.post("/admin/businesses/:id/voice-support", allow("editTeams", "teamVoiceSupportToggle"), async (req, res) => {
  try {
    const business = await findBusiness(req, res);
    if (!business) return;

    const botProcess = activeProcesses.moderation;
    if (!isConnected(botProcess)) {
      return res.status(503).json({ success: false, message: "Moderasyon botu aktif değil." });
    }

    const stats = await ServerStats.findOne();
    const requestId = newRequestId();
    // The bot answers with TOGGLE_TEAM_VOICE_SUPPORT_RESPONSE, which is resolved from the team request table.
    pending.teams[requestId] = {
      res,
      req,
      data: { id: business._id.toString() },
      timeout: setTimeout(() => {
        delete pending.teams[requestId];
        res.status(504).json({ success: false, message: "İşlem zaman aşımına uğradı." });
      }, BOT_RESPONSE_TIMEOUT_MS)
    };

    botProcess.send({
      type: "TOGGLE_TEAM_VOICE_SUPPORT",
      roleId: business.roleId,
      voiceSupportRoleId: (stats && stats.voiceSupportRoleId) || config.discord.voiceSupportRoleId,
      executorId: req.session.user.id,
      executorUsername: req.session.user.username,
      requestId
    });
  } catch (err) {
    console.error("Business voice support error:", err);
    res.status(500).json({ success: false, message: "Sesli destek işlemi sırasında hata oluştu." });
  }
});

router.post("/admin/businesses/notes/:id", allow("editTeams"), async (req, res) => {
  try {
    const business = await findBusiness(req, res);
    if (!business) return;
    business.notes = req.body.notes || "";
    await business.save();
    res.json({ success: true, message: "İşletme notları kaydedildi." });
  } catch (err) {
    console.error("Business notes save error:", err);
    res.status(500).json({ success: false, message: "Notlar kaydedilirken hata oluştu." });
  }
});

module.exports = router;
