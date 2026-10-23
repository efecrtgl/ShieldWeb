const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const { resolveSafePath, isSamePath } = require("../services/scriptFiles");
const { fivem, appendConsoleLogs, MAX_CONSOLE_LOGS, findOnlinePlayer, deletePlayerSql, queueCommand } = require("../services/fivemState");
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

test("deletePlayerSql escapes quotes and backslashes", () => {
  assert.strictEqual(deletePlayerSql("ABC123"), "DELETE FROM players WHERE citizenid = 'ABC123'");
  assert.strictEqual(deletePlayerSql("x' OR '1'='1"), "DELETE FROM players WHERE citizenid = 'x'' OR ''1''=''1'");
  assert.strictEqual(deletePlayerSql("a\\'b"), "DELETE FROM players WHERE citizenid = 'a\\\\''b'");
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

test("queueCommand assigns unique ids", () => {
  fivem.commandQueue.length = 0;
  const a = queueCommand("cmd_test", { action: "x" });
  const b = queueCommand("cmd_test", { action: "y" });
  assert.notStrictEqual(a.id, b.id);
  assert.match(a.id, /^cmd_test_\d+_\d+$/);
  assert.strictEqual(fivem.commandQueue.length, 2);
  fivem.commandQueue.length = 0;
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
