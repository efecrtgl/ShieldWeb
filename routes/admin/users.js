const express = require("express");
const config = require("../../config");
const { DiscordUser, UserRank, ServerStats } = require("../../models/ServerInfo");
const { getUserPermissions } = require("../../services/permissions");
const { actorFrom, logAction } = require("../../services/auditLog");
const { activeProcesses, pending, getConnectedBot } = require("../../services/botRegistry");
const { fetchDiscordLiveStats, invalidateDiscordStats } = require("../../services/discordStats");
const { verifyDiscordGuildMember, fetchDiscordUserProfile } = require("../../services/discordApi");
const { findOnlinePlayer } = require("../../services/fivemState");
const { defaultAvatarUrl } = require("../../utils/discordAvatar");
const { wantsJson, searchRegex, newRequestId, isSnowflake } = require("../../utils/http");

const router = express.Router();

const MAX_PAGE_SIZE = 100;
const VOICE_SUPPORT_TIMEOUT_MS = 5000;
const SYNC_WHITELIST_TIMEOUT_MS = 15000;

// Tells the verification bot to add/remove the Discord whitelist role.
function syncWhitelistToDiscord(req, discordId, isWhitelist) {
  const actor = actorFrom(req);
  if (activeProcesses.verification) {
    activeProcesses.verification.send({ type: "SYNC_WHITELIST", discordId, isWhitelist, executorId: actor.id, executorUsername: actor.username });
  }
}

// Recounts whitelisted users, stores the total and drops the cached Discord stats.
async function refreshWhitelistTotal() {
  const count = await DiscordUser.countDocuments({ isWhitelist: true });
  await ServerStats.updateOne({}, { $set: { totalWhitelist: count } }, { upsert: true });
  invalidateDiscordStats();
  return count;
}

