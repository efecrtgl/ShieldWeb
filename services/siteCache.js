const { SiteModule, ServerStats, UserRank } = require("../models/ServerInfo");

// Short-lived caches for data read by the global per-request middleware.
const SITE_MODULES_TTL_MS = 10000;
const SERVER_STATS_TTL_MS = 10000;
const USER_CREDITS_TTL_MS = 15000;

let siteModules = null;
let siteModulesFetchedAt = 0;
let serverStats = null;
let serverStatsFetchedAt = 0;
const userCredits = new Map();

async function getCachedSiteModules() {
  const now = Date.now();
  if (siteModules && now - siteModulesFetchedAt < SITE_MODULES_TTL_MS) return siteModules;

  const modules = {};
  const moduleDetails = {};
  for (const m of await SiteModule.find().lean()) {
    modules[m.key] = m.isEnabled;
    moduleDetails[m.key] = { isEnabled: m.isEnabled, behavior: m.behavior, customMessage: m.customMessage, name: m.name };
  }
  siteModules = { modules, moduleDetails };
  siteModulesFetchedAt = now;
  return siteModules;
}

async function getCachedServerStats() {
  const now = Date.now();
  if (serverStats && now - serverStatsFetchedAt < SERVER_STATS_TTL_MS) return serverStats;
  serverStats = (await ServerStats.findOne().lean()) || {};
  serverStatsFetchedAt = now;
  return serverStats;
}

async function getCachedUserCredits(discordId) {
  if (!discordId) return 0;
  const cached = userCredits.get(discordId);
  if (cached && Date.now() - cached.ts < USER_CREDITS_TTL_MS) return cached.credits;
  const userRank = await UserRank.findOne({ discordId }).lean();
  const credits = userRank ? userRank.credits || 0 : 0;
  userCredits.set(discordId, { credits, ts: Date.now() });
  return credits;
}

function invalidateUserCredits(discordId) {
  userCredits.delete(discordId);
}

module.exports = { getCachedSiteModules, getCachedServerStats, getCachedUserCredits, invalidateUserCredits };
