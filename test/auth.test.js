const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const os = require("os");

const PORT = 3197;
const PUBLIC_ORIGIN = `http://127.0.0.1:${PORT}`;
const CLIENT_ID = "123456789012345678";
const REDIRECT_URI = `${PUBLIC_ORIGIN}/auth/callback`;
const CANONICAL_URL = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=identify+guilds`;

Object.assign(process.env, {
  DISCORD_OAUTH_URL: CANONICAL_URL,
  DISCORD_CLIENT_SECRET: "test-client-secret",
  DISCORD_CLIENT_ID: "",
  DISCORD_REDIRECT_URI: "",
  SESSION_SECRET: "auth-test-session-secret-0123456789abcdef",
  SESSION_COOKIE_SAMESITE: "lax",
  SITE_URL: PUBLIC_ORIGIN,
  LOG_DIR: path.join(os.tmpdir(), "shield-test-logs"),
  // These tests log in many times from one address.
  AUTH_RATE_LIMIT_PER_MINUTE: "1000"
});

const axios = require("axios");
const express = require("express");
const session = require("express-session");
const config = require("../config");
const { UserRank, ActionLog } = require("../models/ServerInfo");
const { safeRedirectPath, redactUrl } = require("../utils/http");

// No database in unit tests: stub the two writes made during login.
UserRank.findOneAndUpdate = async () => null;
ActionLog.prototype.save = async function save() { return this; };

// Mocked Discord API.
const discord = { tokenCalls: [], tokenResponse: null, userResponse: null };
axios.post = async (url, body) => {
  discord.tokenCalls.push({ url, body: Object.fromEntries(new URLSearchParams(body.toString())) });
  const r = discord.tokenResponse;
  if (r instanceof Error) throw r;
  return { data: r };
};
axios.get = async () => {
  const r = discord.userResponse;
  if (r instanceof Error) throw r;
  return { data: r };
};

function httpError(status, data) {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, data };
  return err;
}

function resetDiscord() {
  discord.tokenCalls = [];
  discord.tokenResponse = { access_token: "access-token-xyz", token_type: "Bearer" };
  discord.userResponse = { id: "555555555555555555", username: "tester", global_name: "Tester", avatar: null };
}

let server;
test.before(async () => {
  const app = express();
  app.set("trust proxy", 1);
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "..", "views"));
  app.use(session({
    name: config.session.cookieName,
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    store: new session.MemoryStore(),
    cookie: { secure: "auto", sameSite: config.session.sameSite, httpOnly: true, path: "/" }
  }));
  app.use(require("../routes/auth"));
  app.get("/me", (req, res) => res.json({ user: req.session.user || null }));
  server = await new Promise(resolve => {
    const s = app.listen(PORT, "127.0.0.1", () => resolve(s));
  });
});
test.after(() => server.close());

// Minimal browser: follows nothing, keeps the session cookie.
function browser() {
  let cookie = "";
  return {
    get cookie() { return cookie; },
    async get(url, headers = {}) {
      const res = await fetch(url.startsWith("http") ? url : PUBLIC_ORIGIN + url, {
        redirect: "manual",
        headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers }
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) {
        const pair = setCookie.split(";")[0];
        cookie = pair.endsWith("=") ? "" : pair;
      }
      return { status: res.status, location: res.headers.get("location"), setCookie, body: await res.text() };
    }
  };
}

async function startLogin(b, next) {
  const res = await b.get(`/auth/login${next ? "?next=" + encodeURIComponent(next) : ""}`);
  assert.strictEqual(res.status, 302);
  return new URL(res.location).searchParams.get("state");
}

test("config: DISCORD_OAUTH_URL is the single source for client id, callback and scopes", () => {
  assert.strictEqual(config.oauth2.clientId, CLIENT_ID);
  assert.strictEqual(config.oauth2.redirectUri, REDIRECT_URI);
  assert.deepStrictEqual(config.oauth2.scopes, ["identify", "guilds"]);
  assert.strictEqual(config.publicOrigin, PUBLIC_ORIGIN);
  assert.deepStrictEqual(config.validate().errors, []);
});

test("config: invalid OAuth URLs fail validation with clear messages", () => {
  const configPath = require.resolve("../config");
  const load = url => {
    process.env.DISCORD_OAUTH_URL = url;
    delete require.cache[configPath];
    const c = require(configPath);
    process.env.DISCORD_OAUTH_URL = CANONICAL_URL;
    delete require.cache[configPath];
    require(configPath);
    return c.validate().errors.join(" | ");
  };
  assert.match(load(""), /DISCORD_OAUTH_URL is not set/);
  assert.match(load("not a url"), /not a valid URL/);
  assert.match(load(CANONICAL_URL.replace("discord.com", "evil.example")), /must be a https:\/\/discord\.com/);
  assert.match(load(CANONICAL_URL.replace(`client_id=${CLIENT_ID}&`, "")), /no valid client_id/);
  assert.match(load(CANONICAL_URL.replace("response_type=code", "response_type=token")), /response_type=code/);
  assert.match(load(CANONICAL_URL.replace("scope=identify+guilds", "scope=guilds")), /identify/);
  assert.match(load(CANONICAL_URL + "&state=fixed"), /must not contain a state/);
  assert.match(load(CANONICAL_URL.replace(encodeURIComponent("/auth/callback"), encodeURIComponent("/callback"))), /redirect_uri must point/);
});

test("login redirects to the canonical Discord URL plus a fresh state", async () => {
  const b = browser();
  const res = await b.get("/auth/login");
  assert.strictEqual(res.status, 302);
  const target = new URL(res.location);
  const canonical = new URL(CANONICAL_URL);
  assert.strictEqual(target.origin + target.pathname, canonical.origin + canonical.pathname);
  for (const key of ["client_id", "response_type", "redirect_uri", "scope"]) {
    assert.strictEqual(target.searchParams.get(key), canonical.searchParams.get(key), key);
  }
  assert.match(target.searchParams.get("state"), /^[0-9a-f]{48}$/);
  assert.match(res.setCookie, /HttpOnly/i);
  assert.match(res.setCookie, /SameSite=Lax/i);
  assert.doesNotMatch(res.setCookie, /Secure/i, "plain-HTTP request must not get a Secure cookie");

  const second = await startLogin(browser());
  assert.notStrictEqual(second, target.searchParams.get("state"), "every login gets its own state");
});

test("login started on another host is moved to the callback host first", async () => {
  const res = await browser().get(`/auth/login?next=${encodeURIComponent("/donate")}`, { "X-Forwarded-Host": "13.143.223.68:3000" });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.location, `${PUBLIC_ORIGIN}/auth/login?next=%2Fdonate&canonical=1`);
  assert.strictEqual(res.setCookie, null, "no session is created on the wrong host");
});

test("login over HTTPS behind a proxy gets a Secure cookie", async () => {
  const res = await browser().get("/auth/login", { "X-Forwarded-Proto": "https" });
  assert.match(res.setCookie, /Secure/i);
});

test("successful login: code exchange, session rotation, redirect to the requested page", async () => {
  resetDiscord();
  const b = browser();
  const state = await startLogin(b, "/admin/dashboard");
  const preLoginCookie = b.cookie;

  const cb = await b.get(`/auth/callback?code=good-code&state=${state}`);
  assert.strictEqual(cb.status, 302);
  assert.strictEqual(cb.location, "/admin/dashboard");
  assert.notStrictEqual(b.cookie, preLoginCookie, "session id is regenerated after login");

  assert.strictEqual(discord.tokenCalls.length, 1);
  assert.deepStrictEqual(discord.tokenCalls[0].body, {
    client_id: CLIENT_ID,
    client_secret: "test-client-secret",
    grant_type: "authorization_code",
    code: "good-code",
    redirect_uri: REDIRECT_URI
  });

  const me = JSON.parse((await b.get("/me")).body);
  assert.strictEqual(me.user.id, "555555555555555555");
  assert.strictEqual(me.user.username, "tester");
  assert.strictEqual(me.user.isSuperuser, false);
  assert.ok(!("access_token" in me.user), "tokens are not kept in the session");

  // Refreshing the callback must not log the user out or re-use the code.
  const replay = await b.get(`/auth/callback?code=good-code&state=${state}`);
  assert.strictEqual(replay.status, 302);
  assert.strictEqual(replay.location, "/");
  assert.strictEqual(replay.setCookie, null);
  assert.strictEqual(discord.tokenCalls.length, 1);
  assert.strictEqual(JSON.parse((await b.get("/me")).body).user.id, "555555555555555555");

  // Visiting /auth/login or /login while logged in does not start another flow.
  assert.strictEqual((await b.get("/auth/login?next=%2Fdonate")).location, "/donate");
  assert.strictEqual((await b.get("/login")).location, "/");
});

test("two tabs can log in concurrently", async () => {
  resetDiscord();
  const b = browser();
  const first = await startLogin(b);
  const second = await startLogin(b);
  const cb = await b.get(`/auth/callback?code=tab1-code&state=${first}`);
  assert.strictEqual(cb.location, "/");
  assert.ok(JSON.parse((await b.get("/me")).body).user);
  assert.ok(second);
});

test("callback rejects missing, unknown and reused state", async () => {
  resetDiscord();
  const fresh = browser();
  assert.strictEqual((await fresh.get("/auth/callback?code=c1&state=abc")).location, "/login?error=state");

  const b = browser();
  await startLogin(b);
  assert.strictEqual((await b.get("/auth/callback?code=c2&state=" + "0".repeat(48))).location, "/login?error=state");

  assert.strictEqual((await browser().get("/auth/callback?state=x")).location, "/login?error=invalid");
  assert.strictEqual((await browser().get("/auth/callback?code=x")).location, "/login?error=invalid");
  assert.strictEqual(discord.tokenCalls.length, 0, "no code exchange without a valid state");
});

test("Discord errors leave the user logged out with an explanation", async () => {
  const cases = [
    ["denied", null, "/auth/callback?error=access_denied&state=s", "/login?error=denied"],
    ["expired code", httpError(400, { error: "invalid_grant" }), null, "/login?error=expired_code"],
    ["bad credentials", httpError(401, { error: "invalid_client" }), null, "/login?error=rejected"],
    ["discord down", Object.assign(new Error("timeout"), { code: "ECONNABORTED" }), null, "/login?error=discord_unavailable"],
    ["no token", { token_type: "Bearer" }, null, "/login?error=token"]
  ];
  let i = 0;
  for (const [name, tokenResponse, fixedUrl, expected] of cases) {
    resetDiscord();
    if (tokenResponse) discord.tokenResponse = tokenResponse;
    const b = browser();
    const state = await startLogin(b);
    const res = await b.get(fixedUrl || `/auth/callback?code=err-${i++}&state=${state}`);
    assert.strictEqual(res.location, expected, name);
    assert.strictEqual(JSON.parse((await b.get("/me")).body).user, null, name);
  }

  resetDiscord();
  discord.userResponse = httpError(401, { message: "401: Unauthorized" });
  const b = browser();
  const state = await startLogin(b, "/donate");
  assert.strictEqual((await b.get(`/auth/callback?code=user-fail&state=${state}`)).location, "/login?error=discord_unavailable&next=%2Fdonate");
});

test("login page shows the reason and keeps the destination", async () => {
  const res = await browser().get("/login?error=state&next=%2Fadmin%2Fdashboard");
  assert.strictEqual(res.status, 200);
  assert.match(res.body, /Giriş isteği doğrulanamadı/);
  assert.match(res.body, /href="\/auth\/login\?next=%2Fadmin%2Fdashboard"/);
});

test("logout destroys the session and clears the cookie", async () => {
  resetDiscord();
  const b = browser();
  const state = await startLogin(b);
  await b.get(`/auth/callback?code=logout-code&state=${state}`);
  const loggedInCookie = b.cookie;
  assert.ok(JSON.parse((await b.get("/me")).body).user);

  const out = await b.get("/auth/logout");
  assert.strictEqual(out.location, "/");
  assert.match(out.setCookie, /connect\.sid=;/);
  assert.strictEqual(JSON.parse((await b.get("/me")).body).user, null);

  // The old cookie is useless after logout.
  const res = await fetch(PUBLIC_ORIGIN + "/me", { headers: { Cookie: loggedInCookie } });
  assert.strictEqual((await res.json()).user, null);
});

test("post-login redirects only go to local paths", () => {
  assert.strictEqual(safeRedirectPath("/admin/dashboard#users"), "/admin/dashboard#users");
  for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "", undefined, "/auth/logout", "/login"]) {
    assert.strictEqual(safeRedirectPath(bad), "/", String(bad));
  }
});

test("OAuth codes and states are masked in logged URLs", () => {
  assert.strictEqual(redactUrl("/auth/callback?code=abc&state=def"), "/auth/callback?code=%5Bredacted%5D&state=%5Bredacted%5D");
  assert.strictEqual(redactUrl("/donate"), "/donate");
});
