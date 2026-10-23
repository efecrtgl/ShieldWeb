const express = require("express");
const mongoose = require("mongoose");
const config = require("../../config");
const { Team, Business, DiscordUser, ServerStats, TeamWipe, PunishmentRecord, FivemCharacter, DeletedCharacter } = require("../../models/ServerInfo");
const { getUserPermissions } = require("../../services/permissions");
const { actorFrom, logAction } = require("../../services/auditLog");
const { activeProcesses, pending, getConnectedBot, isConnected } = require("../../services/botRegistry");
const { verifyDiscordGuildMember } = require("../../services/discordApi");
const { sortByRank, describeGroupMembers } = require("../../services/groupMembers");
const { fivem, queueCommand, queueCharacterDeletion } = require("../../services/fivemState");
const { newRequestId, isSnowflake } = require("../../utils/http");

const router = express.Router();

const MAX_MEMBERS = 50;
const BOT_RESPONSE_TIMEOUT_MS = 10000;
const WIPE_TIMEOUT_MS = 15000;
const UNWIPE_TIMEOUT_MS = 20000;
// Membership/delete changes are already saved; after this delay the request succeeds even without a bot reply.
const OPTIMISTIC_REPLY_MS = 3500;

function allow(...flags) {
  return async (req, res, next) => {
    const perms = await getUserPermissions(req.session.user);
    if (!perms || (!perms.isSuperuser && !flags.some(flag => perms[flag]))) {
      return res.status(403).json({ success: false, message: "Yetersiz yetki." });
    }
    next();
  };
}

function requireModerationBot(req, res, next) {
  const botProcess = activeProcesses.moderation;
  if (!botProcess || botProcess.killed) {
    return res.status(503).json({ success: false, message: "Moderasyon botu aktif değil." });
  }
  req.botProcess = botProcess;
  next();
}

// Registers a pending bot request. onTimeout defaults to a 504 response.
function trackRequest(req, res, data, timeoutMs, onTimeout) {
  const requestId = newRequestId();
  pending.teams[requestId] = {
    res,
    req,
    data,
    timeout: setTimeout(async () => {
      const entry = pending.teams[requestId];
      delete pending.teams[requestId];
      if (!entry || res.headersSent) return;
      if (onTimeout) return onTimeout();
      res.status(504).json({ success: false, message: "İşlem zaman aşımına uğradı." });
    }, timeoutMs)
  };
  return requestId;
}

function parseMaxMembers(value, fallback = MAX_MEMBERS) {
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? fallback : parsed;
}

function validObjectId(id) {
  return !!id && id !== "null" && id !== "undefined" && mongoose.Types.ObjectId.isValid(id);
}

// Team or business (most bulk actions accept both) by route id.
async function findTeamOrBusiness(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return (await Team.findById(id)) || (await Business.findById(id));
}

function groupMembersQuery(group) {
  return { $or: [{ teamId: group._id }, { businessId: group._id }] };
}

async function discordSettings() {
  const stats = await ServerStats.findOne();
  const pick = key => (stats && stats[key]) || config.discord[key];
  return { stats, pick };
}

function sendExecutorDmAlert(data) {
  const botProcess = getConnectedBot("moderation", "verification", "logger", "management");
  if (botProcess) botProcess.send({ type: "SEND_EXECUTOR_DM_ALERT", ...data });
}

router.post("/admin/teams/add", allow("createTeams", "createDepartment", "manageTeams"), requireModerationBot, async (req, res) => {
  try {
    const { name, color, type } = req.body;
    const bossId = req.body.bossId && req.body.bossId.trim() ? req.body.bossId.trim() : "none";
    if (!name || !color || !type) {
      return res.status(400).json({ success: false, message: "Lütfen tüm alanları doldurun." });
    }
    const maxMembers = parseMaxMembers(req.body.maxMembers);
    if (maxMembers < 0 || maxMembers > MAX_MEMBERS) {
      return res.status(400).json({ success: false, message: "Ekip kişi sayısı minimum 0, maksimum 50 olabilir." });
    }

    const { pick } = await discordSettings();
    const requestId = trackRequest(req, res, {
      name, color, bossId, type, maxMembers,
      createdById: req.session.user.id,
      createdByUsername: req.session.user.username
    }, BOT_RESPONSE_TIMEOUT_MS);

    req.botProcess.send({
      type: "CREATE_DISCORD_TEAM",
      name,
      color,
      bossId,
      teamType: type,
      illegalCategoryId: pick("illegalCategoryId"),
      legalCategoryId: pick("legalCategoryId"),
      businessCategoryId: pick("businessCategoryId"),
      bossRoleId: pick("bossRoleId"),
      highCommandRoleId: pick("highCommandRoleId"),
      executorId: req.session.user.id,
      executorUsername: req.session.user.username,
      requestId
    });
  } catch (err) {
    console.error("Add team endpoint error:", err);
    res.status(500).json({ success: false, message: "Ekip oluşturulurken sunucu hatası oluştu." });
  }
});

