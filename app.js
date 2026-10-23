const path = require("path");
const express = require("express");
const session = require("express-session");
const config = require("./config");
const { addLog } = require("./services/systemLog");
const { contentSecurityPolicy, csrfProtection } = require("./middleware/security");
const { siteContext } = require("./middleware/siteContext");
const { notFound, errorHandler } = require("./middleware/errors");
const { redactUrl } = require("./utils/http");

const BODY_LIMIT = "50mb";
const UNLOGGED_EXTENSIONS = new Set([".js", ".css", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".woff", ".woff2", ".ttf"]);
const UNLOGGED_PATH_PREFIXES = ["/admin/chat/stream", "/admin/api/active-staff/sse", "/api/fivem/screen/"];

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on("finish", () => {
    if (UNLOGGED_EXTENSIONS.has(path.extname(req.path)) || UNLOGGED_PATH_PREFIXES.some(p => req.path.startsWith(p))) return;
    addLog("Gateway", `${req.method} ${redactUrl(req.originalUrl)} - Status: ${res.statusCode} (${Date.now() - start}ms) - IP: ${req.ip}`, "info");
  });
  next();
}

function sessionMiddleware(store) {
  const { sameSite } = config.session;
  return session({
    name: config.session.cookieName,
    store,
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      // "auto": Secure whenever the request arrived over HTTPS (directly or via a proxy sending X-Forwarded-Proto),
      // so the same build works on http://localhost and behind an HTTPS domain. SameSite=None always needs Secure.
      secure: sameSite === "none" ? true : "auto",
      sameSite,
      httpOnly: true,
      path: "/",
      maxAge: config.session.maxAgeMs
    }
  });
}

function createApp({ sessionStore }) {
  const app = express();

  app.set("trust proxy", 1);
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "views"));
  app.disable("x-powered-by");

  app.use(contentSecurityPolicy);
  app.use(express.static(path.join(__dirname, "public")));
  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(express.urlencoded({ limit: BODY_LIMIT, extended: true }));
  app.use(sessionMiddleware(sessionStore));
  app.use(csrfProtection());
  app.use(requestLogger);
  app.use(siteContext);

  app.use(require("./routes/admin"));
  app.use(require("./routes/public"));
  app.use(require("./routes/auth"));
  app.use(require("./routes/applications"));
  app.use(require("./routes/chat"));
  app.use(require("./routes/bridge"));
  app.use(require("./routes/apiMonitor"));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
