const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

const SECRET = "unit-test-bridge-secret";
process.env.FIVEM_BRIDGE_SECRET = SECRET;
process.env.LOG_DIR = require("path").join(require("os").tmpdir(), "shield-test-logs");

const express = require("express");
const bridgeRouter = require("../routes/bridge");
const { fivem } = require("../services/fivemState");

function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = {};
    next();
  });
  app.use(bridgeRouter);
  return new Promise(resolve => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function sign(timestamp, body, secret = SECRET) {
  return crypto.createHmac("sha256", secret).update(timestamp + JSON.stringify(body)).digest("hex");
}

async function poll(server, body, headers) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/fivem/bridge/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}

test("bridge poll requires a valid, fresh HMAC signature", async () => {
  const server = await startApp();
  try {
    const body = { hello: "world" };
    const now = String(Date.now());

    assert.strictEqual((await poll(server, body, {})).status, 403);
    assert.strictEqual((await poll(server, body, { "x-bridge-timestamp": now, "x-bridge-signature": sign(now, body, "wrong") })).status, 403);

    const stale = String(Date.now() - 60000);
    assert.strictEqual((await poll(server, body, { "x-bridge-timestamp": stale, "x-bridge-signature": sign(stale, body) })).status, 403);

    fivem.commandQueue.push({ id: "c1", action: "revive" });
    const ok = await poll(server, body, { "x-bridge-timestamp": now, "x-bridge-signature": sign(now, body) });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.json.commands.map(c => c.id), ["c1"]);
    assert.strictEqual(fivem.commandQueue.length, 0, "queue is drained after delivery");
  } finally {
    server.close();
  }
});

test("panel bridge endpoints reject anonymous users", async () => {
  const server = await startApp();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/fivem/active-players`);
    assert.strictEqual(res.status, 401);
  } finally {
    server.close();
  }
});
