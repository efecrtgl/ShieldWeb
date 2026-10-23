const express = require("express");
const config = require("../../config");
const { DiscordBot, ServerStats } = require("../../models/ServerInfo");
const { getUserPermissions } = require("../../services/permissions");
const { actorFrom, logAction } = require("../../services/auditLog");
const { activeProcesses, isConnected } = require("../../services/botRegistry");
const { spawnProcess, stopProcess, botConfigMessage } = require("../../services/botSupervisor");
const { wantsJson } = require("../../utils/http");

const router = express.Router();

const DEFAULT_BOT_ORDER = ["verification", "logger", "moderation", "sync", "management"];
const BOT_START_WAIT_MS = 1000;
const PROFILE_SUFFIXES = {
  verification: "Doğrulama",
  logger: "Loglama",
  moderation: "Moderasyon",
  sync: "Senkronizasyon",
  management: "Yönetim"
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

router.use("/admin/bots", async (req, res, next) => {
  const perms = await getUserPermissions(req.session.user);
  if (!perms || !perms.isSuperuser) {
    if (req.path.startsWith("/update/") && !wantsJson(req)) return res.status(403).send("Forbidden");
    return res.status(403).json({ success: false, message: "Yetersiz yetki." });
  }
  next();
});

function botOrder(order) {
  const ids = order ? String(order).split(",").map(s => s.trim()).filter(Boolean) : DEFAULT_BOT_ORDER;
  return ids.filter(id => config.bots[id]);
}

async function ensureBotRunning(botId) {
  if (!isConnected(activeProcesses[botId])) {
    spawnProcess(botId);
    await delay(BOT_START_WAIT_MS);
  }
  const proc = activeProcesses[botId];
  return isConnected(proc) ? proc : null;
}

// Applies an action to each bot in order, pausing between bots to avoid Discord rate limits.
function runInBackground(orderArray, gapMs, action) {
  (async () => {
    for (const botId of orderArray) {
      try {
        await action(botId);
      } catch (err) {
        console.error(`[Bots] Mass action failed for ${botId}:`, err.message);
      }
      await delay(gapMs);
    }
  })();
}

router.post("/admin/bots/update/:id", async (req, res) => {
  try {
    const botId = req.params.id;
    if (!config.bots[botId]) {
      return res.status(404).send("Bot bulunamadı.");
    }
    const { name, isEnabled, description, statusText, statusType, activityType, streamingUrl, avatarUrl, voiceChannelId } = req.body;
    const enabled = isEnabled === "true" || isEnabled === "on";

    const botObj = await DiscordBot.findOneAndUpdate({ botId }, {
      name, isEnabled: enabled, description, statusText, statusType, activityType, streamingUrl, avatarUrl, voiceChannelId
    }, { new: true });

    if (enabled) {
      if (!activeProcesses[botId]) {
        spawnProcess(botId);
      } else {
        const stats = await ServerStats.findOne();
        activeProcesses[botId].send(botConfigMessage("UPDATE_CONFIG", { statusText, statusType, activityType, streamingUrl, avatarUrl, voiceChannelId }, stats ? stats.errorMode : false));
        activeProcesses[botId].send({ type: "UPDATE_PROFILE", name, avatarUrl });
      }
    } else {
      stopProcess(botId);
    }

    logAction("botEdit", {
      executor: actorFrom(req),
      target: { id: botId, username: botId, data: botObj },
      details: `Discord bot ayarları güncellendi: ${botId} (Durum: ${enabled ? "Aktif" : "Pasif"})`,
      context: "Web Panel"
    });

    if (wantsJson(req)) {
      return res.json({ success: true, message: "Bot ayarları başarıyla güncellendi!" });
    }
    res.redirect("/admin/dashboard#discord-bots");
  } catch (error) {
    console.error("Bot update error:", error);
    res.status(500).send("Internal Server Error");
  }
});

router.post("/admin/bots/mass-voice-join", async (req, res) => {
  try {
    const { channelId, order } = req.body;
    if (!channelId) {
      return res.status(400).json({ success: false, message: "Geçersiz ses kanalı ID'si." });
    }
    await DiscordBot.updateMany({}, { voiceChannelId: channelId });

    const orderArray = botOrder(order);
    runInBackground(orderArray, 1500, async botId => {
      const proc = await ensureBotRunning(botId);
      if (proc) proc.send({ type: "VOICE_JOIN_REQUEST", channelId });
    });

    logAction("massVoiceJoin", {
      executor: actorFrom(req),
      details: `Tüm botlar toplu olarak sırayla (${orderArray.join(" -> ")}) ses kanalına yönlendirildi: ${channelId}`,
      context: "Web Panel"
    });
    res.json({ success: true, message: `Tüm botlar sırayla (${orderArray.join(" -> ")}) ses kanalına yönlendiriliyor.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/admin/bots/mass-presence", async (req, res) => {
  try {
    const { statusType, activityType, statusText, streamingUrl, order } = req.body;
    await DiscordBot.updateMany({}, { statusType, activityType, statusText, streamingUrl });

    const stats = await ServerStats.findOne();
    const errorMode = stats ? stats.errorMode : false;
    const orderArray = botOrder(order);

    runInBackground(orderArray, 1500, async botId => {
      const bot = await DiscordBot.findOne({ botId });
      if (!bot) return;
      const proc = await ensureBotRunning(botId);
      if (proc) {
        proc.send(botConfigMessage("UPDATE_CONFIG", { statusText, statusType, activityType, streamingUrl, avatarUrl: bot.avatarUrl, voiceChannelId: bot.voiceChannelId }, errorMode));
      }
    });

    logAction("massPresenceUpdate", {
      executor: actorFrom(req),
      details: `Tüm botların Discord durumları toplu olarak sırayla (${orderArray.join(" -> ")}) güncellendi.`,
      context: "Web Panel"
    });
    res.json({ success: true, message: `Tüm botların durumları sırayla (${orderArray.join(" -> ")}) güncelleniyor.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/admin/bots/mass-profile", async (req, res) => {
  try {
    const { avatarUrl, baseName, order } = req.body;
    const orderArray = botOrder(order);

    runInBackground(orderArray, 2500, async botId => {
      const bot = await DiscordBot.findOne({ botId });
      if (!bot) return;
      const newName = baseName ? `${baseName} ${PROFILE_SUFFIXES[botId] || botId}` : bot.name;
      const newAvatar = avatarUrl || bot.avatarUrl;
      await DiscordBot.findOneAndUpdate({ botId }, { name: newName, avatarUrl: newAvatar });

      const proc = await ensureBotRunning(botId);
      if (proc) proc.send({ type: "UPDATE_PROFILE", name: newName, avatarUrl: newAvatar });
    });

    logAction("massProfileUpdate", {
      executor: actorFrom(req),
      details: `Tüm botların profil ayarları toplu olarak sırayla (${orderArray.join(" -> ")}) güncellendi.`,
      context: "Web Panel"
    });
    res.json({ success: true, message: `Tüm botların profil bilgileri sırayla (${orderArray.join(" -> ")}) güncelleniyor.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
