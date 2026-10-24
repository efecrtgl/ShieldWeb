const test = require("node:test");
const assert = require("node:assert");

process.env.SHIELD_BRIDGE_TEST = "1";
const resource = require("../shield-software/server.js");

function withNatives(natives, fn) {
  Object.assign(global, natives);
  return Promise.resolve(fn()).finally(() => {
    for (const key of Object.keys(natives)) delete global[key];
  });
}

test("amounts above the cap are rejected, never silently reduced", () => {
  assert.deepStrictEqual(resource.verifyAmount(5, 10), { value: 5 });
  assert.ok(resource.verifyAmount(11, 10).error);
  assert.ok(resource.verifyAmount(0, 10).error);
  assert.ok(resource.verifyAmount(2.5, 10).error);
  assert.ok(resource.verifyAmount("abc", 10).error);
});

test("unknown actions fail with a reason; legacy aliases map to the real handler", async () => {
  const unknown = await resource.executeBridgeCommand({ id: "x", action: "server_restart" });
  assert.strictEqual(unknown.ok, false);
  assert.match(unknown.error, /desteklemiyor/);
  assert.strictEqual(resource.ACTION_ALIASES.delete_item, "removeitem");
  assert.strictEqual(resource.ACTION_ALIASES.execute_raw, "execute_command");
  for (const target of Object.values(resource.ACTION_ALIASES)) {
    assert.ok(resource.COMMAND_HANDLERS[target], `alias target ${target} exists`);
  }
});

test("player commands fail when the player is not in game instead of reporting success", async () => {
  await withNatives({ GetResourceState: () => "missing", GetPlayerName: () => null }, async () => {
    for (const action of ["revive", "kill", "pedmenu", "teleport", "send_dm", "kick"]) {
      const result = await resource.executeBridgeCommand({ action, targetPlayer: "12", reason: "x", x: 1, y: 2, z: 3 });
      assert.strictEqual(result.ok, false, action);
    }
    const give = await resource.executeBridgeCommand({ action: "giveitem", targetPlayer: "12", item: "bread", amount: 1 });
    assert.strictEqual(give.ok, false);
  });
});

test("console commands are limited to resource control and announcements", async () => {
  const calls = [];
  await withNatives({
    GetCurrentResourceName: () => "shield-software",
    GetResourceState: name => (name === "ghost" ? "missing" : "stopped"),
    StartResource: name => { calls.push(["start", name]); return true; },
    StopResource: name => { calls.push(["stop", name]); return true; },
    TriggerClientEvent: () => {}
  }, () => {
    assert.strictEqual(resource.executeConsoleCommand({ command: "ensure qb-core" }).ok, true);
    assert.strictEqual(resource.executeConsoleCommand({ command: "restart shield-software" }).ok, false, "cannot restart itself");
    assert.strictEqual(resource.executeConsoleCommand({ command: "start ghost" }).ok, false, "missing resource is reported");
    assert.strictEqual(resource.executeConsoleCommand({ command: "start ../../etc" }).ok, false);
    assert.strictEqual(resource.executeConsoleCommand({ command: "quit" }).ok, false);
    assert.strictEqual(resource.executeConsoleCommand({ command: "say" }).ok, false, "empty announcement");
    assert.deepStrictEqual(calls, [["start", "qb-core"]]);
  });
});

test("inventory enrichment does not invent labels, images or counts", () => {
  const items = resource.enrichInventoryItems(JSON.stringify([{ name: "bread", amount: 2 }, { name: "mystery" }, null]), { bread: { label: "Ekmek", image: "bread.png" } });
  assert.strictEqual(items.length, 2);
  assert.deepStrictEqual([items[0].label, items[0].image, items[0].count], ["Ekmek", "bread.png", 2]);
  assert.deepStrictEqual([items[1].label, items[1].image, items[1].count], [null, null, null]);
  assert.deepStrictEqual(resource.enrichInventoryItems("not json", {}), []);
});

test("character payload leaves unknown values null", () => {
  const payload = resource.buildCharacterPayload({
    citizenid: "C1", cid: undefined, license: "", name: "", charinfo: {}, money: {}, job: null, gang: null,
    metadata: {}, inventory: [], identifiers: {}, vehicles: undefined, iban: null, skinModel: null, online: null, lastSeen: null
  });
  for (const key of ["cid", "name", "firstname", "skin_model", "iban", "job", "gang", "playtime", "discord", "last_seen"]) {
    assert.strictEqual(payload[key], null, key);
  }
  assert.strictEqual(payload.is_online, false);
  assert.deepStrictEqual(payload.vehicles, []);
});

test("bridge endpoints are derived from the configured poll URL", () => {
  resource.setConfig({ apiUrl: "https://panel.example.com/api/fivem/bridge/poll" });
  assert.strictEqual(resource.bridgeUrl("characters"), "https://panel.example.com/api/fivem/bridge/characters");
  assert.strictEqual(resource.bridgeUrl("shared-data"), "https://panel.example.com/api/fivem/bridge/shared-data");
});