router.post("/admin/teams/delete/:id", allow("deleteTeams"), async (req, res) => {
  try {
    const team = mongoose.Types.ObjectId.isValid(req.params.id) ? await Team.findById(req.params.id) : null;
    if (!team) {
      return res.status(404).json({ success: false, message: "Ekip bulunamadı." });
    }

    const botProcess = activeProcesses.moderation;
    if (!isConnected(botProcess)) {
      logAction("teamDelete", {
        executor: actorFrom(req),
        target: { id: team._id.toString(), username: team.name, data: team },
        details: `Ekip silindi: ${team.name}`,
        context: "Web Panel"
      });
      await Team.findByIdAndDelete(team._id);
      return res.json({ success: true, message: "Ekip başarıyla silindi!" });
    }

    const requestId = trackRequest(req, res, { id: req.params.id }, OPTIMISTIC_REPLY_MS, async () => {
      await Team.findByIdAndDelete(team._id);
      res.json({ success: true, message: "Ekip başarıyla silindi." });
    });
    botProcess.send({
      type: "DELETE_DISCORD_TEAM",
      roleId: team.roleId,
      channelId: team.channelId,
      teamName: team.name,
      executorId: req.session.user.id,
      executorUsername: req.session.user.username,
      requestId
    });
  } catch (err) {
    console.error("Delete team endpoint error:", err);
    res.status(500).json({ success: false, message: "Ekip silinirken sunucu hatası oluştu." });
  }
});

router.post("/admin/teams/edit/:id", allow("editTeams"), requireModerationBot, async (req, res) => {
  try {
    const { name, color, bossId } = req.body;
    if (!name || !color || !bossId) {
      return res.status(400).json({ success: false, message: "Lütfen tüm alanları doldurun." });
    }
    const team = mongoose.Types.ObjectId.isValid(req.params.id) ? await Team.findById(req.params.id) : null;
    if (!team) {
      return res.status(404).json({ success: false, message: "Ekip bulunamadı." });
    }
    const maxMembers = parseMaxMembers(req.body.maxMembers, team.maxMembers || MAX_MEMBERS);
    if (maxMembers < 0 || maxMembers > MAX_MEMBERS) {
      return res.status(400).json({ success: false, message: "Ekip kişi sayısı minimum 0, maksimum 50 olabilir." });
    }

    const { pick } = await discordSettings();
    const requestId = trackRequest(req, res, { id: req.params.id, name, color, bossId, maxMembers }, BOT_RESPONSE_TIMEOUT_MS);
    req.botProcess.send({
      type: "EDIT_DISCORD_TEAM",
      id: req.params.id,
      name,
      color,
      bossId,
      oldBossId: team.bossId,
      roleId: team.roleId,
      channelId: team.channelId,
      teamType: team.type,
      bossRoleId: pick("bossRoleId"),
      highCommandRoleId: pick("highCommandRoleId"),
      executorId: req.session.user.id,
      executorUsername: req.session.user.username,
      requestId
    });
  } catch (err) {
    console.error("Edit team endpoint error:", err);
    res.status(500).json({ success: false, message: "Ekip güncellenirken sunucu hatası oluştu." });
  }
});

