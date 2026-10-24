const express = require("express");
const mongoose = require("mongoose");
const { systems } = require("../services/systemLog");
const { bridgeStatus } = require("../services/fivemState");

const router = express.Router();

const BOT_KEYS = ["verification", "logger", "moderation", "sync", "management"];

// Liveness: the process is up and serving HTTP.
router.get("/healthz", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ status: "ok", uptimeSeconds: Math.round(process.uptime()) });
});

// Readiness: the panel can serve requests that need the database. The FiveM bridge and the Discord bots are reported
// for monitoring but do not make the panel unready (the site works while the game server is offline).
router.get("/readyz", (req, res) => {
  const mongoReady = mongoose.connection.readyState === 1;
  const bridge = bridgeStatus();
  res.set("Cache-Control", "no-store");
  res.status(mongoReady ? 200 : 503).json({
    status: mongoReady ? "ready" : "not_ready",
    checks: {
      mongodb: mongoReady ? "up" : "down",
      sessionStore: systems.SessionStore ? systems.SessionStore.status.toLowerCase() : "unknown"
    },
    info: {
      fivemBridge: bridge.online ? "online" : (bridge.lastPollAt ? "offline" : "never_connected"),
      bots: Object.fromEntries(BOT_KEYS.map(key => [key, systems[key] ? systems[key].status.toLowerCase() : "unknown"]))
    }
  });
});

module.exports = router;
