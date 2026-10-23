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

function contentSecurityPolicy(req, res, next) {
  res.setHeader("Content-Security-Policy", "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");
  next();
}

// CSRF protection for admin mutations: rejects cross-site requests by Origin and
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

    if (!req.path.startsWith("/admin") || !MUTATING_METHODS.includes(req.method)) {
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
