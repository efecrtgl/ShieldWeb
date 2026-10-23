const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "config.js");

// Loads config.js with a controlled environment (dotenv never overrides variables that are already set).
function loadConfig(env) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  delete require.cache[CONFIG_PATH];
  try {
    return require(CONFIG_PATH);
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("superusers merges SUPERUSERS and MASTER_USERS without duplicates", () => {
  const config = loadConfig({ SUPERUSERS: "111111111111111111, 222222222222222222", MASTER_USERS: "222222222222222222,333333333333333333" });
  assert.deepStrictEqual(config.superusers, ["111111111111111111", "222222222222222222", "333333333333333333"]);
  assert.strictEqual(config.isSuperuser("333333333333333333"), true);
  assert.strictEqual(config.isSuperuser("999"), false);
  assert.strictEqual(config.isSuperuser(undefined), false);
});

test("GATEWAY_PORT takes precedence over PORT", () => {
  assert.strictEqual(loadConfig({ GATEWAY_PORT: "4100", PORT: "4200" }).gateway.port, 4100);
  assert.strictEqual(loadConfig({ GATEWAY_PORT: "", PORT: "4200" }).gateway.port, 4200);
});

test("placeholder bot tokens are treated as missing", () => {
  const config = loadConfig({ BOT1_TOKEN: "placeholder", BOT2_TOKEN: "real-token" });
  assert.strictEqual(config.hasBotToken("verification"), false);
  assert.strictEqual(config.hasBotToken("logger"), true);
});

test("validate() fails without a session secret and warns on the old default", () => {
  assert.ok(loadConfig({ SESSION_SECRET: "" }).validate().errors.some(e => e.includes("SESSION_SECRET")));
  const weak = loadConfig({ SESSION_SECRET: "shield-software-session-secret-key" }).validate();
  assert.strictEqual(weak.errors.length, 0);
  assert.ok(weak.warnings.some(w => w.includes("SESSION_SECRET")));
});

test("config contains no hardcoded bot tokens", () => {
  const config = loadConfig({ BOT1_TOKEN: "", BOT2_TOKEN: "", BOT3_TOKEN: "", BOT4_TOKEN: "", BOT5_TOKEN: "" });
  for (const bot of Object.values(config.bots)) {
    assert.strictEqual(bot.token, "");
  }
});
