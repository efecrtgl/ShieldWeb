const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const KNOWN_INSECURE_SESSION_SECRET = "shield-software-session-secret-key";

function str(name, fallback = "") {
  const value = process.env[name];
  return (value === undefined || value === null ? fallback : String(value)).trim();
}

function int(name, fallback) {
  const parsed = parseInt(str(name), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(...names) {
  const values = names.flatMap(name => str(name).split(","));
  return [...new Set(values.map(v => v.trim()).filter(Boolean))];
}

const OAUTH_CALLBACK_PATH = "/auth/callback";
const DISCORD_AUTHORIZE_HOSTS = ["discord.com", "discordapp.com"];
const DISCORD_AUTHORIZE_PATHS = ["/oauth2/authorize", "/api/oauth2/authorize"];

// Splits the canonical Discord authorize URL into its parts and records any problems with it.
function parseDiscordOAuthUrl(raw) {
  const result = { authorizeUrl: raw, clientId: "", redirectUri: "", scopes: [], callbackPath: OAUTH_CALLBACK_PATH, problems: [] };
  if (!raw) {
    result.problems.push("DISCORD_OAUTH_URL is not set. Copy the OAuth2 URL from the Discord Developer Portal (OAuth2 > URL Generator) into .env.");
    return result;
  }
  let url;
  try {
    url = new URL(raw);
  } catch (err) {
    result.problems.push("DISCORD_OAUTH_URL is not a valid URL.");
    return result;
  }
  const params = url.searchParams;
  result.clientId = params.get("client_id") || "";
  result.redirectUri = params.get("redirect_uri") || "";
  result.scopes = (params.get("scope") || "").split(/[\s+]+/).filter(Boolean);

  if (url.protocol !== "https:" || !DISCORD_AUTHORIZE_HOSTS.includes(url.hostname) || !DISCORD_AUTHORIZE_PATHS.includes(url.pathname)) {
    result.problems.push("DISCORD_OAUTH_URL must be a https://discord.com/oauth2/authorize URL.");
  }
  if (!/^\d{17,20}$/.test(result.clientId)) {
    result.problems.push("DISCORD_OAUTH_URL has no valid client_id.");
  }
  if (params.get("response_type") !== "code") {
    result.problems.push("DISCORD_OAUTH_URL must use response_type=code.");
  }
  if (!result.scopes.includes("identify")) {
    result.problems.push("DISCORD_OAUTH_URL scope must include \"identify\".");
  }
  if (params.has("state")) {
    result.problems.push("DISCORD_OAUTH_URL must not contain a state parameter; a fresh state is added for every login.");
  }
  try {
    const redirect = new URL(result.redirectUri);
    if (!["http:", "https:"].includes(redirect.protocol) || redirect.pathname !== OAUTH_CALLBACK_PATH || redirect.search || redirect.hash) {
      result.problems.push(`DISCORD_OAUTH_URL redirect_uri must point to this app's callback, e.g. https://your-domain${OAUTH_CALLBACK_PATH}`);
    }
  } catch (err) {
    result.problems.push("DISCORD_OAUTH_URL has no valid redirect_uri.");
  }
  return result;
}

const config = {
  env: str("NODE_ENV", "development"),
  projectName: str("PROJECT_NAME", "Shield Software"),
  serverName: str("SERVER_NAME", "Shield Software"),
  siteUrl: str("SITE_URL", "http://localhost:3000"),
  footer: str("FOOTER_TEXT", "Developed by realflexd & kai7m | Shield Software"),

  mongodb: {
    uri: str("MONGODB_URI", "mongodb://127.0.0.1:27017/Shield")
  },

  // Discord login. DISCORD_OAUTH_URL is the single source of truth: client id, callback URL and
  // scopes are read from it (see parseDiscordOAuthUrl). Only the client secret is configured separately.
  oauth2: {
    ...parseDiscordOAuthUrl(str("DISCORD_OAUTH_URL")),
    clientSecret: str("DISCORD_CLIENT_SECRET")
  },

  session: {
    secret: str("SESSION_SECRET"),
    cookieName: "connect.sid",
    maxAgeMs: 24 * 60 * 60 * 1000,
    // "lax" works for the OAuth redirect flow over HTTP and HTTPS. "none" is only needed when the
    // panel is embedded cross-site (Discord Activity) and requires HTTPS.
    sameSite: str("SESSION_COOKIE_SAMESITE", "lax").toLowerCase()
  },

  // Discord IDs with unrestricted access. MASTER_USERS is kept as an alias of SUPERUSERS.
  superusers: list("SUPERUSERS", "MASTER_USERS"),

  discord: {
    guildId: str("DISCORD_GUILD_ID"),
    loggerGuildId: str("DISCORD_LOGGER_GUILD_ID"),
    whitelistRoleId: str("DISCORD_WHITELIST_ROLE_ID"),
    unregisteredRoleId: str("DISCORD_UNREGISTERED_ROLE_ID"),
    staffRoleId: str("DISCORD_STAFF_ROLE_ID"),
    voiceSupportRoleId: str("DISCORD_VOICE_SUPPORT_ROLE_ID"),
    illegalCategoryId: str("DISCORD_ILLEGAL_CATEGORY_ID"),
    legalCategoryId: str("DISCORD_LEGAL_CATEGORY_ID"),
    businessCategoryId: str("DISCORD_BUSINESS_CATEGORY_ID"),
    bossRoleId: str("DISCORD_BOSS_ROLE_ID"),
    highCommandRoleId: str("DISCORD_HIGH_COMMAND_ROLE_ID"),
    wlPunishedRoleId: str("DISCORD_WL_PUNISHED_ROLE_ID"),
    wipePunishRoleId: str("DISCORD_WIPE_PUNISH_ROLE_ID"),
    illegalBirimRoleId: str("DISCORD_ILLEGAL_BIRIM_ROLE_ID"),
    applicationLogChannelId: str("DISCORD_APPLICATION_LOG_CHANNEL_ID"),
    punishmentLogChannelId: str("DISCORD_PUNISHMENT_LOG_CHANNEL_ID"),
    streamerAnnounceChannelId: str("DISCORD_STREAMER_ANNOUNCE_CHANNEL_ID")
  },

  gateway: {
    port: int("GATEWAY_PORT", int("PORT", 3000)),
    // Discord bots are forked by the gateway unless PM2 runs them separately.
    spawnBots: str("PM2_DISCORD_SEPARATE") !== "true",
    // Extra origins allowed to send state-changing admin requests (e.g. Discord Activity proxy).
    trustedOrigins: list("CSRF_TRUSTED_ORIGINS")
  },

  bots: {
    verification: { token: str("BOT1_TOKEN"), script: path.join(__dirname, "bots", "bot1-verification", "index.js") },
    logger: { token: str("BOT2_TOKEN"), script: path.join(__dirname, "bots", "bot2-logger", "index.js") },
    moderation: { token: str("BOT3_TOKEN"), script: path.join(__dirname, "bots", "bot3-moderation", "index.js") },
    sync: { token: str("BOT4_TOKEN"), script: path.join(__dirname, "bots", "bot4-sync", "index.js") },
    management: { token: str("BOT5_TOKEN"), script: path.join(__dirname, "bots", "bot5-management", "index.js") }
  },

  fivemBridge: {
    secretKey: str("FIVEM_BRIDGE_SECRET"),
    allowedIp: str("FIVEM_BRIDGE_ALLOWED_IP", "localhost")
  },

  site: {
    // Public Discord invite shown on the site (home, FAQ, footer, error pages).
    discordInviteUrl: str("DISCORD_INVITE_URL", "https://discord.gg/starv")
  },

  gemini: {
    apiKey: str("GEMINI_API_KEY"),
    model: str("GEMINI_MODEL", "gemini-2.0-flash")
  },

  logging: {
    dir: str("LOG_DIR", path.join(__dirname, "logs")),
    retentionDays: int("LOG_RETENTION_DAYS", 14)
  },

  uploadsDir: path.join(__dirname, "public", "uploads"),
  sharedDataPath: path.join(__dirname, "shared_data.json")
};

// Public origin of the panel (scheme + host + port), taken from the OAuth callback URL.
config.publicOrigin = (() => {
  try {
    return new URL(config.oauth2.redirectUri).origin;
  } catch (err) {
    return "";
  }
})();

config.isSuperuser = function isSuperuser(discordId) {
  return !!discordId && config.superusers.includes(String(discordId));
};

// A usable bot token is any non-empty value that is not an explicit placeholder.
config.hasBotToken = function hasBotToken(botId) {
  const token = config.bots[botId] && config.bots[botId].token;
  return !!token && !token.includes("placeholder");
};

config.validate = function validate() {
  const errors = [];
  const warnings = [];

  if (!config.session.secret) {
    errors.push("SESSION_SECRET is not set. Add a long random string to .env (see .env.example).");
  } else if (config.session.secret === KNOWN_INSECURE_SESSION_SECRET || config.session.secret.length < 32) {
    warnings.push("SESSION_SECRET is weak or a publicly known default; sessions can be forged. Replace it with a long random value.");
  }
  errors.push(...config.oauth2.problems);
  if (!config.oauth2.clientSecret) {
    errors.push("DISCORD_CLIENT_SECRET is not set (Discord Developer Portal > OAuth2 > Client Secret).");
  }
  // Legacy variables may stay in .env, but must agree with DISCORD_OAUTH_URL.
  const legacyClientId = str("DISCORD_CLIENT_ID");
  if (legacyClientId && config.oauth2.clientId && legacyClientId !== config.oauth2.clientId) {
    errors.push("DISCORD_CLIENT_ID does not match the client_id in DISCORD_OAUTH_URL. Remove DISCORD_CLIENT_ID or make them equal.");
  }
  const legacyRedirect = str("DISCORD_REDIRECT_URI");
  if (legacyRedirect && config.oauth2.redirectUri && legacyRedirect !== config.oauth2.redirectUri) {
    errors.push("DISCORD_REDIRECT_URI does not match the redirect_uri in DISCORD_OAUTH_URL. Remove DISCORD_REDIRECT_URI or make them equal.");
  }
  if (!["lax", "strict", "none"].includes(config.session.sameSite)) {
    errors.push(`SESSION_COOKIE_SAMESITE must be lax, strict or none (got "${config.session.sameSite}").`);
  } else if (config.session.sameSite === "none" && !config.oauth2.redirectUri.startsWith("https://")) {
    errors.push("SESSION_COOKIE_SAMESITE=none requires an https:// redirect_uri; browsers reject such cookies over HTTP.");
  }
  if (config.oauth2.redirectUri && config.publicOrigin && config.siteUrl) {
    try {
      if (new URL(config.siteUrl).origin !== config.publicOrigin) {
        warnings.push(`SITE_URL (${config.siteUrl}) and the OAuth redirect origin (${config.publicOrigin}) differ; they should both be the public address of the panel.`);
      }
    } catch (err) {
      warnings.push("SITE_URL is not a valid URL.");
    }
  }
  if (!config.fivemBridge.secretKey) {
    warnings.push("FIVEM_BRIDGE_SECRET is not set; all FiveM bridge requests will be rejected.");
  }
  if (config.superusers.length === 0) {
    warnings.push("SUPERUSERS is empty; no account has full admin access.");
  }
  for (const botId of Object.keys(config.bots)) {
    if (!config.hasBotToken(botId)) {
      warnings.push(`Bot token for "${botId}" is not set; that bot will not be started.`);
    }
  }
  if (!Number.isInteger(config.gateway.port) || config.gateway.port <= 0) {
    errors.push(`GATEWAY_PORT/PORT is invalid: "${str("GATEWAY_PORT") || str("PORT")}".`);
  }

  return { errors, warnings };
};

module.exports = config;