router.post("/admin/teams/voice-support/toggle/:id", allow("editTeams"), requireModerationBot, async (req, res) => {
  try {
    const team = mongoose.Types.ObjectId.isValid(req.params.id) ? await Team.findById(req.params.id) : null;
    if (!team) {
      return res.status(404).json({ success: false, message: "Ekip bulunamadı." });
    }
    const { pick } = await discordSettings();
    const requestId = trackRequest(req, res, { id: req.params.id }, BOT_RESPONSE_TIMEOUT_MS);
    req.botProcess.send({
      type: "TOGGLE_TEAM_VOICE_SUPPORT",
      roleId: team.roleId,
      voiceSupportRoleId: pick("voiceSupportRoleId"),
      executorId: req.session.user.id,
      executorUsername: req.session.user.username,
      requestId
    });
  } catch (err) {
    console.error("Team voice support endpoint error:", err);
    res.status(500).json({ success: false, message: "Ekip sesli destek rolü değiştirilirken hata oluştu." });
  }
});

router.get("/admin/teams/stats", allow("viewTeams", "viewOverview"), async (req, res) => {
  try {
    const allTeams = await Team.find();
    const statsFor = async (type, bossKey) => {
      const teams = allTeams.filter(t => t.type === type);
      return {
        totalTeams: teams.length,
        totalMembers: await DiscordUser.countDocuments({ teamId: { $in: teams.map(t => t._id) } }),
        [bossKey]: teams.filter(t => t.bossId && t.bossId.trim()).length
      };
    };
    res.json({
      success: true,
      stats: {
        illegal: await statsFor("illegal", "totalOGs"),
        legal: await statsFor("legal", "totalHCs"),
        business: await statsFor("business", "totalBosses")
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "İstatistikler yüklenemedi." });
  }
});

router.get("/admin/teams/detail/:id", allow("viewTeams"), async (req, res) => {
  try {
    const team = mongoose.Types.ObjectId.isValid(req.params.id) ? await Team.findById(req.params.id) : null;
    if (!team) {
      return res.status(404).json({ success: false, message: "Ekip bulunamadı." });
    }
    const members = await DiscordUser.find({ teamId: team._id, username: { $ne: "Bilinmeyen Kullanıcı" } }).populate("rankId");
    res.json({ success: true, team, members: await describeGroupMembers(sortByRank(members)) });
  } catch (err) {
    console.error("Get team detail error:", err);
    res.status(500).json({ success: false, message: "Ekip detayları yüklenirken hata oluştu." });
  }
});

router.post("/admin/teams/notes/:id", allow("editTeams"), async (req, res) => {
  try {
    const team = mongoose.Types.ObjectId.isValid(req.params.id)
      ? await Team.findByIdAndUpdate(req.params.id, { notes: req.body.notes || "" }, { new: true })
      : null;
    if (!team) {
      return res.status(404).json({ success: false, message: "Ekip bulunamadı." });
    }
    res.json({ success: true, message: "Ekip notları başarıyla kaydedildi.", notes: team.notes });
  } catch (err) {
    res.status(500).json({ success: false, message: "Notlar kaydedilirken hata oluştu." });
  }
});

router.post("/admin/teams/members/add", allow("teamAddMember", "editTeams", "manageTeams"), async (req, res) => {
  try {
    const { teamId } = req.body;
    const discordId = String(req.body.discordId || "").trim();
    if (!teamId || !isSnowflake(discordId) || !mongoose.Types.ObjectId.isValid(teamId)) {
      return res.status(400).json({ success: false, message: "Geçersiz parametreler." });
    }
    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ success: false, message: "Ekip bulunamadı." });
    }

    const maxLimit = team.maxMembers !== undefined ? team.maxMembers : MAX_MEMBERS;
    if ((await DiscordUser.countDocuments({ teamId: team._id })) >= maxLimit) {
      return res.status(400).json({ success: false, message: `Bu ekip maksimum üye kapasitesine (${maxLimit} kişi) ulaştı. Daha fazla üye eklenemez.` });
    }

    const existingUser = await DiscordUser.findOne({ discordId });
    if (existingUser && existingUser.teamId && existingUser.teamId.toString() === team._id.toString()) {
      return res.status(400).json({ success: false, message: "Bu kullanıcı zaten bu ekipte." });
    }

    const memberCheck = await verifyDiscordGuildMember(discordId);
    if (!memberCheck.inGuild) {
      const errorMsg = memberCheck.error || "Bu kullanıcı ana Discord sunucumuzda bulunmamaktadır! Sunucuda olmayan kişiler ekibe eklenemez.";
      sendExecutorDmAlert({ executorId: req.session.user.id, title: "🚨 Ekip Üyesi Eklenemedi", teamName: team.name, failedIds: [discordId], reason: errorMsg });
      return res.status(400).json({ success: false, message: errorMsg });
    }

    const { username, avatarUrl } = memberCheck;
    if (existingUser) {
      existingUser.teamId = team._id;
      existingUser.isWhitelist = true;
      if (!existingUser.whitelistAt) existingUser.whitelistAt = new Date();
      if (username && (!existingUser.username || existingUser.username.startsWith("Kullanıcı (") || existingUser.username === "Bilinmeyen Kullanıcı")) {
        existingUser.username = username;
      }
      if (avatarUrl) existingUser.avatarUrl = avatarUrl;
      await existingUser.save();
    } else {
      await new DiscordUser({ discordId, username, avatarUrl, teamId: team._id, isWhitelist: true, whitelistAt: new Date() }).save();
    }

    logAction("teamAddMember", {
      executor: actorFrom(req),
      target: { id: discordId, username },
      details: `Kullanıcı ekibe eklendi. Ekip: ${team.name}`,
      context: "Web Panel"
    });

    const botProcess = activeProcesses.moderation;
    if (!isConnected(botProcess)) {
      return res.json({ success: true, message: "Kullanıcı başarıyla ekibe eklendi!" });
    }

    const { stats } = await discordSettings();
    const requestId = trackRequest(req, res, { id: teamId, teamName: team.name, discordId }, OPTIMISTIC_REPLY_MS, () => {
      res.json({ success: true, message: "Kullanıcı başarıyla ekibe eklendi!" });
    });
    botProcess.send({
      type: "ADD_USER_TO_TEAM",
      discordId,
      roleId: team.roleId,
      channelId: team.channelId,
      whitelistRoleId: stats ? stats.whitelistRoleId : null,
      unregisteredRoleId: stats ? stats.unregisteredRoleId : null,
      teamName: team.name,
      teamType: team.type,
      teamId: team._id.toString(),
      isBusiness: false,
      executorId: req.session.user.id,
      executorUsername: req.session.user.username,
      requestId
    });
  } catch (err) {
    console.error("Add team member error:", err);
    res.status(500).json({ success: false, message: "Kullanıcı ekibe eklenirken sunucu hatası oluştu." });
  }
});

