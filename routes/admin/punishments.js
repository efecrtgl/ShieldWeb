const express = require("express");
const config = require("../../config");
const { ServerStats, PunishmentRecord, DiscordUser, ActionLog } = require("../../models/ServerInfo");
const { getUserPermissions } = require("../../services/permissions");
const { activeProcesses, pending } = require("../../services/botRegistry");
const { newRequestId } = require("../../utils/http");

const router = express.Router();

const BOT_RESPONSE_TIMEOUT_MS = 15000;
const TIMELINE_ACTION_LIMIT = 100;
const WARNING_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const INITIATIVE_MARKER = "İnisiyatif";

function allow(...flags) {
  return async (req, res, next) => {
    const perms = await getUserPermissions(req.session.user);
    if (!perms || (!perms.isSuperuser && !flags.some(flag => perms[flag]))) {
      return res.status(403).json({ success: false, message: "Yetersiz yetki." });
    }
    req.perms = perms;
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

function configuredValue(value) {
  return value && value !== "none" ? value : null;
}

// Role ids the moderation bot needs to apply or clear punishments ("none" when not configured).
async function punishmentRoleIds() {
  const stats = await ServerStats.findOne();
  const roles = {
    whitelistRoleId: configuredValue(stats && stats.whitelistRoleId) || config.discord.whitelistRoleId,
    unregisteredRoleId: configuredValue(stats && stats.unregisteredRoleId) || config.discord.unregisteredRoleId,
    characterApprovalRoleId: (stats && stats.characterApprovalRoleId) || "none",
    wlPunishedRoleId: configuredValue(stats && stats.wlPunishedRoleId) || config.discord.wlPunishedRoleId
  };
  for (const level of WARNING_LEVELS) {
    roles[`warning${level}RoleId`] = (stats && stats[`warning${level}RoleId`]) || "none";
  }
  return { stats, roles };
}

function trackRequest(group, req, res, data, timeoutMessage) {
  const requestId = newRequestId();
  pending[group][requestId] = {
    res,
    req,
    data,
    timeout: setTimeout(() => {
      delete pending[group][requestId];
      res.status(504).json({ success: false, message: timeoutMessage });
    }, BOT_RESPONSE_TIMEOUT_MS)
  };
  return requestId;
}

router.post("/admin/users/punish", allow("applyPunishments"), requireModerationBot, async (req, res) => {
  try {
    const { discordIds, punishments, complainant } = req.body;
    if (!Array.isArray(discordIds) || !Array.isArray(punishments)) {
      return res.status(400).json({ success: false, message: "Geçersiz parametreler." });
    }
    const hasInitiative = punishments.some(p => p && typeof p.name === "string" && p.name.includes(INITIATIVE_MARKER));
    if (hasInitiative && !req.perms.isSuperuser && !req.perms.provideInitiative) {
      return res.status(403).json({ success: false, message: "İnisiyatif sağlama yetkiniz bulunmamaktadır." });
    }
    if (discordIds.length === 0) {
      return res.status(400).json({ success: false, message: "Lütfen en az bir Discord ID girin." });
    }
    if (punishments.length === 0) {
      return res.status(400).json({ success: false, message: "Lütfen en az bir ceza seçin." });
    }

    let warningsAdded = 0;
    let wlDaysAdded = 0;
    let isPerma = false;
    let isTT = false;
    const punishmentNames = [];
    for (const p of punishments) {
      punishmentNames.push(p.name);
      if (p.perma) isPerma = true;
      if (p.warnings) warningsAdded += parseInt(p.warnings, 10) || 0;
      if (p.wlDays) wlDaysAdded += parseInt(p.wlDays, 10) || 0;
      if (p.isTT) isTT = true;
    }

    const { stats, roles } = await punishmentRoleIds();
    const requestId = trackRequest("punish", req, res, {
      punishmentNames,
      warningsAdded,
      wlDaysAdded,
      isPerma,
      executorId: req.session.user.id,
      executorUsername: req.session.user.username
    }, "Cezalandırma işlemi zaman aşımına uğradı.");

    req.botProcess.send({
      type: "EXECUTE_BULK_PUNISHMENT",
      discordIds,
      punishments,
      complainant: complainant || "",
      warningsAdded,
      wlDaysAdded,
      isPerma,
      isTT,
      ...roles,
      punishmentLogChannelId: configuredValue(stats && stats.punishmentLogChannelId) || config.discord.punishmentLogChannelId,
      executorId: req.session.user.id,
      executorUsername: req.session.user.username,
      requestId
    });
  } catch (err) {
    console.error("Bulk punish endpoint error:", err);
    res.status(500).json({ success: false, message: "Cezalandırma uygulanırken sunucu hatası oluştu." });
  }
});

router.get("/admin/users/punish/history/:discordId", allow("viewPunishments"), async (req, res) => {
  try {
    const history = await PunishmentRecord.find({ discordId: req.params.discordId }).sort({ date: -1 });
    const user = await DiscordUser.findOne({ discordId: req.params.discordId }).populate("rankId");
    res.json({ success: true, history, user });
  } catch (err) {
    console.error("Punishment history error:", err);
    res.status(500).json({ success: false, message: "Ceza sicili alınırken hata oluştu." });
  }
});

// Combined, newest-first timeline of a user's punishments and audit-log entries.
router.get("/admin/users/history/:discordId", allow("viewUsers", "viewLogs"), async (req, res) => {
  try {
    const { discordId } = req.params;
    const userDoc = await DiscordUser.findOne({ discordId }).populate("rankId").populate("teamId").populate("businessId");
    const punishments = await PunishmentRecord.find({ discordId }).sort({ date: -1 });
    const logs = await ActionLog.find({ $or: [{ targetId: discordId }, { executorId: discordId }] }).sort({ timestamp: -1 }).limit(TIMELINE_ACTION_LIMIT);

    const timeline = [
      ...punishments.map(p => ({
        type: "punishment",
        title: `Ceza Uygulandı: ${p.punishments ? p.punishments.join(", ") : "Ceza"}`,
        details: `Uygulayan: ${p.executorUsername} (${p.executorId}) - Uyarı: +${p.warningsAdded}`,
        executor: p.executorUsername,
        date: p.date,
        badge: "danger"
      })),
      ...logs.map(l => ({
        type: "action",
        title: `Aksiyon: ${l.actionType}`,
        details: l.details || "Detay belirtilmedi.",
        executor: l.executorUsername,
        target: l.targetUsername,
        date: l.timestamp,
        context: l.context,
        badge: "info"
      }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({ success: true, user: userDoc, timeline, punishmentsCount: punishments.length, actionsCount: logs.length });
  } catch (err) {
    console.error("User Audit Timeline error:", err);
    res.status(500).json({ success: false, message: "Kullanıcı zaman tüneli alınırken hata oluştu." });
  }
});

router.post("/admin/users/punish/clear/:discordId", allow("clearPunishments"), requireModerationBot, async (req, res) => {
  try {
    const { discordId } = req.params;
    const { roles } = await punishmentRoleIds();
    const requestId = trackRequest("clearPunish", req, res, {
      discordId,
      executorId: req.session.user.id,
      executorUsername: req.session.user.username
    }, "Affetme işlemi zaman aşımına uğradı.");

    req.botProcess.send({
      type: "CLEAR_USER_PUNISHMENTS",
      discordId,
      ...roles,
      executorId: req.session.user.id,
      executorUsername: req.session.user.username,
      requestId
    });
  } catch (error) {
    console.error("Clear punishments error:", error);
    res.status(500).json({ success: false, message: "Sunucu hatası oluştu." });
  }
});

module.exports = router;
