const express = require("express");
const config = require("../../config");
const { DiscordUser, ServerStats, PunishmentRecord } = require("../../models/ServerInfo");
const { getUserPermissions } = require("../../services/permissions");
const { actorFrom, logAction } = require("../../services/auditLog");
const { activeProcesses, pending } = require("../../services/botRegistry");
const { fetchDiscordUserProfile } = require("../../services/discordApi");
const { wantsJson, newRequestId, isSnowflake } = require("../../utils/http");

// Discord bans, kicks and the blacklist (permanent ban list).
const router = express.Router();

const BANS_TIMEOUT_MS = 10000;

// Sends a moderation command to the moderation bot (falling back to the verification bot).
function moderationBot() {
  return activeProcesses.moderation || activeProcesses.verification;
}


router.post("/admin/users/discord-ban", async (req, res) => {
  const perms = await getUserPermissions(req.session.user);
  if (!perms || (!perms.isSuperuser && !perms.discordBan && !perms.banUser)) {
    if (wantsJson(req)) {
      return res.status(403).json({ success: false, message: "Discord ban yetkiniz bulunmamaktadır." });
    }
    return res.status(403).send("Forbidden");
  }
  try {
    const { discordId, reason } = req.body;
    if (!discordId || !reason) {
      if (wantsJson(req)) {
        return res.status(400).json({ success: false, message: "Discord ID ve yasaklama nedeni girmek zorunludur." });
      }
      return res.status(400).send("Discord ID ve yasaklama nedeni girmek zorunludur.");
    }

    const rawInput = String(discordId);
    const discordIds = (rawInput.match(/\d{17,20}/g) || []).filter((id, idx, self) => self.indexOf(id) === idx);

    if (discordIds.length === 0) {
      if (wantsJson(req)) {
        return res.status(400).json({ success: false, message: "Geçerli bir Discord Snowflake ID (17-20 haneli rakam) bulunamadı." });
      }
      return res.status(400).send("Geçerli bir Discord Snowflake ID (17-20 haneli rakam) bulunamadı.");
    }

    const botProcess = moderationBot();

    for (const targetId of discordIds) {
      const user = await DiscordUser.findOne({ discordId: targetId });

      logAction("discordBan", {
        executor: actorFrom(req),
        target: {
          id: targetId,
          username: user ? user.username : "Bilinmeyen Kullanıcı",
          data: user
        },
        details: `Kullanıcı Discord'dan yasaklandı. Sebep: ${reason}`,
        context: "Web Panel"
      });

      if (botProcess && !botProcess.killed) {
        botProcess.send({
          type: "BAN_DISCORD_USER",
          discordId: targetId,
          reason,
          executorUsername: req.session.user ? req.session.user.username : "System"
        });

        const punRecord = new PunishmentRecord({
          discordId: targetId,
          username: user ? user.username : "Bilinmeyen Kullanıcı",
          executorId: req.session.user ? req.session.user.id : "system",
          executorUsername: req.session.user ? req.session.user.username : "System",
          action: "Discord Ban",
          reason: reason,
          duration: "Kalıcı"
        });
        await punRecord.save();
      }
    }

    if (wantsJson(req)) {
      return res.json({ success: true, message: `${discordIds.length} kullanıcı Discord'dan başarıyla yasaklandı.` });
    }
    res.redirect("/admin/dashboard#banned-users");
  } catch (error) {
    console.error(error);
    if (wantsJson(req)) {
      return res.status(500).json({ success: false, message: "Sunucu hatası: " + error.message });
    }
    res.status(500).send("Internal Server Error");
  }
});

