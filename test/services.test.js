const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const { resolveSafePath, isSamePath } = require("../services/scriptFiles");
const state = require("../services/fivemState");
const { fivem, appendConsoleLogs, MAX_CONSOLE_LOGS, findOnlinePlayer, queueCommand } = state;
const { computeRankPermissions } = require("../services/permissions");

function resetBridge({ online = true, version = 2 } = {}) {
  fivem.commandQueue = [];
  fivem.commands.clear();
  fivem.activePlayers = [];
  fivem.lastPoll = online ? Date.now() : 0;
  fivem.bridgeVersion = version;
}
const { requiredAdminModule } = require("../middleware/siteContext");

test("resolveSafePath blocks traversal outside the base directory", () => {
  const base = path.join(os.tmpdir(), "shield-scripts-base");
  assert.strictEqual(resolveSafePath(base, "res/file.lua"), path.join(base, "res", "file.lua"));
  assert.strictEqual(resolveSafePath(base, ""), path.resolve(base));
  assert.strictEqual(resolveSafePath(base, "../outside.txt"), null);
  assert.strictEqual(resolveSafePath(base, "res/../../outside.txt"), null);
  assert.strictEqual(resolveSafePath(base + "-sibling", "../shield-scripts-base-sibling2/x"), null);
  assert.strictEqual(resolveSafePath(base, path.resolve(base, "..", "elsewhere")), null);
  assert.strictEqual(isSamePath(base, base + path.sep), true);
});

test("console log buffer stays bounded and keeps the newest lines", () => {
  fivem.consoleLogs = [];
  for (let i = 0; i < MAX_CONSOLE_LOGS + 25; i++) appendConsoleLogs({ type: "info", text: `line ${i}` });
  assert.strictEqual(fivem.consoleLogs.length, MAX_CONSOLE_LOGS);
  assert.strictEqual(fivem.consoleLogs[fivem.consoleLogs.length - 1].text, `line ${MAX_CONSOLE_LOGS + 24}`);
  appendConsoleLogs({ time: "12:00:00", type: "info", text: "bridge line" });
  assert.strictEqual(fivem.consoleLogs[fivem.consoleLogs.length - 1].time, "12:00:00");
});

test("findOnlinePlayer matches by discord identifier or citizen id", () => {
  resetBridge();
  fivem.activePlayers = [
    { id: 7, identifiers: ["license:abc", "discord:444578261494661122"] },
    { id: 9, citizenid: "CIT1", identifiers: [] }
  ];
  assert.strictEqual(findOnlinePlayer({ discordId: "444578261494661122" }).id, 7);
  assert.strictEqual(findOnlinePlayer({ discordId: "discord:444578261494661122" }).id, 7);
  assert.strictEqual(findOnlinePlayer({ citizenid: "CIT1" }).id, 9);
  assert.strictEqual(findOnlinePlayer({ discordId: "1" }), null);
  fivem.activePlayers = [];
});

test("a stale player list is not reported as live", () => {
  resetBridge();
  fivem.activePlayers = [{ id: 7, citizenid: "CIT7", identifiers: ["discord:444578261494661122"] }];
  assert.strictEqual(state.livePlayers().length, 1);
  fivem.lastPoll = Date.now() - state.BRIDGE_ONLINE_WINDOW_MS - 1;
  assert.deepStrictEqual(state.livePlayers(), []);
  assert.strictEqual(findOnlinePlayer({ citizenid: "CIT7" }), null);
  assert.strictEqual(state.onlineDiscordIds().size, 0);
  const status = state.bridgeStatus();
  assert.strictEqual(status.online, false);
  assert.strictEqual(status.playersCount, null, "offline player count is unknown, not 0");
  resetBridge();
});

test("command lifecycle: queued -> delivered -> succeeded/failed via bridge results", async () => {
  resetBridge();
  const ok = queueCommand("t", { action: "revive" });
  const bad = queueCommand("t", { action: "setjob" });
  const waitOk = state.waitForCommand(ok.id, 1000);
  const delivered = state.takeQueuedCommands();
  assert.deepStrictEqual(delivered.map(c => c.id), [ok.id, bad.id]);
  assert.strictEqual(state.getCommand(ok.id).status, "delivered");
  state.applyCommandResults([{ id: ok.id, ok: true }, { id: bad.id, ok: false, error: "no such job" }, { id: "unknown", ok: true }]);
  assert.strictEqual((await waitOk).status, "succeeded");
  assert.strictEqual(state.getCommand(bad.id).status, "failed");
  assert.strictEqual(state.getCommand(bad.id).error, "no such job");
  // A late duplicate result must not flip a final state.
  state.applyCommandResults([{ id: bad.id, ok: true }]);
  assert.strictEqual(state.getCommand(bad.id).status, "failed");
});