router.post("/admin/teams/members/remove", allow("teamRemoveMember", "editTeams", "manageTeams"), async (req, res) => {
  try {
    const { teamId } = req.body;
    const targetIdentifier = req.body.discordId || req.body.userId;
    if (!teamId || !targetIdentifier || !mongoose.Types.ObjectId.isValid(teamId)) {
      return res.status(400).json({ success: false, message: "Geçersiz parametreler." });
    }
    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ success: false, message: "Ekip bulunamadı." });
    }

    let user = mongoose.Types.ObjectId.isValid(targetIdentifier) ? await DiscordUser.findById(targetIdentifier) : null;
    if (!user) user = await DiscordUser.findOne({ discordId: String(targetIdentifier).trim() });
    if (!user) {
      sendExecutorDmAlert({
        executorId: req.session.user.id,
        title: "🚨 Ekipten Üye Çıkarılamadı",
        teamName: team.name,
        failedIds: [targetIdentifier],
        reason: "Kullanıcı veritabanında veya sunucuda bulunamadı."
      });
      return res.status(404).json({ success: false, message: "Kullanıcı veritabanında veya ekipte bulunamadı." });
    }

    user.teamId = null;
    await user.save();

    logAction("teamRemoveMember", {
      executor: actorFrom(req),
      target: { id: user.discordId, username: user.username },
      details: `Kullanıcı ekipten çıkarıldı. Ekip: ${team.name}`,
      context: "Web Panel"
    });

    const botProcess = activeProcesses.moderation;
    if (!isConnected(botProcess)) {
      return res.json({ success: true, message: "Kullanıcı ekipten çıkarıldı." });
    }
    const requestId = trackRequest(req, res, {
      teamId, teamName: team.name, discordId: user.discordId, username: user.username, userObj: user
    }, OPTIMISTIC_REPLY_MS, () => res.json({ success: true, message: "Kullanıcı ekipten çıkarıldı." }));
    botProcess.send({
      type: "REMOVE_USER_FROM_TEAM",
      discordId: user.discordId,
      roleId: team.roleId,
      channelId: team.channelId,
      executorUsername: req.session.user.username,
      requestId
    });
  } catch (err) {
    console.error("Remove team member error:", err);
    res.status(500).json({ success: false, message: "Kullanıcı ekipten çıkarılırken sunucu hatası oluştu." });
  }
});