router.post("/admin/users/discord-unban/:discordId", async (req, res) => {
  const perms = await getUserPermissions(req.session.user);
  if (!perms || (!perms.isSuperuser && !perms.discordUnban && !perms.unbanUser)) {
    if (wantsJson(req)) {
      return res.status(403).json({ success: false, message: "Discord unban yetkiniz bulunmamaktadır." });
    }
    return res.status(403).send("Forbidden");
  }
  try {
    const { discordId } = req.params;
    const user = await DiscordUser.findOne({ discordId });

    logAction("discordUnban", {
      executor: actorFrom(req),
      target: {
        id: discordId,
        username: user ? user.username : "Bilinmeyen Kullanıcı",
        data: user
      },
      details: "Kullanıcının Discord yasağı kaldırıldı.",
      context: "Web Panel"
    });

    const botProcess = moderationBot();
    if (botProcess && !botProcess.killed) {
      botProcess.send({
        type: "UNBAN_DISCORD_USER",
        discordId,
        executorUsername: req.session.user ? req.session.user.username : "System"
      });
    }
    if (wantsJson(req)) {
      return res.json({ success: true, message: "Kullanıcının Discord yasağı başarıyla kaldırıldı." });
    }
    res.redirect("/admin/dashboard#banned-users");
  } catch (error) {
    console.error(error);
    if (wantsJson(req)) {
      return res.status(500).json({ success: false, message: "Sunucu hatası: " + error.message });
    }
    res.status(500).send("Internal Server Error");
  }
});

router.get("/admin/api/discord-bans", async (req, res) => {
  const perms = await getUserPermissions(req.session.user);
  if (!perms || (!perms.isSuperuser && !perms.banUser && !perms.discordBan && !perms.viewUsers)) {
    return res.status(403).json({ success: false, message: "Yetersiz yetki.", bans: [] });
  }
  const botProcess = moderationBot();
  if (!botProcess || botProcess.killed) {
    return res.status(503).json({ success: false, message: "Moderasyon botu aktif değil.", bans: [] });
  }

  const requestId = newRequestId();
  const timeout = setTimeout(() => {
    delete pending.bans[requestId];
    res.status(504).json({ success: false, message: "Discord ban listesi zaman aşımına uğradı.", bans: [] });
  }, BANS_TIMEOUT_MS);

  pending.bans[requestId] = { res, timeout };

  botProcess.send({
    type: "GET_DISCORD_BANS",
    requestId
  });
});

router.post("/admin/users/discord-kick", async (req, res) => {
  const perms = await getUserPermissions(req.session.user);
  if (!perms || (!perms.isSuperuser && !perms.discordKick)) {
    if (wantsJson(req)) {
      return res.status(403).json({ success: false, message: "Discord kick yetkiniz bulunmamaktadır." });
    }
    return res.status(403).send("Forbidden");
  }
  try {
    const { discordId, reason } = req.body;
    if (!discordId || !reason) {
      if (wantsJson(req)) {
        return res.status(400).json({ success: false, message: "Discord ID ve atılma nedeni girmek zorunludur." });
      }
      return res.status(400).send("Discord ID ve atılma nedeni girmek zorunludur.");
    }
    if (!isSnowflake(discordId)) {
      if (wantsJson(req)) {
        return res.status(400).json({ success: false, message: "Geçerli bir Discord ID giriniz." });
      }
      return res.status(400).send("Geçerli bir Discord ID giriniz.");
    }
    const user = await DiscordUser.findOne({ discordId });

    logAction("discordKick", {
      executor: actorFrom(req),
      target: {
        id: discordId,
        username: user ? user.username : "Bilinmeyen Kullanıcı",
        data: user
      },
      details: `Kullanıcı Discord'dan atıldı. Sebep: ${reason}`,
      context: "Web Panel"
    });

    const botProcess = moderationBot();
    if (botProcess && !botProcess.killed) {
      botProcess.send({
        type: "KICK_DISCORD_USER",
        discordId,
        reason,
        executorUsername: req.session.user ? req.session.user.username : "System"
      });

      const punRecord = new PunishmentRecord({
        discordId,
        username: user ? user.username : "Bilinmeyen Kullanıcı",
        executorId: req.session.user ? req.session.user.id : "system",
        executorUsername: req.session.user ? req.session.user.username : "System",
        action: "Discord Kick",
        reason: reason,
        duration: "Atıldı"
      });
      await punRecord.save();
    }
    if (wantsJson(req)) {
      return res.json({ success: true, message: "Kullanıcı Discord sunucusundan başarıyla atıldı." });
    }
    res.redirect("/admin/dashboard#users-mgmt");
  } catch (error) {
    console.error(error);
    if (wantsJson(req)) {
      return res.status(500).json({ success: false, message: "Sunucu hatası: " + error.message });
    }
    res.status(500).send("Internal Server Error");
  }
});

