const { fork } = require("child_process");
const config = require("../config");
const { DiscordBot, ServerStats } = require("../models/ServerInfo");
const { activeProcesses } = require("./botRegistry");
const { systems, addLog, renderDashboard } = require("./systemLog");
const { handleBotMessage } = require("./botResponses");

// Restarts within this window count towards the crash-loop limit.
const RESTART_WINDOW_MS = 60 * 1000;
const MAX_RESTARTS_PER_WINDOW = 5;
const RESTART_DELAY_MS = 2000;

const restartHistory = {};
let shuttingDown = false;

function botConfigMessage(type, botConfig, errorMode) {
  return {
    type,
    statusText: botConfig.statusText,
    statusType: botConfig.statusType,
    activityType: botConfig.activityType,
    streamingUrl: botConfig.streamingUrl,
    avatarUrl: botConfig.avatarUrl,
    voiceChannelId: botConfig.voiceChannelId,
    errorMode
  };
}

function canStartBot(botId) {
  if (!config.bots[botId]) {
    addLog("Orchestrator", `Bilinmeyen bot kimliği: ${botId}`, "error");
    return false;
  }
  if (!config.hasBotToken(botId)) {
    addLog("Orchestrator", `${botId} için bot token tanımlı değil, başlatılmadı.`, "error");
    return false;
  }
  return true;
}

function tooManyRestarts(botId) {
  const now = Date.now();
  const history = (restartHistory[botId] || []).filter(t => now - t < RESTART_WINDOW_MS);
  history.push(now);
  restartHistory[botId] = history;
  return history.length > MAX_RESTARTS_PER_WINDOW;
}

// Forks a bot as a child process, wires IPC/log streams and restarts it if it exits while still enabled.
function spawnProcess(botId) {
  if (activeProcesses[botId] || !canStartBot(botId)) return;

  const child = fork(config.bots[botId].script, [], { silent: true });
  activeProcesses[botId] = child;
  systems[botId].status = "ONLINE";
  systems[botId].pid = child.pid;

  Promise.all([DiscordBot.findOne({ botId }), ServerStats.findOne()])
    .then(([botConfig, stats]) => {
      if (botConfig && child.connected) {
        child.send(botConfigMessage("INIT_CONFIG", botConfig, stats ? stats.errorMode : false));
      }
    })
    .catch(err => addLog("Orchestrator", `${botId} başlangıç ayarları gönderilemedi: ${err.message}`, "error"));

  child.on("message", msg => handleBotMessage(botId, msg));
  child.stdout.on("data", data => addLog(botId, data.toString()));
  child.stderr.on("data", data => addLog(botId, data.toString(), "error"));

  child.on("exit", code => {
    systems[botId].status = "OFFLINE";
    systems[botId].pid = "-";
    if (activeProcesses[botId] === child) delete activeProcesses[botId];
    if (shuttingDown) return;

    DiscordBot.findOne({ botId })
      .then(botConfig => {
        if (!botConfig || !botConfig.isEnabled) {
          addLog("Orchestrator", `${botId} exited with code ${code}. Bot is disabled, not restarting.`);
          renderDashboard();
          return;
        }
        if (tooManyRestarts(botId)) {
          systems[botId].status = "ERROR";
          addLog("Orchestrator", `${botId} kısa sürede çok fazla kez çöktü; otomatik yeniden başlatma durduruldu.`, "error");
          renderDashboard();
          return;
        }
        addLog("Orchestrator", `${botId} exited with code ${code}. Restarting...`, "error");
        renderDashboard();
        setTimeout(() => spawnProcess(botId), RESTART_DELAY_MS);
      })
      .catch(err => addLog("Orchestrator", `${botId} yeniden başlatma kontrolü başarısız: ${err.message}`, "error"));
  });
}

function stopProcess(botId) {
  const child = activeProcesses[botId];
  if (child) child.kill();
}

function stopAll() {
  shuttingDown = true;
  for (const child of Object.values(activeProcesses)) {
    try {
      child.kill();
    } catch (err) {}
  }
}

async function startEnabledBots(printStep) {
  const bots = await DiscordBot.find();
  for (const bot of bots) {
    if (bot.isEnabled && canStartBot(bot.botId)) {
      spawnProcess(bot.botId);
      printStep("🤖", `${bot.name} süreci başlatıldı.`);
    }
  }
}

module.exports = { spawnProcess, stopProcess, stopAll, startEnabledBots, botConfigMessage };
