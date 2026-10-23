const chalk = require("chalk");
const mongoose = require("mongoose");
const session = require("express-session");
const MongoStore = require("connect-mongo").default;
const config = require("./config");
const { Streamer } = require("./models/ServerInfo");
const { systems, addLog, renderDashboard, printBanner, printStep } = require("./services/systemLog");
const { startEnabledBots, stopAll } = require("./services/botSupervisor");
const { seedDefaults, removeInvalidDiscordUsers } = require("./services/seed");
const streamerFetcher = require("./utils/streamerFetcher");
const { createApp } = require("./app");

const SESSION_TTL_SECONDS = 24 * 60 * 60;
const STREAMER_SYNC_INTERVAL_MS = 2 * 60 * 1000;
const STREAMER_FIRST_SYNC_DELAY_MS = 5000;

function step(prefix, text, color = chalk.cyan) {
  printStep(prefix, text, color);
}

function validateConfig() {
  const { errors, warnings } = config.validate();
  warnings.forEach(w => step("⚠", w, chalk.yellow));
  if (errors.length > 0) {
    errors.forEach(e => step("✖", e, chalk.red));
    console.error(chalk.red("\nYapılandırma hatası nedeniyle başlatma durduruldu. .env dosyasını kontrol edin (bkz. .env.example).\n"));
    process.exit(1);
  }
}

async function connectDatabase() {
  step("⚡", "MongoDB veritabanı bağlantısı başlatılıyor...", chalk.yellow);
  addLog("Orchestrator", "MongoDB veritabanı bağlantısı başlatılıyor...");
  try {
    systems.MongoDB.status = "CONNECTING";
    await mongoose.connect(config.mongodb.uri);
    systems.MongoDB.status = "ONLINE";
    systems.MongoDB.details = "Connected";
    addLog("MongoDB", "MongoDB veritabanı bağlantısı başarılı.");
    step("✔", "MongoDB veritabanı bağlantısı başarılı.", chalk.green);
    return true;
  } catch (err) {
    systems.MongoDB.status = "ERROR";
    systems.MongoDB.details = "Connection failed";
    addLog("MongoDB", `MongoDB bağlantısı başarısız: ${err.message}`, "error");
    step("✖", `MongoDB bağlantısı başarısız: ${err.message}`, chalk.red);
    return false;
  }
}

// Sessions live in MongoDB; without a database the gateway falls back to in-memory sessions.
function createSessionStore(dbOnline) {
  step("⚡", "MongoDB oturum deposu başlatılıyor...", chalk.yellow);
  if (dbOnline) {
    try {
      const store = MongoStore.create({ client: mongoose.connection.getClient(), collectionName: "sessions", ttl: SESSION_TTL_SECONDS });
      systems.SessionStore.status = "ONLINE";
      systems.SessionStore.details = "MongoDB Sessions";
      addLog("SessionStore", "MongoDB oturum deposu bağlantısı başarılı.");
      step("✔", "MongoDB oturum deposu bağlantısı başarılı.", chalk.green);
      return store;
    } catch (err) {
      systems.SessionStore.status = "ERROR";
      systems.SessionStore.details = "SessionStore error, using MemoryStore";
      addLog("SessionStore", `Oturum deposu başlatılamadı (MemoryStore kullanılıyor): ${err.message}`, "error");
      step("✖", `Oturum deposu başlatılamadı (MemoryStore kullanılıyor): ${err.message}`, chalk.red);
      return new session.MemoryStore();
    }
  }
  systems.SessionStore.status = "ERROR";
  systems.SessionStore.details = "MongoDB offline, using MemoryStore";
  addLog("SessionStore", "MongoDB çevrimdışı olduğundan MemoryStore kullanılıyor.", "error");
  step("✖", "MongoDB çevrimdışı olduğundan MemoryStore kullanılıyor.", chalk.red);
  return new session.MemoryStore();
}

async function prepareDatabase(dbOnline) {
  if (!dbOnline) {
    step("✖", "MongoDB çevrimdışı olduğundan veritabanı kontrolü atlandı.", chalk.red);
    return;
  }
  step("⚡", "Varsayılan veritabanı şemaları ve ayarları kontrol ediliyor...", chalk.yellow);
  addLog("Orchestrator", "Varsayılan veritabanı şemaları ve ayarları kontrol ediliyor...");
  try {
    await removeInvalidDiscordUsers();
    await seedDefaults();
    step("✔", "Varsayılan veritabanı şemaları ve ayarları doğrulandı.", chalk.green);
  } catch (err) {
    systems.MongoDB.status = "ERROR";
    systems.MongoDB.details = "Seed failed";
    addLog("MongoDB", `Varsayılan veriler hazırlanamadı: ${err.message}`, "error");
    step("✖", `Veritabanı kontrolü başarısız: ${err.message}`, chalk.red);
  }
}

async function startBots() {
  if (!config.gateway.spawnBots) {
    step("🤖", "Discord botları PM2 tarafından müstakil süreçler olarak yönetiliyor.");
    return;
  }
  try {
    step("⚡", "Aktif Discord bot süreçleri başlatılıyor...", chalk.yellow);
    addLog("Orchestrator", "Aktif Discord bot süreçleri başlatılıyor...");
    await startEnabledBots(step);
  } catch (err) {
    addLog("Orchestrator", `Botlar başlatılırken hata oluştu: ${err.message}`, "error");
    step("✖", `Botlar başlatılırken hata oluştu: ${err.message}`, chalk.red);
  }
}

function scheduleStreamerSync() {
  const sync = () => streamerFetcher.syncAllStreamers(Streamer).catch(err => console.error("Auto streamer sync error:", err.message));
  setInterval(sync, STREAMER_SYNC_INTERVAL_MS);
  setTimeout(sync, STREAMER_FIRST_SYNC_DELAY_MS);
}

function installProcessHandlers(server) {
  process.on("uncaughtException", err => {
    addLog("Orchestrator", `KRİTİK HATA (UncaughtException): ${err.stack || err.message}`, "error");
  });
  process.on("unhandledRejection", reason => {
    addLog("Orchestrator", `PROMISE REDDEDİLDİ (UnhandledRejection): ${reason instanceof Error ? reason.stack : reason}`, "error");
  });

  const shutdown = signal => {
    addLog("Orchestrator", `${signal} alındı, sistem kapatılıyor...`);
    stopAll();
    server.close(() => mongoose.disconnect().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", stopAll);
}

async function main() {
  console.clear();
  printBanner();
  validateConfig();

  const dbOnline = await connectDatabase();
  const sessionStore = createSessionStore(dbOnline);
  await prepareDatabase(dbOnline);

  const app = createApp({ sessionStore });
  const server = app.listen(config.gateway.port, async () => {
    systems.Gateway.status = "ONLINE";
    systems.Gateway.details = `Port ${config.gateway.port}`;
    addLog("Gateway", `Ağ geçidi port ${config.gateway.port} üzerinde aktif dinlemede.`);
    step("✔", `Ağ geçidi port ${config.gateway.port} üzerinde aktif dinlemede.`, chalk.green);

    await startBots();
    scheduleStreamerSync();
    renderDashboard();
  });
  server.on("error", err => {
    addLog("Gateway", `Ağ geçidi başlatılamadı: ${err.message}`, "error");
    step("✖", `Ağ geçidi başlatılamadı (port ${config.gateway.port}): ${err.message}`, chalk.red);
    process.exit(1);
  });
  installProcessHandlers(server);
}

main().catch(err => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