router.post("/admin/users/blacklist/add", async (req, res) => {
  const perms = await getUserPermissions(req.session.user);
  if (!perms || (!perms.isSuperuser && !perms.blacklistAdd && !perms.blacklistUserAdd)) {
    return res.status(403).send("Forbidden");
  }
  try {
    const discordId = String(req.body.discordId || "").trim();
    if (!discordId) {
      return res.status(400).send("Discord ID girmek zorunludur.");
    }
    if (!isSnowflake(discordId)) {
      return res.status(400).send("Geçerli bir Discord ID giriniz.");
    }

    let user = await DiscordUser.findOne({ discordId });
    if (user) {
      user.isPermaBanned = true;
      user.isWhitelist = false;
      await user.save();
    } else {
      const profile = await fetchDiscordUserProfile(discordId);
      user = new DiscordUser({
        discordId,
        username: profile ? profile.username : "Bilinmeyen Kullanıcı",
        avatarUrl: profile ? profile.avatarUrl : "",
        isPermaBanned: true,
        isWhitelist: false
      });
      await user.save();
    }

    logAction("blacklistAdd", {
      executor: actorFrom(req),
      target: {
        id: discordId,
        username: user.username,
        data: user
      },
      details: "Kullanıcı kara listeye (blacklist) eklendi.",
      context: "Web Panel"
    });

    const botProcess = activeProcesses.moderation;
    if (botProcess && !botProcess.killed) {
      const stats = await ServerStats.findOne();
      botProcess.send({
        type: "EXECUTE_BULK_PUNISHMENT",
        discordIds: [discordId],
        punishments: [{ name: "Kara Liste (Blacklist)", perma: true }],
        warningsAdded: 0,
        wlDaysAdded: 0,
        isPerma: true,
        isTT: false,
        whitelistRoleId: stats?.whitelistRoleId || config.discord.whitelistRoleId,
        unregisteredRoleId: stats?.unregisteredRoleId || config.discord.unregisteredRoleId,
        characterApprovalRoleId: stats?.characterApprovalRoleId || "none",
        wlPunishedRoleId: stats?.wlPunishedRoleId || "none",
        executorId: req.session.user ? req.session.user.id : "system",
        executorUsername: req.session.user ? req.session.user.username : "System"
      });
    }

    res.redirect("/admin/dashboard#blacklist-users");
  } catch (error) {
    console.error(error);
    res.status(500).send("Internal Server Error");
  }
});

router.post("/admin/users/blacklist/remove/:discordId", async (req, res) => {
  const perms = await getUserPermissions(req.session.user);
  if (!perms || (!perms.isSuperuser && !perms.blacklistRemove && !perms.blacklistUserRemove)) {
    return res.status(403).send("Forbidden");
  }
  try {
    const { discordId } = req.params;
    const user = await DiscordUser.findOne({ discordId });
    if (user) {
      user.isPermaBanned = false;
      user.wlCezaBitis = null;
      await user.save();
    }

    logAction("blacklistRemove", {
      executor: actorFrom(req),
      target: {
        id: discordId,
        username: user ? user.username : "Bilinmeyen Kullanıcı",
        data: user
      },
      details: "Kullanıcı kara listeden (blacklist) çıkarıldı.",
      context: "Web Panel"
    });

    const botProcess = activeProcesses.moderation;
    if (botProcess && !botProcess.killed) {
      const stats = await ServerStats.findOne();
      botProcess.send({
        type: "CLEAR_USER_PUNISHMENTS",
        discordId,
        whitelistRoleId: stats?.whitelistRoleId || config.discord.whitelistRoleId,
        unregisteredRoleId: stats?.unregisteredRoleId || config.discord.unregisteredRoleId,
        characterApprovalRoleId: stats?.characterApprovalRoleId || "none",
        wlPunishedRoleId: stats?.wlPunishedRoleId || "none",
        warning1RoleId: stats?.warning1RoleId || "none",
        warning2RoleId: stats?.warning2RoleId || "none",
        warning3RoleId: stats?.warning3RoleId || "none",
        executorId: req.session.user ? req.session.user.id : "system",
        executorUsername: req.session.user ? req.session.user.username : "System"
      });
    }
    res.redirect("/admin/dashboard#blacklist-users");
  } catch (error) {
    console.error(error);
    res.status(500).send("Internal Server Error");
  }
});

module.exports = router;