router.post("/admin/teams/ban/:id", allow("teamBlacklistAdd"), requireModerationBot, async (req, res) => {
  try {
    const team = mongoose.Types.ObjectId.isValid(req.params.id) ? await Team.findById(req.params.id) : null;
    if (!team) {
      return res.status(404).json({ success: false, message: "Ekip bulunamadı." });
    }
    const members = await DiscordUser.find({ teamId: team._id });
    const memberDiscordIds = members.map(m => m.discordId);
    await DiscordUser.updateMany(
      { _id: { $in: members.map(m => m._id) } },
      { isWhitelist: false, whitelistAt: null, teamId: null, isPermaBanned: true }
    );

    const { pick } = await discordSettings();
    await Team.findByIdAndDelete(team._id);

    const requestId = trackRequest(req, res, {
      teamId: team._id.toString(), teamName: team.name, membersCount: memberDiscordIds.length
    }, BOT_RESPONSE_TIMEOUT_MS);
    req.botProcess.send({
      type: "BAN_DISCORD_TEAM",
      roleId: team.roleId,
      channelId: team.channelId,
      whitelistRoleId: pick("whitelistRoleId"),
      wlPunishedRoleId: pick("wlPunishedRoleId"),
      unregisteredRoleId: pick("unregisteredRoleId"),
      memberDiscordIds,
      executorUsername: req.session.user.username,
      requestId
    });
  } catch (err) {
    console.error("Ban team error:", err);
    res.status(500).json({ success: false, message: "Ekip banlanırken sunucu hatası oluştu." });
  }
});

router.post("/admin/teams/wipe/:id", async (req, res, next) => {
  const perms = await getUserPermissions(req.session.user);
  if (!perms || (!perms.isSuperuser && !perms.teamWipe && !perms.isProjectLeader)) {
    return res.status(403).json({ success: false, message: "Wipe işlemi yapmak için yetkiniz bulunmuyor." });
  }
  next();
}, requireModerationBot, async (req, res) => {
  try {
    const team = await findTeamOrBusiness(req.params.id);
    if (!team) {
      return res.status(404).json({ success: false, message: "Ekip/İşletme bulunamadı." });
    }
    const members = await DiscordUser.find(groupMembersQuery(team));
    if (members.length === 0 && !team.roleId) {
      return res.status(400).json({ success: false, message: "Bu ekipte/işletmede wipe atılacak üye veya rol bulunmuyor." });
    }

    const memberDiscordIds = members.map(m => m.discordId);
    const membersSnapshot = members.map(m => ({
      discordId: m.discordId,
      username: m.username,
      isWhitelist: m.isWhitelist,
      whitelistAt: m.whitelistAt,
      addedAt: m.addedAt
    }));

    const cleared = { isWhitelist: false, whitelistAt: null, teamId: null, businessId: null };
    await DiscordUser.updateMany(groupMembersQuery(team), cleared);
    if (team.bossId && team.bossId.trim()) {
      await DiscordUser.updateMany({ discordId: team.bossId.trim() }, cleared);
    }

    const { pick } = await discordSettings();
    const requestId = trackRequest(req, res, {
      teamId: team._id, teamName: team.name, membersCount: memberDiscordIds.length, membersSnapshot
    }, WIPE_TIMEOUT_MS);
    req.botProcess.send({
      type: "WIPE_TEAM_MEMBERS",
      memberDiscordIds,
      unregisteredRoleId: pick("unregisteredRoleId"),
      wipePunishRoleId: pick("wipePunishRoleId"),
      teamName: team.name,
      roleId: team.roleId,
      channelId: team.channelId,
      executorUsername: req.session.user.username,
      requestId
    });
  } catch (err) {
    console.error("Wipe team error:", err);
    res.status(500).json({ success: false, message: "Ekip üyeleri wipe'lanırken sunucu hatası oluştu." });
  }
});