router.get("/admin/api/users", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  const perms = await getUserPermissions(req.session.user);
  if (!perms || (!perms.isSuperuser && !perms.viewUsers)) {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const search = String(req.query.search || "").trim();
    const skip = (page - 1) * limit;

    let query = {};
    if (search) {
      query = {
        $or: [
          { username: searchRegex(search) },
          { discordId: searchRegex(search) }
        ]
      };
    }

    const total = await DiscordUser.countDocuments(query);
    const discordLiveStats = await fetchDiscordLiveStats();

    const users = await DiscordUser.find(query)
      .populate("rankId")
      .sort({ addedAt: -1 })
      .skip(skip)
      .limit(limit);

    const mappedUsers = users.map(user => {
      const dObj = user.toObject();
      const onlinePlayer = findOnlinePlayer({ discordId: dObj.discordId });
      dObj.activeFivemId = onlinePlayer ? onlinePlayer.id : null;
      return dObj;
    });

    res.json({
      success: true,
      users: mappedUsers,
      total,
      stats: discordLiveStats,
      page,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error("API users error:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

router.post("/admin/users/assign", async (req, res) => {
  const perms = await getUserPermissions(req.session.user);
  if (!perms || (!perms.isSuperuser && !perms.editRanks && !perms.editUsers && !perms.createRanks)) {
    if (wantsJson(req)) {
      return res.status(403).json({ success: false, message: "Yetersiz yetki." });
    }
    return res.status(403).send("Forbidden");
  }
  try {
    const { userId, rankId } = req.body;
    if (!userId) {
      if (wantsJson(req)) {
        return res.status(400).json({ success: false, message: "Kullanıcı ID bulunamadı." });
      }
      return res.redirect("/admin/dashboard#ranks");
    }

    const userDoc = await DiscordUser.findById(userId);
    if (!userDoc) {
      if (wantsJson(req)) {
        return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı." });
      }
      return res.redirect("/admin/dashboard#ranks");
    }

    userDoc.rankId = (rankId && rankId.trim()) ? rankId.trim() : null;
    await userDoc.save();

    await UserRank.findOneAndUpdate(
      { discordId: userDoc.discordId },
      { username: userDoc.username, rankId: userDoc.rankId },
      { upsert: true, new: true }
    );

    const updatedUser = await DiscordUser.findById(userDoc._id).populate("rankId");

    if (wantsJson(req)) {
      return res.json({
        success: true,
        message: "Kullanıcı rütbesi başarıyla atandı!",
        user: updatedUser
      });
    }

    res.redirect("/admin/dashboard#ranks");
  } catch (error) {
    console.error("Assign user rank error:", error);
    if (wantsJson(req)) {
      return res.status(500).json({ success: false, message: "Sunucu hatası oluştu." });
    }
    res.status(500).send("Internal Server Error");
  }
});

router.post("/admin/users/update-description/:id", async (req, res) => {
  const perms = await getUserPermissions(req.session.user);
  if (!perms || (!perms.isSuperuser && !perms.editUsers)) {
    return res.status(403).send("Forbidden");
  }
  try {
    const { description } = req.body;
    await DiscordUser.findByIdAndUpdate(req.params.id, {
      description: description ? description.trim() : ""
    });
    res.redirect("/admin/dashboard#users");
  } catch (error) {
    console.error("Update user description error:", error);
    res.status(500).send("Internal Server Error");
  }
});

router.post("/admin/users/add", async (req, res) => {
  const perms = await getUserPermissions(req.session.user);
  if (!perms || (!perms.isSuperuser && !perms.editUsers)) {
    return res.status(403).send("Forbidden");
  }
  try {
    const { rankId, isWhitelist } = req.body;
    const discordId = String(req.body.discordId || "").trim();
    if (!isSnowflake(discordId)) {
      return res.status(400).send("Geçerli bir Discord ID giriniz.");
    }
    const whitelistChecked = isWhitelist === "true" || isWhitelist === "on";

    const profile = await fetchDiscordUserProfile(discordId);
    const discordUsername = profile ? profile.username : "Bilinmeyen Kullanıcı";
    const avatarUrl = profile ? (profile.avatarUrl || defaultAvatarUrl(discordId)) : "";

    let user = await DiscordUser.findOne({ discordId });
    if (user) {
      user.username = discordUsername;
      if (avatarUrl) user.avatarUrl = avatarUrl;
      user.rankId = rankId || null;
      user.isWhitelist = whitelistChecked;
      if (whitelistChecked && !user.whitelistAt) {
        user.whitelistAt = new Date();
      } else if (!whitelistChecked) {
        user.whitelistAt = null;
      }
      await user.save();
    } else {
      user = new DiscordUser({
        discordId,
        username: discordUsername,
        avatarUrl,
        rankId: rankId || null,
        isWhitelist: whitelistChecked,
        whitelistAt: whitelistChecked ? new Date() : null
      });
      await user.save();
    }

    await UserRank.findOneAndUpdate(
      { discordId },
      { username: discordUsername, rankId: user.rankId },
      { upsert: true, new: true }
    );

    if (whitelistChecked) {
      syncWhitelistToDiscord(req, discordId, true);
    }

    res.redirect("/admin/dashboard#users-mgmt");
  } catch (error) {
    console.error("Add user error:", error);
    res.status(500).send("Internal Server Error");
  }
});

router.post("/admin/users/whitelist/add/:id", async (req, res) => {
  const perms = await getUserPermissions(req.session.user);
  if (!perms || (!perms.isSuperuser && !perms.wlGive && !perms.isProjectLeader && !perms.editUsers && !perms.rankName)) {
    if (wantsJson(req)) {
      return res.status(403).json({ success: false, message: "Whitelist vermek için yetkiniz bulunmamaktadır." });
    }
    return res.status(403).send("Forbidden");
  }
  try {
    const dbUser = await DiscordUser.findById(req.params.id);
    if (!dbUser) {
      if (wantsJson(req)) {
        return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı." });
      }
      return res.status(404).send("Kullanıcı bulunamadı");
    }
    const memberCheck = await verifyDiscordGuildMember(dbUser.discordId);
    if (!memberCheck.inGuild) {
      if (wantsJson(req)) {
        return res.status(400).json({ success: false, message: memberCheck.error || "Bu kullanıcı ana Discord sunucumuzda bulunmamaktadır! Whitelist verilemez." });
      }
      return res.status(400).send(memberCheck.error || "Bu kullanıcı ana Discord sunucumuzda bulunmamaktadır! Whitelist verilemez.");
    }
    const user = await DiscordUser.findByIdAndUpdate(req.params.id, { isWhitelist: true, whitelistAt: new Date() }, { new: true });
    let currentWlCount = 0;
    if (user) {
      currentWlCount = await refreshWhitelistTotal();

      logAction("wlGive", {
        executor: actorFrom(req),
        target: {
          id: user.discordId,
          username: user.username,
          data: user
        },
        details: "Kullanıcıya whitelist verildi.",
        context: "Web Panel"
      });
      syncWhitelistToDiscord(req, user.discordId, true);
    }
    if (wantsJson(req)) {
      return res.json({ success: true, message: "Kullanıcıya whitelist başarıyla verildi.", whitelistCount: currentWlCount });
    }
    res.redirect("/admin/dashboard#users-mgmt");
  } catch (error) {
    console.error("Whitelist add error:", error);
    if (wantsJson(req)) {
      return res.status(500).json({ success: false, message: "Whitelist verilirken sunucu hatası oluştu." });
    }
    res.status(500).send("Internal Server Error");
  }
});

router.post("/admin/users/whitelist/remove/:id", async (req, res) => {
  const perms = await getUserPermissions(req.session.user);
  if (!perms || (!perms.isSuperuser && !perms.wlTake && !perms.isProjectLeader && !perms.editUsers && !perms.rankName)) {
    if (wantsJson(req)) {
      return res.status(403).json({ success: false, message: "Whitelist kaldırmak için yetkiniz bulunmamaktadır." });
    }
    return res.status(403).send("Forbidden");
  }
  try {
    const user = await DiscordUser.findByIdAndUpdate(req.params.id, { isWhitelist: false, whitelistAt: null }, { new: true });
    let currentWlCount = 0;
    if (user) {
      currentWlCount = await refreshWhitelistTotal();

      logAction("wlTake", {
        executor: actorFrom(req),
        target: {
          id: user.discordId,
          username: user.username,
          data: user
        },
        details: "Kullanıcının whitelist yetkisi kaldırıldı.",
        context: "Web Panel"
      });
      syncWhitelistToDiscord(req, user.discordId, false);
    }
    if (wantsJson(req)) {
      return res.json({ success: true, message: "Kullanıcının whitelist yetkisi kaldırıldı.", whitelistCount: currentWlCount });
    }
    res.redirect("/admin/dashboard#users-mgmt");
  } catch (error) {
    console.error("Whitelist remove error:", error);
    if (wantsJson(req)) {
      return res.status(500).json({ success: false, message: "Whitelist kaldırılırken sunucu hatası oluştu." });
    }
    res.status(500).send("Internal Server Error");
  }
});

router.post("/admin/users/whitelist/action-by-id", async (req, res) => {
  const perms = await getUserPermissions(req.session.user);
  if (!perms || (!perms.isSuperuser && !perms.wlGive && !perms.wlTake && !perms.rankName && !perms.isProjectLeader)) {
    return res.status(403).json({ success: false, message: "Bu işlemi yapmak için yetkiniz bulunmuyor." });
  }
  try {
    const { discordId, action } = req.body;
    if (!discordId || !/^\d{17,20}$/.test(discordId)) {
      return res.status(400).json({ success: false, message: "Geçerli bir Discord ID girmelisiniz." });
    }

    const isAdd = action === "add";

    // Verify that user is in our main Discord server
    const memberCheck = await verifyDiscordGuildMember(discordId);
    if (!memberCheck.inGuild) {
      return res.status(400).json({ success: false, message: memberCheck.error || "Bu kullanıcı ana Discord sunucumuzda bulunmamaktadır! Sunucuda olmayan kişilere whitelist verilemez." });
    }

    let user = await DiscordUser.findOne({ discordId });

    const discordUsername = memberCheck.username;
    const avatarUrl = memberCheck.avatarUrl;

    if (user) {
      user.isWhitelist = isAdd;
      user.whitelistAt = isAdd ? new Date() : null;
      if (!user.username || user.username.startsWith("Kullanıcı (") || user.username === discordId) {
        user.username = discordUsername;
      }
      if (!user.avatarUrl || user.avatarUrl.includes("embed/avatars")) {
        user.avatarUrl = avatarUrl;
      }
      await user.save();
    } else {
      user = new DiscordUser({
        discordId,
        username: discordUsername,
        avatarUrl: avatarUrl,
        isWhitelist: isAdd,
        whitelistAt: isAdd ? new Date() : null
      });
      await user.save();
    }

    const currentWlCount = await refreshWhitelistTotal();

    logAction(isAdd ? "wlGive" : "wlTake", {
      executor: actorFrom(req),
      target: {
        id: discordId,
        username: user.username,
        data: user
      },
      details: isAdd ? "Hızlı Whitelist Verildi." : "Hızlı Whitelist Kaldırıldı.",
      context: "Web Panel Hızlı İşlem"
    });

    syncWhitelistToDiscord(req, user.discordId, isAdd);

    return res.json({
      success: true,
      message: isAdd
        ? `${user.username || discordId} kullanıcısına Whitelist başarıyla verildi.`
        : `${user.username || discordId} kullanıcısının Whitelist yetkisi başarıyla kaldırıldı.`,
      whitelistCount: currentWlCount
    });
  } catch (error) {
    console.error("Action by ID error:", error);
    return res.status(500).json({ success: false, message: "Sunucu hatası oluştu." });
  }
});

router.post("/admin/users/delete/:id", async (req, res) => {
  const perms = await getUserPermissions(req.session.user);
  if (!perms || (!perms.isSuperuser && !perms.dbDeleteUser)) {
    if (wantsJson(req)) {
      return res.status(403).json({ success: false, message: "Kullanıcı silme yetkiniz bulunmamaktadır." });
    }
    return res.status(403).send("Forbidden");
  }
  try {
    const user = await DiscordUser.findById(req.params.id);
    if (user) {
      logAction("dbDeleteUser", {
        executor: actorFrom(req),
        target: {
          id: user.discordId,
          username: user.username,
          data: user
        },
        details: "Kullanıcı veritabanından tamamen silindi ve kaydı sıfırlandı.",
        context: "Web Panel"
      });
      const botProcess = activeProcesses.verification || activeProcesses.moderation;
      if (botProcess && !botProcess.killed) {
        botProcess.send({
          type: "UNREGISTER_USER",
          discordId: user.discordId,
          executorId: req.session.user ? req.session.user.id : "system",
          executorUsername: req.session.user ? req.session.user.username : "System"
        });
      }
      await DiscordUser.findByIdAndDelete(req.params.id);
      await UserRank.findOneAndDelete({ discordId: user.discordId });
    }
    if (wantsJson(req)) {
      return res.json({ success: true, message: "Kullanıcı veritabanından tamamen silindi ve Discord kaydı sıfırlandı." });
    }
    res.redirect("/admin/dashboard#users-mgmt");
  } catch (error) {
    console.error("Delete user error:", error);
    if (wantsJson(req)) {
      return res.status(500).json({ success: false, message: "Kullanıcı silinirken hata oluştu: " + error.message });
    }
    res.status(500).send("Internal Server Error");
  }
});

router.post("/admin/users/tum-rolleri-kaldir/:discordId", async (req, res) => {
  const perms = await getUserPermissions(req.session.user);
  if (!perms || (!perms.isSuperuser && !perms.removeAllRoles)) {
    if (wantsJson(req)) {
      return res.status(403).json({ success: false, message: "Tüm rolleri kaldırma yetkiniz bulunmamaktadır." });
    }
    return res.status(403).send("Forbidden");
  }
  try {
    const { discordId } = req.params;
    if (!isSnowflake(discordId)) {
      if (wantsJson(req)) return res.status(400).json({ success: false, message: "Geçerli bir Discord ID giriniz." });
      return res.status(400).send("Geçerli bir Discord ID giriniz.");
    }

    const user = await DiscordUser.findOneAndUpdate(
      { discordId },
      { isWhitelist: false, rankId: null },
      { upsert: true, new: true }
    );

    logAction("removeAllRoles", {
      executor: actorFrom(req),
      target: {
        id: discordId,
        username: user ? user.username : "Bilinmeyen Kullanıcı",
        data: user
      },
      details: "Kullanıcının tüm Discord rolleri kaldırıldı ve kaydı sıfırlandı.",
      context: "Web Panel"
    });

    const botProcess = activeProcesses.verification || activeProcesses.moderation;
    if (botProcess && !botProcess.killed) {
      botProcess.send({
        type: "UNREGISTER_USER",
        discordId,
        executorId: req.session.user ? req.session.user.id : "system",
        executorUsername: req.session.user ? req.session.user.username : "System"
      });
    }
    if (wantsJson(req)) {
      return res.json({ success: true, message: "Kullanıcının tüm Discord rolleri kaldırıldı ve kaydı sıfırlandı." });
    }
    res.redirect("/admin/dashboard#users-mgmt");
  } catch (error) {
    console.error(error);
    if (wantsJson(req)) {
      return res.status(500).json({ success: false, message: "Hata oluştu: " + error.message });
    }
    res.status(500).send("Internal Server Error");
  }
});

router.post("/admin/users/sensitive-toggle", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  try {
    const { enabled } = req.body;

    logAction("sensitiveToggle", {
      executor: actorFrom(req),
      details: `Hassas veri gizleme (blur) ayarı ${enabled ? "AÇILDI" : "KAPATILDI"}.`,
      context: "Web Panel"
    });

    return res.json({ success: true });
  } catch (error) {
    console.error("Sensitive toggle error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

router.post("/admin/users/voice-support/toggle/:discordId", async (req, res) => {
  const perms = await getUserPermissions(req.session.user);
  if (!perms || (!perms.isSuperuser && !perms.voiceSupportToggle)) {
    if (wantsJson(req)) {
      return res.status(403).json({ success: false, message: "Yetersiz yetki." });
    }
    return res.status(403).send("Forbidden");
  }

  const botProcess = activeProcesses.verification;
  if (!botProcess || botProcess.killed) {
    if (wantsJson(req)) {
      return res.status(503).json({ success: false, message: "Doğrulama botu aktif değil." });
    }
    return res.redirect("/admin/dashboard#users-mgmt");
  }

  const { discordId } = req.params;
  const requestId = newRequestId();

  const timeout = setTimeout(() => {
    delete pending.voiceSupport[requestId];
    if (wantsJson(req)) {
      res.status(504).json({ success: false, message: "İşlem zaman aşımına uğradı." });
    } else {
      res.redirect("/admin/dashboard#users-mgmt");
    }
  }, VOICE_SUPPORT_TIMEOUT_MS);

  pending.voiceSupport[requestId] = {
    res,
    timeout,
    req
  };

  botProcess.send({
    type: "TOGGLE_VOICE_SUPPORT",
    discordId,
    executorId: req.session.user.id,
    executorUsername: req.session.user.username,
    requestId
  });
});

router.post("/admin/users/sync-whitelist", async (req, res) => {
  const perms = await getUserPermissions(req.session.user);
  if (!perms) {
    return res.status(403).json({ success: false, message: "Yetersiz yetki." });
  }
  if (!perms.isSuperuser && !perms.isProjectLeader && !perms.syncUsers && !perms.rankName && !perms.viewUsers) {
    return res.status(403).json({ success: false, message: "Yetersiz yetki." });
  }
  const botProcess = getConnectedBot("moderation");

  if (!botProcess) {
    return res.status(503).json({ success: false, message: "Discord moderasyon bot süreci aktif değil. Whitelist eşitleme bu bot üzerinden yapılmaktadır." });
  }
  try {
    const stats = await ServerStats.findOne();
    const whitelistRoleId = stats?.whitelistRoleId || config.discord.whitelistRoleId;

    const requestId = newRequestId();
    const timeout = setTimeout(() => {
      delete pending.syncWhitelist[requestId];
      res.status(504).json({ success: false, message: "İşlem zaman aşımına uğradı." });
    }, SYNC_WHITELIST_TIMEOUT_MS);

    pending.syncWhitelist[requestId] = {
      res,
      timeout,
      req
    };

    botProcess.send({
      type: "SYNC_ALL_WHITELISTS",
      whitelistRoleId,
      executorId: req.session.user.id,
      executorUsername: req.session.user.username,
      requestId
    });
  } catch (err) {
    console.error("Sync whitelist endpoint error:", err);
    return res.status(500).json({ success: false, message: "Whitelist eşitlenirken sunucu hatası oluştu." });
  }
});

module.exports = router;
