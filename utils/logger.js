const fs = require("fs");
const path = require("path");
const config = require("../config");

const DAY_MS = 24 * 60 * 60 * 1000;

class DailyRotateLogger {
  constructor({ logDir, maxDays }) {
    this.logDir = logDir;
    this.maxDays = maxDays;
    this.streams = new Map();
  }

  ensureDir() {
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  dateStamp(now = new Date()) {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  // One append stream per file name; streams for previous days are closed on rotation.
  getStream(filename, dateStr) {
    const current = this.streams.get(filename);
    if (current && current.dateStr === dateStr) return current.stream;
    if (current) current.stream.end();

    this.ensureDir();
    const stream = fs.createWriteStream(path.join(this.logDir, `${filename}-${dateStr}.log`), { flags: "a" });
    stream.on("error", err => console.error("[Logger System Failure]", err.message));
    this.streams.set(filename, { dateStr, stream });
    return stream;
  }

  writeLog(filename, level, system, message) {
    try {
      const dateStr = this.dateStamp();
      const timeStr = new Date().toLocaleTimeString("tr-TR");
      this.getStream(filename, dateStr).write(`[${dateStr} ${timeStr}] [${level.toUpperCase()}] [${system}] ${message}\n`);
    } catch (err) {
      console.error("[Logger System Failure]", err.message);
    }
  }

  info(system, message) {
    this.writeLog("app", "info", system, message);
  }

  error(system, message) {
    this.writeLog("error", "error", system, message);
    this.writeLog("app", "error", system, message);
  }

  cleanOldLogs() {
    try {
      if (!fs.existsSync(this.logDir)) return;
      const maxAgeMs = this.maxDays * DAY_MS;
      const now = Date.now();
      for (const file of fs.readdirSync(this.logDir)) {
        const filePath = path.join(this.logDir, file);
        if (now - fs.statSync(filePath).mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
        }
      }
    } catch (err) {
      console.error("[Logger] Old log cleanup failed:", err.message);
    }
  }
}

const logger = new DailyRotateLogger({ logDir: config.logging.dir, maxDays: config.logging.retentionDays });
logger.cleanOldLogs();

module.exports = logger;
