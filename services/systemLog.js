const chalk = require("chalk");
const Table = require("cli-table3");
const config = require("../config");
const fileLogger = require("../utils/logger");
const { timeTr } = require("../utils/format");

const MAX_BUFFERED_LOGS = 200;
const CONSOLE_KEYWORDS = ["YAPAN:", "İŞLEM:", "BAŞARILI", "BAŞLATILDI", "VERİTABANI", "DİNLEYİCİ"];

// Status table shown in the terminal dashboard and on the admin overview page.
const systems = {
  Orchestrator: { name: "Yönlendirici (Orchestrator)", status: "ONLINE", pid: process.pid, details: "Ana Süreç", logCount: 0, color: chalk.yellow },
  Gateway: { name: "Ağ Geçidi (Gateway)", status: "OFFLINE", pid: process.pid, details: `Port ${config.gateway.port}`, logCount: 0, color: chalk.blue },
  SessionStore: { name: "Oturum Deposu (MongoDB)", status: "CONNECTING", pid: "-", details: "connect-mongo", logCount: 0, color: chalk.red },
  MongoDB: { name: "MongoDB Veritabanı", status: "CONNECTING", pid: "-", details: "MongoDB", logCount: 0, color: chalk.green },
  verification: { name: "Bot 1 (Doğrulama)", status: "OFFLINE", pid: "-", details: "Bot Süreci", logCount: 0, color: chalk.cyan },
  logger: { name: "Bot 2 (Loglama)", status: "OFFLINE", pid: "-", details: "Bot Süreci", logCount: 0, color: chalk.magenta },
  moderation: { name: "Bot 3 (Moderasyon)", status: "OFFLINE", pid: "-", details: "Bot Süreci", logCount: 0, color: chalk.gray },
  sync: { name: "Bot 4 (Senkronizasyon)", status: "OFFLINE", pid: "-", details: "Bot Süreci", logCount: 0, color: chalk.white },
  management: { name: "Bot 5 (Yönetim)", status: "OFFLINE", pid: "-", details: "Bot Süreci", logCount: 0, color: chalk.blue }
};

const logs = [];

function pushLog(line) {
  logs.push(line);
  if (logs.length > MAX_BUFFERED_LOGS) logs.shift();
}

const STATUS_LABELS = {
  ONLINE: chalk.bold.green("🟢 ONLINE"),
  CONNECTING: chalk.bold.yellow("⚡ CONNECTING"),
  ERROR: chalk.bold.red("✖ HATA")
};

function printBanner() {
  console.log("\n" + chalk.bold.magenta("================================================================================="));
  console.log(chalk.bold.cyan("           🚀 SHIELD SOFTWARE ALTYAPI KONTROL VE YÖNETİM MERKEZİ                "));
  console.log(chalk.bold.magenta("================================================================================="));
}

function renderDashboard() {
  try {
    const table = new Table({
      head: ["Sistem / Servis", "Durum", "PID", "Detaylar", "Log Sayısı"].map(h => chalk.bold.cyan(h)),
      colWidths: [30, 16, 10, 24, 12]
    });
    for (const sys of Object.values(systems)) {
      table.push([
        sys.color ? sys.color(sys.name) : sys.name,
        STATUS_LABELS[sys.status] || chalk.bold.red("🔴 OFFLINE"),
        chalk.gray(sys.pid || "-"),
        chalk.white(sys.details || "-"),
        chalk.yellow(sys.logCount || 0)
      ]);
    }
    printBanner();
    console.log(table.toString() + "\n");
  } catch (err) {
    console.error("[Dashboard] Render failed:", err.message);
  }
}

function printStep(prefix, text, color = chalk.cyan) {
  console.log(color(`   ${prefix}  ${chalk.bold(text)}`));
}

// Records a log line for a subsystem: always to the log file, to the console only for important events.
function addLog(system, message, type = "info") {
  const sysInfo = systems[system];
  const sysName = sysInfo ? sysInfo.name : system;
  const sysColor = sysInfo ? sysInfo.color : chalk.white;

  String(message).split("\n").forEach(rawLine => {
    const line = rawLine.trim();
    if (!line) return;
    if (sysInfo) sysInfo.logCount += 1;

    const formatted = `[${chalk.gray(timeTr())}] [${chalk.bold(sysColor(sysName))}] ${type === "error" ? chalk.bold.red(line) : chalk.bold(line)}`;
    pushLog(formatted);

    if (type === "error") {
      fileLogger.error(sysName, line);
    } else {
      fileLogger.info(sysName, line);
    }

    const upper = line.toUpperCase();
    if (type === "error" || CONSOLE_KEYWORDS.some(k => upper.includes(k))) {
      console.log(formatted);
    }
  });
}

// Console trail of an action performed by a panel user (or a system actor string).
function logUserAction(req, actionName, targetDetails = "") {
  let userInfo = "Sistem / Otomatik";
  if (req && req.session && req.session.user) {
    const u = req.session.user;
    userInfo = `${u.username || u.global_name || "Kullanıcı"} (${u.id})`;
  } else if (typeof req === "string") {
    userInfo = req;
  }
  const targetStr = targetDetails ? ` 🎯 [HEDEF: ${chalk.bold.green(targetDetails)}]` : "";
  const formatted = `[${chalk.gray(timeTr())}] 👤 [YAPAN: ${chalk.bold.cyan(userInfo)}] ⚡ [İŞLEM: ${chalk.bold.yellow(actionName)}]${targetStr}`;
  pushLog(formatted);
  console.log(formatted);
}

module.exports = { systems, logs, addLog, logUserAction, renderDashboard, printBanner, printStep };
