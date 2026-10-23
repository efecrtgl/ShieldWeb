const crypto = require("crypto");

// True when the client expects a JSON response (fetch/XHR or JSON body) rather than a redirect/HTML page.
function wantsJson(req) {
  const accept = req.headers.accept || "";
  const contentType = req.headers["content-type"] || "";
  return !!(req.xhr || accept.includes("json") || contentType.includes("application/json"));
}

function escapeRegex(value) {
  return String(value).replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

// Case-insensitive "contains" regex for user-supplied search text (treated literally, never as a pattern).
function searchRegex(value) {
  return { $regex: escapeRegex(value), $options: "i" };
}

function clientIp(req) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || "";
  return ip.startsWith("::ffff:") ? ip.substring(7) : ip;
}

function newRequestId() {
  return crypto.randomUUID();
}

function isSnowflake(value) {
  return /^\d{17,20}$/.test(String(value || "").trim());
}

// Local path to send the user to after login; anything else (absolute/protocol-relative URLs, auth routes) becomes "/".
function safeRedirectPath(value) {
  const path = typeof value === "string" ? value.trim() : "";
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\") || path.length > 512) return "/";
  if (path.startsWith("/auth/") || path === "/login" || path.startsWith("/login?")) return "/";
  return path;
}

const SENSITIVE_QUERY_PARAMS = ["code", "state", "token", "access_token"];

// URL with OAuth codes, states and tokens masked, for logging.
function redactUrl(url) {
  const queryStart = String(url).indexOf("?");
  if (queryStart === -1) return url;
  const params = new URLSearchParams(url.slice(queryStart + 1));
  for (const key of SENSITIVE_QUERY_PARAMS) {
    if (params.has(key)) params.set(key, "[redacted]");
  }
  return url.slice(0, queryStart + 1) + params.toString();
}

module.exports = { wantsJson, escapeRegex, searchRegex, clientIp, newRequestId, isSnowflake, safeRedirectPath, redactUrl };
