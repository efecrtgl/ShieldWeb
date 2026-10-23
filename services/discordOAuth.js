const crypto = require("crypto");
const axios = require("axios");
const config = require("../config");

const TOKEN_URL = "https://discord.com/api/v10/oauth2/token";
const CURRENT_USER_URL = "https://discord.com/api/v10/users/@me";
const REQUEST_TIMEOUT_MS = 10000;

// Raised for failures the user can resolve by logging in again (bad/expired code, Discord-side rejection).
class OAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function createState() {
  return crypto.randomBytes(24).toString("hex");
}

function statesMatch(expected, received) {
  if (typeof expected !== "string" || typeof received !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The canonical DISCORD_OAUTH_URL plus a per-login state value.
function buildAuthorizeUrl(state) {
  const url = new URL(config.oauth2.authorizeUrl);
  url.searchParams.set("state", state);
  return url.toString();
}

function describeAxiosError(err) {
  if (err.response) {
    const body = err.response.data || {};
    return `HTTP ${err.response.status} ${body.error || ""} ${body.error_description || body.message || ""}`.trim();
  }
  return err.code || err.message;
}

// Exchanges an authorization code for an access token. The redirect_uri must be byte-identical to the one in the authorize URL.
async function exchangeCode(code) {
  try {
    const { data } = await axios.post(TOKEN_URL, new URLSearchParams({
      client_id: config.oauth2.clientId,
      client_secret: config.oauth2.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: config.oauth2.redirectUri
    }), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: REQUEST_TIMEOUT_MS
    });
    if (!data || !data.access_token) {
      throw new OAuthError("token", "Discord token response did not contain an access token.");
    }
    return data;
  } catch (err) {
    if (err instanceof OAuthError) throw err;
    const status = err.response && err.response.status;
    const errorCode = err.response && err.response.data && err.response.data.error;
    if (status === 400 && errorCode === "invalid_grant") {
      throw new OAuthError("expired_code", "Authorization code is invalid, expired or already used.");
    }
    if (status === 400 || status === 401) {
      throw new OAuthError("rejected", `Discord rejected the token request (${describeAxiosError(err)}). Check DISCORD_CLIENT_SECRET and the redirect_uri registered in the Developer Portal.`);
    }
    throw new OAuthError("discord_unavailable", `Discord token request failed: ${describeAxiosError(err)}`);
  }
}

async function fetchCurrentUser(tokenData) {
  try {
    const { data } = await axios.get(CURRENT_USER_URL, {
      headers: { Authorization: `${tokenData.token_type || "Bearer"} ${tokenData.access_token}` },
      timeout: REQUEST_TIMEOUT_MS
    });
    if (!data || !/^\d{17,20}$/.test(String(data.id || ""))) {
      throw new OAuthError("profile", "Discord user response did not contain a valid user id.");
    }
    return { id: String(data.id), username: data.username, globalName: data.global_name || null, avatar: data.avatar || null };
  } catch (err) {
    if (err instanceof OAuthError) throw err;
    throw new OAuthError("discord_unavailable", `Discord user request failed: ${describeAxiosError(err)}`);
  }
}

module.exports = { OAuthError, createState, statesMatch, buildAuthorizeUrl, exchangeCode, fetchCurrentUser };