router.post("/admin/teams/unwipe/:id", allow("teamRemoveMember", "teamAddMember"), requireModerationBot, async (req, res) => {
  try {
    if (!validObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Geçersiz ekip ID'si." });
    }
    const team = await Team.findById(req.params.id);
    if (!team) {
      return res.status(404).json({ success: false, message: "Ekip bulunamadı." });
    }
    const lastWipe = await TeamWipe.findOne({ teamId: team._id }).sort({ wipedAt: -1 });
    if (!lastWipe || !lastWipe.members || lastWipe.members.length === 0) {
      return res.status(404).json({ success: false, message: "Bu ekip için geri alınabilecek aktif bir wipe kaydı bulunamadı." });
    }

    const membersToRestore = lastWipe.members.map(m => ({
      discordId: m.discordId,
      username: m.username || "",
      isWhitelist: m.isWhitelist,
      whitelistAt: m.whitelistAt,
      addedAt: m.addedAt,
      roles: Array.isArray(m.roles) ? [...m.roles] : []
    }));

    const { pick } = await discordSettings();
    const requestId = trackRequest(req, res, {
      teamId: team._id, teamName: team.name, lastWipeId: lastWipe._id, isUnwipe: true
    }, UNWIPE_TIMEOUT_MS);
    req.botProcess.send({
      type: "UNWIPE_TEAM_MEMBERS",
      membersToRestore,
      unregisteredRoleId: pick("unregisteredRoleId"),
      whitelistRoleId: pick("whitelistRoleId"),
      wipePunishRoleId: pick("wipePunishRoleId"),
      teamRoleId: team.roleId,
      channelId: team.channelId,
      executorUsername: req.session.user.username,
      requestId
    });
  } catch (err) {
    console.error("Unwipe team error:", err);
    res.status(500).json({ success: false, message: "Ekip wipe işlemi geri alınırken sunucu hatası oluştu." });
  }
});

// "CK" (character kill): permanently deletes every character of every current/former team member.
router.post("/admin/teams/ck/:id", allow("teamRemoveMember"), async (req, res) => {
  try {
    if (!validObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Geçersiz ekip ID'si." });
    }
    const team = await Team.findById(req.params.id);
    if (!team) {
      return res.status(404).json({ success: false, message: "Ekip bulunamadı." });
    }

    const members = await DiscordUser.find({ $or: [{ teamId: team._id }, { teamId: team._id.toString() }] });
    const targetDiscordIds = new Set(members.map(m => m.discordId));
    if (team.bossId && team.bossId.trim()) targetDiscordIds.add(team.bossId.trim());
    for (const wipe of await TeamWipe.find({ teamId: team._id })) {
      (wipe.members || []).forEach(m => m && m.discordId && targetDiscordIds.add(m.discordId));
    }
    if (targetDiscordIds.size === 0) {
      return res.status(400).json({ success: false, message: "Bu ekipte CK atılacak üye veya karakter bulunamadı." });
    }

    const executorName = req.session.user.username;
    let totalDeletedCount = 0;
    for (const discId of targetDiscordIds) {
      const query = { discordId: { $in: [String(discId), `discord:${discId}`] } };
      for (const c of await FivemCharacter.find(query)) {
        if (!c.citizenid) continue;
        await DeletedCharacter.updateOne(
          { citizenid: c.citizenid },
          {
            citizenid: c.citizenid,
            discordId: discId,
            charName: `${c.firstname || ""} ${c.lastname || ""}`.trim() || c.citizenid,
            deletedBy: `Ekip CK Wipe (${executorName})`,
            deletedAt: new Date()
          },
          { upsert: true }
        );
        queueCharacterDeletion(
          { citizenid: c.citizenid, identifier: c.citizenid, reason: "Ekip CK Wipe", admin: executorName, timestamp: Date.now() },
          { actions: ["delete_character", "deletecharacter", "delchar"], sqlActions: ["execute_sql"] }
        );
      }
      const result = await FivemCharacter.deleteMany(query);
      totalDeletedCount += result ? result.deletedCount || 0 : 0;
    }

    const botProcess = activeProcesses.moderation;
    if (botProcess && !botProcess.killed && team.channelId) {
      botProcess.send({
        type: "CK_TEAM_MEMBERS",
        teamId: team._id,
        teamName: team.name,
        channelId: team.channelId,
        deletedCharactersCount: totalDeletedCount,
        executorUsername: executorName
      });
    }

    logAction("teamMembersCK", {
      executor: actorFrom(req),
      target: { id: team._id, username: team.name },
      details: `Ekibe komple CK atıldı. Toplam ${totalDeletedCount} karakter veritabanından kalıcı olarak silindi.`,
      context: "Web Panel"
    });
    res.json({
      success: true,
      message: `Ekip CK işlemi tamamlandı! ${targetDiscordIds.size} üyenin toplam ${totalDeletedCount} karakteri veritabanından kalıcı olarak silindi.`
    });
  } catch (err) {
    console.error("CK team error:", err);
    res.status(500).json({ success: false, message: "Ekip CK atılırken veritabanı hatası oluştu." });
  }
});

