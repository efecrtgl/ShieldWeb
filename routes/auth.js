const express = require("express");
const config = require("../config");
const { UserRank } = require("../models/ServerInfo");
const { logAction } = require("../services/auditLog");
const { OAuthError, createState, statesMatch, buildAuthorizeUrl, exchangeCode, fetchCurrentUser } = require("../services/discordOAuth");
const { safeRedirectPath, clientIp } = require("../utils/http");
const { rateLimit } = require("../middleware/rateLimit");

const router = express.Router();

const STATE_TTL_MS = 10 * 60 * 1000;
// Several tabs may start a login at the same time; each keeps its own state.
const MAX_PENDING_STATES = 5;
// Codes being (or recently) exchanged, so a duplicated callback request cannot clobber the new session.
const HANDLED_CODE_TTL_MS = 5 * 60 * 1000;
const handledCodes = new Map();

const LOGIN_ERRORS = {
  denied: "Discord girişi iptal edildi.",
  state: "Giriş isteği doğrulanamadı veya süresi doldu. Lütfen tekrar giriş yapın.",
  invalid: "Discord'dan geçersiz bir yanıt alındı. Lütfen tekrar giriş yapın.",
  expired_code: "Giriş bağlantısının süresi doldu. Lütfen tekrar giriş yapın.",
  rejected: "Discord giriş isteğini reddetti. Lütfen yöneticiye bildirin.",
  discord_unavailable: "Discord'a şu anda ulaşılamıyor. Lütfen biraz sonra tekrar deneyin.",
  token: "Discord'dan giriş bilgisi alınamadı. Lütfen tekrar deneyin.",
  profile: "Discord hesap bilgileri alınamadı. Lütfen tekrar deneyin.",
  session: "Oturum oluşturulamadı. Lütfen tekrar deneyin.",
  server: "Giriş sırasında beklenmeyen bir hata oluştu."
};

function loginErrorRedirect(res, code, next) {
  const params = new URLSearchParams({ error: code });
  if (next && next !== "/") params.set("next", next);
  res.redirect(`/login?${params.toString()}`);
}

function rememberHandledCode(code) {
  const now = Date.now();
  for (const [key, at] of handledCodes) {
    if (now - at > HANDLED_CODE_TTL_MS) handledCodes.delete(key);
  }
  handledCodes.set(code, now);
}

// Host the browser used for this request (proxy-aware).
function requestHost(req) {
  return req.get("x-forwarded-host") || req.get("host") || "";
}

router.get("/login", (req, res) => {
  const next = safeRedirectPath(req.query.next);
  if (req.session.user) {
    return res.redirect(next);
  }
  res.render("login", {
    user: null,
    next,
    loginError: LOGIN_ERRORS[req.query.error] || null
  });
});

// Login and callback are rate limited per IP: each callback spends a Discord token exchange.
const authLimiter = rateLimit({ name: "auth", windowMs: 60 * 1000, max: config.rateLimits.authPerMinute, key: req => clientIp(req) });

router.get("/auth/login", authLimiter, (req, res) => {
  const next = safeRedirectPath(req.query.next);
  if (req.session.user) {
    return res.redirect(next);
  }

  // The session cookie (holding the state) must live on the same host as the registered callback URL.
  const publicHost = new URL(config.publicOrigin).host;
  if (requestHost(req) !== publicHost && req.query.canonical !== "1") {
    const params = new URLSearchParams({ next, canonical: "1" });
    return res.redirect(`${config.publicOrigin}/auth/login?${params.toString()}`);
  }

  const now = Date.now();
  const state = createState();
  const pendingStates = (req.session.oauthStates || []).filter(s => now - s.createdAt < STATE_TTL_MS);
  pendingStates.push({ state, next, createdAt: now });
  req.session.oauthStates = pendingStates.slice(-MAX_PENDING_STATES);

  // Persist the state before leaving for Discord, otherwise the callback may not find it.
  req.session.save(err => {
    if (err) {
      console.error("[Auth] Could not save login state:", err.message);
      return loginErrorRedirect(res, "session", next);
    }
    res.redirect(buildAuthorizeUrl(state));
  });
});

router.get("/auth/callback", authLimiter, async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return loginErrorRedirect(res, error === "access_denied" ? "denied" : "invalid");
  }
  if (typeof code !== "string" || typeof state !== "string" || !code || !state) {
    return req.session.user ? res.redirect("/") : loginErrorRedirect(res, "invalid");
  }
  // A repeated callback (refresh, prefetch, double click) must not touch the session again.
  if (handledCodes.has(code)) {
    return res.redirect("/");
  }

  const now = Date.now();
  const pendingStates = (req.session.oauthStates || []).filter(s => now - s.createdAt < STATE_TTL_MS);
  const match = pendingStates.find(s => statesMatch(s.state, state));
  if (!match) {
    return req.session.user ? res.redirect("/") : loginErrorRedirect(res, "state");
  }
  // States are single use.
  req.session.oauthStates = pendingStates.filter(s => s !== match);
  rememberHandledCode(code);

  let discordUser;
  try {
    discordUser = await fetchCurrentUser(await exchangeCode(code));
  } catch (err) {
    const reason = err instanceof OAuthError ? err.code : "server";
    console.error(`[Auth] Discord login failed (${reason}): ${err.message}`);
    return loginErrorRedirect(res, LOGIN_ERRORS[reason] ? reason : "server", match.next);
  }

  try {
    await UserRank.findOneAndUpdate({ discordId: discordUser.id }, { username: discordUser.username }, { upsert: true });
  } catch (err) {
    console.error("[Auth] Could not update user record:", err.message);
  }

  // New session id after login (prevents session fixation); the old session's data is discarded.
  req.session.regenerate(regenErr => {
    if (regenErr) {
      console.error("[Auth] Session regenerate error:", regenErr.message);
      return loginErrorRedirect(res, "session", match.next);
    }
    req.session.user = {
      id: discordUser.id,
      username: discordUser.username,
      avatar: discordUser.avatar,
      isSuperuser: config.isSuperuser(discordUser.id)
    };
    req.session.loginAt = Date.now();

    // Redirect only once the session is stored, so the next request already sees the login.
    req.session.save(saveErr => {
      if (saveErr) {
        console.error("[Auth] Session save error:", saveErr.message);
        return loginErrorRedirect(res, "session", match.next);
      }
      logAction("userLogin", {
        executor: { id: discordUser.id, username: discordUser.username, ip: req.ip },
        details: "Kullanıcı web paneline giriş yaptı.",
        context: "Web Panel"
      });
      res.redirect(match.next);
    });
  });
});

router.get("/auth/logout", (req, res) => {
  const user = req.session.user;
  req.session.destroy(err => {
    if (err) console.error("[Auth] Session destroy error:", err.message);
    if (user) {
      logAction("userLogout", {
        executor: { id: user.id, username: user.username, ip: req.ip },
        details: "Kullanıcı web panelinden çıkış yaptı.",
        context: "Web Panel"
      });
    }
    res.clearCookie(config.session.cookieName, { path: "/" });
    res.redirect("/");
  });
});

module.exports = router;
