const express = require("express");
const { getUserPermissions } = require("../services/permissions");
const { addLog } = require("../services/systemLog");
const { clientIp } = require("../utils/http");

const router = express.Router();

const MAX_RECORDED_REQUESTS = 50;
const SENSITIVE_HEADERS = new Set(["cookie", "authorization", "x-bridge-signature", "x-csrf-token", "proxy-authorization"]);
const SENSITIVE_BODY_KEYS = /token|secret|password|signature|_csrf|content/i;

const recentApiRequests = [];

function redactHeaders(headers) {
  return Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k, SENSITIVE_HEADERS.has(k.toLowerCase()) ? "[redacted]" : v]));
}

function redactBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body || {};
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, SENSITIVE_BODY_KEYS.test(k) ? "[redacted]" : v]));
}

// The API monitor exposes request details, so it is restricted to superusers.
async function requireSuperuser(req, res, next) {
  const perms = await getUserPermissions(req.session.user);
  if (perms && perms.isSuperuser) return next();
  if (!req.session.user && req.path === "/api") return res.redirect("/login?next=%2Fapi");
  res.status(403).json({ success: false, message: "Bu sayfayı sadece Kurucular görüntüleyebilir." });
}

// Records /api requests that reach this point (i.e. were not answered by an earlier router).
router.use("/api", (req, res, next) => {
  if (req.path === "/" || req.path === "/json") return next();
  const start = Date.now();
  res.on("finish", () => {
    const ip = clientIp(req);
    const body = redactBody(req.body);
    recentApiRequests.unshift({
      timestamp: new Date().toLocaleTimeString(),
      method: req.method,
      url: req.originalUrl,
      ip,
      statusCode: res.statusCode,
      duration: Date.now() - start,
      headers: redactHeaders(req.headers),
      body,
      query: req.query || {}
    });
    if (recentApiRequests.length > MAX_RECORDED_REQUESTS) recentApiRequests.pop();
    addLog("Gateway", `[API] ${req.method} ${req.originalUrl} - IP: ${ip} - Status: ${res.statusCode} (${Date.now() - start}ms) - Body: ${JSON.stringify(body)}`, "info");
  });
  next();
});

router.get("/api", requireSuperuser, (req, res) => {
  res.render("api_monitor", { requests: recentApiRequests, user: req.session.user || null });
});

router.get("/api/json", requireSuperuser, (req, res) => {
  res.json(recentApiRequests);
});

module.exports = router;