// Bans or kicks every member of a team/business from Discord and records it in their punishment history.
function bulkDiscordAction({ permission, botMessageType, logActionType, recordAction, duration, reasonRequiredMessage, success, failure, describe, extra }) {
  return [allow(permission), async (req, res, next) => {
    if (!req.body.reason) {
      return res.status(400).json({ success: false, message: reasonRequiredMessage });
    }
    next();
  }, requireModerationBot, async (req, res) => {
    const { reason } = req.body;
    try {
      const team = await findTeamOrBusiness(req.params.id);
      if (!team) {
        return res.status(404).json({ success: false, message: "Ekip/İşletme bulunamadı." });
      }
      const members = await DiscordUser.find(groupMembersQuery(team));

      logAction(logActionType, {
        executor: actorFrom(req),
        target: { id: team._id.toString(), username: team.name, data: team },
        details: describe(reason, members.length),
        context: "Web Panel"
      });

      const actor = actorFrom(req);
      for (const m of members) {
        req.botProcess.send({ type: botMessageType, discordId: m.discordId, reason: recordAction.reasonPrefix(team.name, reason), executorUsername: actor.username });
        await new PunishmentRecord({
          discordId: m.discordId,
          username: m.username || "Bilinmeyen Kullanıcı",
          executorId: actor.id,
          executorUsername: actor.username,
          action: recordAction.name,
          reason,
          duration
        }).save();
      }
      if (extra) extra(members, reason);
      res.json({ success: true, message: success });
    } catch (err) {
      console.error(`${logActionType} error:`, err);
      res.status(500).json({ success: false, message: failure });
    }
  }];
}

router.post("/admin/teams/discord-ban/:id", ...bulkDiscordAction({
  permission: "teamDiscordBan",
  botMessageType: "BAN_DISCORD_USER",
  logActionType: "teamDiscordBan",
  recordAction: { name: "Discord Ban (Ekip)", reasonPrefix: (teamName, reason) => `Ekip/İşletme Banı (${teamName}) - ${reason}` },
  duration: "Kalıcı",
  reasonRequiredMessage: "Yasaklama nedeni girmek zorunludur.",
  success: "Tüm üyeler Discord'dan banlandı.",
  failure: "Banlanırken hata oluştu.",
  describe: (reason, count) => `Ekip/İşletme üyeleri Discord'dan toplu banlandı. Sebep: ${reason} (Toplam ${count} üye)`
}));

router.post("/admin/teams/discord-kick/:id", ...bulkDiscordAction({
  permission: "teamDiscordKick",
  botMessageType: "KICK_DISCORD_USER",
  logActionType: "teamDiscordKick",
  recordAction: { name: "Discord Kick (Ekip)", reasonPrefix: (teamName, reason) => `Ekip Kicki (${teamName}) - ${reason}` },
  duration: "Atıldı",
  reasonRequiredMessage: "Atılma nedeni girmek zorunludur.",
  success: "Tüm ekip üyeleri Discord ve FiveM sunucusundan atıldı.",
  failure: "Ekip üyeleri atılırken hata oluştu.",
  describe: (reason, count) => `Ekip üyeleri Discord'dan toplu atıldı (kick). Sebep: ${reason} (Toplam ${count} üye)`,
  // Also drop members who are currently in game.
  extra: (members, reason) => {
    const memberIds = new Set(members.map(m => m.discordId));
    for (const player of fivem.activePlayers) {
      if (player.identifiers && player.identifiers.some(id => memberIds.has(id.replace("discord:", "")))) {
        queueCommand("cmd_team_kick", { command: `drop ${player.id} Sunucudan Kicklendiniz: ${reason}` });
      }
    }
  }
}));

