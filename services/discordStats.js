const { DiscordUser } = require("../models/ServerInfo");
const { activeProcesses, pending, isConnected } = require("./botRegistry");
const { newRequestId } = require("../utils/http");

const CACHE_TTL_MS = 15000;
const BOT_RESPONSE_TIMEOUT_MS = 1200;

let cachedStats = null;
let lastFetchTime = 0;
let refreshInFlight = null;

function askAnyBotForStats() {
  const botProcess = Object.values(activeProcesses).find(isConnected);
  if (!botProcess) return Promise.resolve(null);

  const requestId = newRequestId();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      delete pending.liveStats[requestId];
      reject(new Error("Timeout waiting for Discord bot stats"));
    }, BOT_RESPONSE_TIMEOUT_MS);
    pending.liveStats[requestId] = { resolve, reject, timeout };
    botProcess.send({ type: "GET_DISCORD_LIVE_STATS", requestId });
  }).catch(() => null);
}

async function refresh() {
  try {
    // totalUsers means different things per source: Discord guild members (bot) or panel user records (database).
    let stats = await askAnyBotForStats();
    if (stats) stats = { ...stats, source: "discord", readAt: new Date().toISOString() };
    if (!stats) {
      const [totalUsers, staffCount, whitelistCount] = await Promise.all([
        DiscordUser.countDocuments({}),
        DiscordUser.countDocuments({ rankId: { $ne: null } }),
        DiscordUser.countDocuments({ isWhitelist: true })
      ]);
      stats = { totalUsers, staffCount, whitelistCount, source: "database", readAt: new Date().toISOString() };
    }
    cachedStats = stats;
    lastFetchTime = Date.now();
  } catch (err) {
    console.error("[Discord Live Stats] Refresh error:", err.message);
  }
  return cachedStats;
}

function refreshOnce() {
  if (!refreshInFlight) {
    refreshInFlight = refresh().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

// Guild member / staff / whitelist counts. Serves stale data instantly while refreshing in the background.
async function fetchDiscordLiveStats() {
  if (cachedStats && Date.now() - lastFetchTime < CACHE_TTL_MS) return cachedStats;
  if (cachedStats) {
    refreshOnce();
    return cachedStats;
  }
  return refreshOnce();
}

function invalidateDiscordStats() {
  cachedStats = null;
  lastFetchTime = 0;
}

module.exports = { fetchDiscordLiveStats, invalidateDiscordStats };