test("commands nobody picked up expire instead of running later", () => {
  resetBridge();
  const cmd = queueCommand("t", { action: "kill" });
  state.expireStaleCommands(Date.now() + state.COMMAND_TTL_MS + 1);
  assert.strictEqual(fivem.commandQueue.length, 0);
  assert.strictEqual(state.getCommand(cmd.id).status, "expired");
  assert.deepStrictEqual(state.takeQueuedCommands(), []);
});

test("legacy bridges settle at 'delivered' (outcome unknown, never reported as succeeded)", async () => {
  resetBridge({ version: 1 });
  const cmd = queueCommand("t", { action: "revive" });
  const wait = state.waitForCommand(cmd.id, 1000);
  state.takeQueuedCommands();
  const record = await wait;
  assert.strictEqual(record.status, "delivered");
  resetBridge();
});

test("dispatchCommand refuses to queue while the bridge is offline", async () => {
  const { dispatchCommand } = require("../services/fivemCommands");
  resetBridge({ online: false });
  const result = await dispatchCommand("kill", { targetPlayer: "1" });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, "offline");
  assert.strictEqual(result.httpStatus, 503);
  assert.strictEqual(fivem.commandQueue.length, 0);
  resetBridge();
});

test("character edit flags are only granted by the rank (regression: they were always true)", () => {
  const plain = computeRankPermissions([{ name: "Destek", permissions: { viewUsers: true } }]);
  for (const flag of ["charEditModal", "charEditName", "charEditBirthdate", "charEditMoney", "charEditJob"]) {
    assert.strictEqual(plain[flag], false, flag);
  }
  const moneyOnly = computeRankPermissions([{ name: "Destek", permissions: { charEditModal: true, charEditMoney: true } }]);
  assert.strictEqual(moneyOnly.charEditMoney, true);
  assert.strictEqual(moneyOnly.charEditJob, false);
  const editor = computeRankPermissions([{ name: "Destek", permissions: { editUsers: true } }]);
  assert.strictEqual(editor.charEditJob, true, "editUsers still implies character editing");
});

test("queueCommand assigns unique ids", () => {
  resetBridge();
  const a = queueCommand("cmd_test", { action: "x" });
  const b = queueCommand("cmd_test", { action: "y" });
  assert.notStrictEqual(a.id, b.id);
  assert.match(a.id, /^cmd_test_\d+_[0-9a-f]+$/);
  assert.strictEqual(fivem.commandQueue.length, 2);
  resetBridge();
});

test("admin module guard maps URLs to the same modules as before the refactor", () => {
  const cases = {
    "/api/users": "admin_users",
    "/users/whitelist/add/1": "admin_users",
    "/users/whitelist/action-by-id": "admin_users",
    "/users/discord-ban": "admin_users",
    "/users/discord-unban/1": "admin_banned",
    "/users/punish": "admin_punishments",
    "/users/punish/history/1": "admin_punishments",
    "/users/blacklist/add": "admin_blacklist",
    "/teams/add": "admin_teams",
    "/submissions/review/1": "admin_applications",
    "/add-update": "admin_updates",
    "/updates/edit/1": "admin_updates",
    "/donate/items/add": "admin_donate",
    "/ranks/sync-all": "admin_ranks",
    "/bots/mass-presence": "admin_bots",
    "/website/faq/add": "admin_faq",
    "/website/gallery/reorder": "admin_gallery",
    "/settings/theme": "admin_theme",
    "/server/status": null,
    "/businesses/add": null
  };
  for (const [url, expected] of Object.entries(cases)) {
    assert.strictEqual(requiredAdminModule(url), expected, url);
  }
});

test("website backup never includes secrets, dependencies or VCS data", () => {
  const { includeInBackup } = require("../routes/admin/developer");
  assert.strictEqual(includeInBackup("app.js"), true);
  assert.strictEqual(includeInBackup("shield-software/server.js"), true);
  assert.strictEqual(includeInBackup("shield-software/config.json"), false);
  assert.strictEqual(includeInBackup("shield-software\\config.json"), false);
  assert.strictEqual(includeInBackup(".env"), false);
  assert.strictEqual(includeInBackup(".env.production"), false);
  assert.strictEqual(includeInBackup("node_modules/express/index.js"), false);
  assert.strictEqual(includeInBackup(".git/config"), false);
});

test("health endpoints: liveness always ok, readiness follows the database", async () => {
  resetBridge({ online: false });
  const express = require("express");
  const app = express();
  app.use(require("../routes/health"));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const live = await fetch(`${base}/healthz`);
    assert.strictEqual(live.status, 200);
    const ready = await fetch(`${base}/readyz`);
    const body = await ready.json();
    assert.strictEqual(ready.status, 503, "no database connection in unit tests");
    assert.strictEqual(body.checks.mongodb, "down");
    assert.strictEqual(body.info.fivemBridge, "never_connected");
  } finally {
    server.close();
  }
});
