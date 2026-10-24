const crypto = require("crypto");
const config = require("../config");
const { addLog } = require("../services/systemLog");

const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (err) {
    return null;
  }
}

function trustedOrigins() {
  const origins = new Set(config.gateway.trustedOrigins.map(originOf).filter(Boolean));
  const siteOrigin = originOf(config.siteUrl);
  if (siteOrigin) origins.add(siteOrigin);
  if (config.publicOrigin) origins.add(config.publicOrigin);
  // The panel can be embedded as this application's Discord Activity.
  if (config.oauth2.clientId) origins.add(`https://${config.oauth2.clientId}.discordsays.com`);
  return origins;
}

// The views still rely on inline scripts and third-party CDNs, so script sources stay permissive; framing, plugins and
// <base> hijacking are locked down. Framing is allowed for Discord (the panel can run as a Discord Activity).
const CSP = [
  "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self' https://discord.com https://*.discordsays.com"
].join("; ");

function contentSecurityPolicy(req, res, next) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
}

// Mutating routes authenticated by something other than the session cookie (HMAC-signed game server calls and
// token-authenticated screen uploads). Every other POST/PUT/PATCH/DELETE gets the Origin check.
const NON_SESSION_ROUTES = ["/api/fivem/bridge/poll", "/api/fivem/bridge/characters", "/api/fivem/bridge/shared-data", "/api/fivem/screen/upload"];

// CSRF protection for session-authenticated mutations: rejects cross-site requests by Origin and
// mismatching anti-CSRF tokens (when a client sends one).
function csrfProtection() {
  const allowedOrigins = trustedOrigins();

  return (req, res, next) => {
    if (req.session) {
      if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(24).toString("hex");
      }
      res.locals.csrfToken = req.session.csrfToken;
    }

    if (!MUTATING_METHODS.includes(req.method) || NON_SESSION_ROUTES.includes(req.path)) {
      return next();
    }

    const origin = req.headers.origin;
    if (origin && origin !== "null") {
      const hosts = [req.get("host"), req.get("x-forwarded-host")].filter(Boolean);
      const originHost = (() => {
        try {
          return new URL(origin).host;
        } catch (err) {
          return null;
        }
      })();
      if (!hosts.includes(originHost) && !allowedOrigins.has(origin)) {
        addLog("Gateway", `[CSRF UYARISI] Yabancı kaynaklı istek reddedildi: ${req.method} ${req.originalUrl} - Origin: ${origin} - IP: ${req.ip}`, "error");
        return res.status(403).json({ success: false, message: "Güvenlik Uyarısı: Oturum doğrulama (CSRF) hatası!" });
      }
    }

    const clientToken = (req.body && req.body._csrf) || req.headers["x-csrf-token"] || (req.query && req.query._csrf);
    if (req.session && req.session.csrfToken && clientToken && clientToken !== req.session.csrfToken) {
      addLog("Gateway", `[CSRF UYARISI] Geçersiz CSRF Token: ${req.method} ${req.originalUrl} - IP: ${req.ip}`, "error");
      return res.status(403).json({ success: false, message: "Güvenlik Uyarısı: Oturum doğrulama (CSRF) hatası!" });
    }
    next();
  };
}

module.exports = { contentSecurityPolicy, csrfProtection };