router.post("/admin/teams/send-dm/:id", allow("editTeams"), async (req, res) => {
  const message = String(req.body.message || "").trim();
  if (!message) {
    return res.status(400).json({ success: false, message: "Mesaj içeriği girilmelidir." });
  }
  try {
    const team = await findTeamOrBusiness(req.params.id);
    if (!team) return res.status(404).json({ success: false, message: "Ekip/İşletme bulunamadı." });
    const memberDiscordIds = (await DiscordUser.find(groupMembersQuery(team))).map(m => m.discordId);

    const botProcess = activeProcesses.moderation;
    if (botProcess && !botProcess.killed) {
      botProcess.send({ type: "SEND_TEAM_DM", memberDiscordIds, message, teamName: team.name, executorUsername: req.session.user.username });
    }
    res.json({ success: true, message: `Ekipteki/İşletmedeki ${memberDiscordIds.length} üyeye özel mesaj gönderildi.` });
  } catch (err) {
    res.status(500).json({ success: false, message: "Özel mesaj gönderilirken hata oluştu." });
  }
});

function teamWhitelistAction({ isWhitelist, botMessageType, success, failure }) {
  return async (req, res) => {
    try {
      const team = await findTeamOrBusiness(req.params.id);
      if (!team) return res.status(404).json({ success: false, message: "Ekip/İşletme bulunamadı." });

      const memberDiscordIds = (await DiscordUser.find(groupMembersQuery(team))).map(m => m.discordId);
      await DiscordUser.updateMany(groupMembersQuery(team), { isWhitelist, whitelistAt: isWhitelist ? new Date() : null });

      const { pick } = await discordSettings();
      const botProcess = activeProcesses.moderation;
      if (botProcess && !botProcess.killed) {
        botProcess.send({ type: botMessageType, memberDiscordIds, whitelistRoleId: pick("whitelistRoleId") });
      }
      res.json({ success: true, message: success });
    } catch (err) {
      res.status(500).json({ success: false, message: failure });
    }
  };
}

router.post("/admin/teams/whitelist/give/:id", allow("editTeams"), teamWhitelistAction({
  isWhitelist: true, botMessageType: "GIVE_TEAM_WHITELIST", success: "Tüm üyelere Whitelist başarıyla verildi.", failure: "Whitelist verilirken hata oluştu."
}));

router.post("/admin/teams/whitelist/take/:id", allow("editTeams"), teamWhitelistAction({
  isWhitelist: false, botMessageType: "TAKE_TEAM_WHITELIST", success: "Tüm üyelerin Whitelist yetkisi alındı.", failure: "Whitelist alınırken hata oluştu."
}));

router.post("/admin/teams/give-role/:id", allow("editTeams"), async (req, res) => {
  try {
    const team = await findTeamOrBusiness(req.params.id);
    if (!team) return res.status(404).json({ success: false, message: "Ekip/İşletme bulunamadı." });
    if (!team.roleId) return res.status(400).json({ success: false, message: "Bu ekibe/işletmeye tanımlı bir Discord rolü bulunmuyor." });

    const memberDiscordIds = (await DiscordUser.find(groupMembersQuery(team))).map(m => m.discordId);
    const botProcess = activeProcesses.moderation;
    if (botProcess && !botProcess.killed) {
      botProcess.send({ type: "GIVE_TEAM_ROLE", memberDiscordIds, teamRoleId: team.roleId });
    }
    res.json({ success: true, message: `Tüm üyelere rol (${team.name}) tanımlandı.` });
  } catch (err) {
    res.status(500).json({ success: false, message: "Rol verilirken hata oluştu." });
  }
});

router.post("/admin/teams/revive/:id", allow("editTeams"), async (req, res) => {
  try {
    const team = await findTeamOrBusiness(req.params.id);
    if (!team) return res.status(404).json({ success: false, message: "Ekip/İşletme bulunamadı." });

    const memberIds = new Set((await DiscordUser.find(groupMembersQuery(team))).map(m => m.discordId));
    let reviveCount = 0;
    for (const player of fivem.activePlayers) {
      if (player.identifiers && player.identifiers.some(id => memberIds.has(id.replace("discord:", "")))) {
        queueCommand("cmd_team_revive", { command: `revive ${player.id}` });
        reviveCount++;
      }
    }
    res.json({ success: true, message: `Oyunda aktif olan ${reviveCount} ekip üyesine Revive gönderildi.` });
  } catch (err) {
    res.status(500).json({ success: false, message: "Revive komutu gönderilirken hata oluştu." });
  }
});

module.exports = router;
