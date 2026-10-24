const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SECRET = "unit-test-bridge-secret";
process.env.FIVEM_BRIDGE_SECRET = SECRET;
process.env.LOG_DIR = path.join(os.tmpdir(), "shield-test-logs");
process.env.SHIELD_BRIDGE_TEST = "1";

const express = require("express");
const config = require("../config");
const { FivemCharacter, DeletedCharacter } = require("../models/ServerInfo");
const bridgeRouter = require("../routes/bridge");
const { fivem } = require("../services/fivemState");

// No database in unit tests: capture what the character sync would write.
const writes = { bulk: [] };
FivemCharacter.find = () => ({ lean: async () => [] });
DeletedCharacter.find = () => ({ lean: async () => [{ citizenid: "DELETED1" }] });
FivemCharacter.bulkWrite = async ops => { writes.bulk.push(...ops); return {}; };

config.sharedDataPath = path.join(os.tmpdir(), `shield-shared-${process.pid}.json`);

function startApp({ user = null } = {}) {
  const app = express();
  // Same raw-body capture as app.js.
  app.use(express.json({ verify: (req, res, buf) => { if (req.url.startsWith("/api/fivem/bridge/")) req.rawBody = buf; } }));
  app.use((req, res, next) => {
    req.session = user ? { user } : {};
    next();
  });
  app.use(bridgeRouter);
  return new Promise(resolve => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const url = (server, p) => `http://127.0.0.1:${server.address().port}${p}`;

function sign(timestamp, raw, secret = SECRET) {
  return crypto.createHmac("sha256", secret).update(timestamp + raw).digest("hex");
}

async function signedPost(server, p, body, { raw, secret, timestamp } = {}) {
  const data = raw !== undefined ? raw : JSON.stringify(body);
  const ts = timestamp || String(Date.now());
  const res = await fetch(url(server, p), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-bridge-timestamp": ts, "x-bridge-signature": sign(ts, data, secret) },
    body: data
  });
  return { status: res.status, json: await res.json() };
}

function resetBridge() {
  fivem.commandQueue = [];
  fivem.commands.clear();
  fivem.activePlayers = [];
  fivem.lastPoll = 0;
  fivem.bridgeVersion = null;
  fivem.maxPlayers = null;
}

test("bridge poll requires a valid, fresh, unused HMAC signature", async () => {
  resetBridge();
  const server = await startApp();
  try {
    const body = { hello: "world" };
    const raw = JSON.stringify(body);
    const noHeaders = await fetch(url(server, "/api/fivem/bridge/poll"), { method: "POST", headers: { "Content-Type": "application/json" }, body: raw });
    assert.strictEqual(noHeaders.status, 403);
    assert.strictEqual((await signedPost(server, "/api/fivem/bridge/poll", body, { secret: "wrong" })).status, 403);
    assert.strictEqual((await signedPost(server, "/api/fivem/bridge/poll", body, { timestamp: String(Date.now() - 60000) })).status, 403);

    const ts = String(Date.now());
    fivem.commandQueue.push({ id: "c1", action: "revive" });
    const first = await signedPost(server, "/api/fivem/bridge/poll", body, { timestamp: ts });
    assert.strictEqual(first.status, 200);
    assert.deepStrictEqual(first.json.commands.map(c => c.id), ["c1"]);
    assert.strictEqual(fivem.commandQueue.length, 0, "queue is drained after delivery");

    const replay = await signedPost(server, "/api/fivem/bridge/poll", body, { timestamp: ts });
    assert.strictEqual(replay.status, 409, "the same signed request cannot be replayed");
  } finally {
    server.close();
  }
});

test("signature is checked against the raw request bytes", async () => {
  resetBridge();
  const server = await startApp();
  try {
    // Whitespace that JSON.stringify would not reproduce: must still verify because the raw body is signed.
    const raw = '{ "status" : "active",  "players" : [] }';
    assert.strictEqual((await signedPost(server, "/api/fivem/bridge/poll", null, { raw })).status, 200);

    const ts = String(Date.now() + 1);
    const res = await fetch(url(server, "/api/fivem/bridge/poll"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-bridge-timestamp": ts, "x-bridge-signature": sign(ts, raw) },
      body: raw.replace("active", "hacked")
    });
    assert.strictEqual(res.status, 403, "tampered body is rejected");
  } finally {
    server.close();
  }
});

test("poll records bridge version, max players and the live player list", async () => {
  resetBridge();
  const server = await startApp();
  try {
    await signedPost(server, "/api/fivem/bridge/poll", { status: "active", bridgeVersion: 2, maxPlayers: 64, players: { a: { id: "3", name: "P" } } });
    assert.strictEqual(fivem.bridgeVersion, 2);
    assert.strictEqual(fivem.maxPlayers, 64);
    assert.deepStrictEqual(fivem.activePlayers.map(p => p.id), ["3"]);

    await signedPost(server, "/api/fivem/bridge/poll", { status: "active", players: [] });
    assert.strictEqual(fivem.bridgeVersion, 1, "a poll without bridgeVersion is a legacy bridge");
    assert.strictEqual(fivem.maxPlayers, null, "max players unknown when not reported");
  } finally {
    server.close();
  }
});

test("shared data is never substituted when the game server has not reported it", async () => {
  fs.rmSync(config.sharedDataPath, { force: true });
  const server = await startApp({ user: { id: "1", isSuperuser: true } });
  try {
    const empty = await (await fetch(url(server, "/api/fivem/shared-data"))).json();
    assert.strictEqual(empty.available, false);
    assert.strictEqual(empty.jobs, null);
    assert.strictEqual(empty.items, null);
    assert.strictEqual(fs.existsSync(config.sharedDataPath), false, "no placeholder file is written");

    const posted = await signedPost(server, "/api/fivem/bridge/shared-data", { items: { bread: { label: "Ekmek" } }, jobs: { police: { label: "LSPD" } } });
    assert.strictEqual(posted.status, 200);
    const data = await (await fetch(url(server, "/api/fivem/shared-data"))).json();
    assert.strictEqual(data.available, true);
    assert.deepStrictEqual(Object.keys(data.items), ["bread"]);
    assert.strictEqual(data.gangs, null, "a collection the server did not send stays unknown");
    assert.strictEqual(data.stale, false);
    assert.ok(data.syncedAt);
  } finally {
    server.close();
    fs.rmSync(config.sharedDataPath, { force: true });
  }
});

test("character sync stores only reported values and skips deleted characters", async () => {
  writes.bulk = [];
  const server = await startApp();
  try {
    const res = await signedPost(server, "/api/fivem/bridge/characters", {
      characters: [
        { citizenid: "ABC1", charinfo: { firstname: "Ali", lastname: "Kaya" }, money: { cash: 50 } },
        { citizenid: "JOB1", job: { name: "police", label: "LSPD", grade: { name: "Officer", level: 2 } } },
        { citizenid: "DELETED1", charinfo: { firstname: "X" } }
      ]
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.synced, 2);
    assert.strictEqual(res.json.skipped, 1);

    const byId = Object.fromEntries(writes.bulk.map(op => [op.updateOne.filter.citizenid, op.updateOne.update.$set]));
    assert.strictEqual(byId.ABC1.firstname, "Ali");
    assert.strictEqual(byId.ABC1["money.cash"], 50);
    assert.ok(!("money.bank" in byId.ABC1), "unknown bank balance is not written as 0");
    assert.ok(!("job.name" in byId.ABC1), "no job is invented when the bridge sent none");
    assert.ok(!("cid" in byId.ABC1));
    assert.strictEqual(byId.JOB1["job.label"], "LSPD");
    assert.strictEqual(byId.JOB1["job.grade"], "Officer");
    assert.strictEqual(byId.JOB1["job.gradeLevel"], 2);
    assert.ok(!byId.DELETED1);
  } finally {
    server.close();
  }
});

test("panel bridge endpoints reject anonymous users", async () => {
  const server = await startApp();
  try {
    assert.strictEqual((await fetch(url(server, "/api/fivem/active-players"))).status, 401);
    const cmd = await fetch(url(server, "/api/fivem/bridge/command"), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.strictEqual(cmd.status, 401);
  } finally {
    server.close();
  }
});

test("commands are refused while the game server is offline and validated before queueing", async () => {
  resetBridge();
  const server = await startApp({ user: { id: "1", username: "admin", isSuperuser: true } });
  const post = body => fetch(url(server, "/api/fivem/bridge/command"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const offline = await post({ action: "revive", targetPlayer: "5" });
    assert.strictEqual(offline.status, 503);
    assert.strictEqual(fivem.commandQueue.length, 0);

    assert.strictEqual((await post({ action: "drop_database" })).status, 400);
    assert.strictEqual((await post({ action: "giveitem", targetPlayer: "5", item: "bread", amount: -3 })).status, 400);
    assert.strictEqual((await post({ action: "revive", targetPlayer: "abc" })).status, 400);
    assert.strictEqual((await post({ action: "ban", targetPlayer: "5", reason: "x" })).status, 400, "ban needs a duration");

    const players = await (await fetch(url(server, "/api/fivem/active-players"))).json();
    assert.strictEqual(players.bridge.online, false);
    assert.strictEqual(players.playersCount, null);
  } finally {
    server.close();
  }
});

test("end to end: panel command -> resource poll -> execution -> reported result", async () => {
  resetBridge();
  const server = await startApp({ user: { id: "1", username: "admin", isSuperuser: true } });
  const resource = require("../shield-software/server.js");
  const announcements = [];
  Object.assign(global, {
    GetCurrentResourceName: () => "shield-software",
    GetResourceState: name => (name === "qb-core" ? "missing" : "started"),
    StartResource: () => true,
    StopResource: () => true,
    TriggerClientEvent: (name, target, payload) => announcements.push({ name, target, payload })
  });
  resource.setConfig({ apiUrl: url(server, "/api/fivem/bridge/poll"), secretKey: SECRET });

  const sendCommand = body => fetch(url(server, "/api/fivem/bridge/command"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  }).then(async r => ({ status: r.status, json: await r.json() }));

  try {
    await resource.pollServer();
    assert.strictEqual(fivem.bridgeVersion, resource.BRIDGE_VERSION, "the resource reports protocol v2");

    // Allowed command: the panel request resolves only after the resource reported success.
    const okPending = sendCommand({ action: "execute_command", command: "say Merhaba" });
    await new Promise(r => setTimeout(r, 50));
    await resource.pollServer();
    await new Promise(r => setTimeout(r, 200));
    await resource.pollServer();
    const ok = await okPending;
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.json.status, "succeeded");
    assert.strictEqual(ok.json.confirmed, true);
    assert.strictEqual(announcements[0].payload.args[1], "Merhaba");

    // Refused command: reported as failed with the resource's reason, not as success.
    const badPending = sendCommand({ action: "execute_command", command: "quit now" });
    await new Promise(r => setTimeout(r, 50));
    await resource.pollServer();
    await new Promise(r => setTimeout(r, 200));
    await resource.pollServer();
    const bad = await badPending;
    assert.strictEqual(bad.status, 422);
    assert.strictEqual(bad.json.success, false);
    assert.match(bad.json.message, /İzin verilmeyen komut/);
  } finally {
    server.close();
    for (const key of ["GetCurrentResourceName", "GetResourceState", "StartResource", "StopResource", "TriggerClientEvent"]) delete global[key];
  }
});
