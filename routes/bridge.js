const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const mongoose = require("mongoose");
const multer = require("multer");
const config = require("../config");
const { PunishmentRecord, DiscordUser, FivemCharacter, DeletedCharacter } = require("../models/ServerInfo");
const { getUserPermissions, hasAnyPermission } = require("../services/permissions");
const { actorFrom, logAction } = require("../services/auditLog");
const { addLog } = require("../services/systemLog");
const {
  fivem, queueCommand, appendConsoleLogs, findOnlinePlayer, livePlayers, bridgeStatus,
  takeQueuedCommands, applyCommandResults, getCommand
} = require("../services/fivemState");
const { dispatchCommand, sendDispatchResult } = require("../services/fivemCommands");
const { clientIp } = require("../utils/http");
const { rateLimit } = require("../middleware/rateLimit");

const router = express.Router();

const MAX_SIGNATURE_AGE_MS = 30000;
const MAX_SCREEN_FRAME_BYTES = 10 * 1024 * 1024;
const MJPEG_IDLE_STOP_MS = 5000;
const SSE_IDLE_STOP_MS = 7000;
const SSE_HEARTBEAT_MS = 10000;
const MIN_SCREEN_INTERVAL_MS = 15;
const PERMA_BAN_EXPIRY = 2147483647;
// Shared data older than this is still shown, but flagged as stale (the bridge re-sends it every 10 minutes).
const SHARED_DATA_STALE_MS = 30 * 60 * 1000;

const screenUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_SCREEN_FRAME_BYTES } });

const BAN_DURATIONS = {
  "1_hour": [3600, "1 Saat"], "1h": [3600, "1 Saat"],
  "3_hours": [3 * 3600, "3 Saat"], "3h": [3 * 3600, "3 Saat"],
  "6_hours": [6 * 3600, "6 Saat"], "6h": [6 * 3600, "6 Saat"],
  "12_hours": [12 * 3600, "12 Saat"], "12h": [12 * 3600, "12 Saat"],
  "1_day": [86400, "1 Gün"], "1d": [86400, "1 Gün"],
  "3_days": [3 * 86400, "3 Gün"], "3d": [3 * 86400, "3 Gün"],
  "7_days": [7 * 86400, "7 Gün"], "7d": [7 * 86400, "7 Gün"],
  "14_days": [14 * 86400, "14 Gün"], "14d": [14 * 86400, "14 Gün"],
  "30_days": [30 * 86400, "30 Gün"], "30d": [30 * 86400, "30 Gün"]
};

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function isIpAllowed(ip) {
  if (ip === "127.0.0.1" || ip === "::1") return true;
  return config.fivemBridge.allowedIp.split(",").map(s => s.trim()).filter(Boolean).includes(ip);
}

// Signatures accepted within the freshness window; a repeated signature is a replayed request.
const seenSignatures = new Map();

function rememberSignature(signature, now) {
  for (const [sig, ts] of seenSignatures) {
    if (now - ts <= MAX_SIGNATURE_AGE_MS) break;
    seenSignatures.delete(sig);
  }
  if (seenSignatures.has(signature)) return false;
  seenSignatures.set(signature, now);
  return true;
}

// Authenticates game-server calls: allowed IP + HMAC-SHA256(timestamp + raw JSON body) with the shared secret,
// a timestamp within MAX_SIGNATURE_AGE_MS, and a signature that has not been used before.
function verifyBridgeRequest(req, res, next) {
  const ip = clientIp(req);
  if (!isIpAllowed(ip)) {
    addLog("sync", `FiveM Köprüsü: Reddedilen IP bağlantı denemesi: ${ip}`, "error");
    return res.status(403).json({ success: false, message: "Erişim reddedildi. Yetkisiz IP adresi." });
  }
  if (!config.fivemBridge.secretKey) {
    return res.status(503).json({ success: false, message: "Köprü yapılandırılmamış (FIVEM_BRIDGE_SECRET eksik)." });
  }

  const timestamp = req.headers["x-bridge-timestamp"];
  const signature = req.headers["x-bridge-signature"];
  if (!timestamp || !signature) {
    return res.status(403).json({ success: false, message: "Erişim reddedildi. Kimlik doğrulama başlıkları eksik." });
  }
  const now = Date.now();
  const drift = Math.abs(now - parseInt(timestamp, 10));
  if (isNaN(drift) || drift > MAX_SIGNATURE_AGE_MS) {
    return res.status(403).json({ success: false, message: "Erişim reddedildi. Geçersiz veya zaman aşımına uğramış zaman damgası." });
  }

  // app.js keeps the raw body for bridge routes; re-serializing is only a fallback for parsers that do not.
  const signedBody = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body);
  const expected = crypto.createHmac("sha256", config.fivemBridge.secretKey).update(timestamp + signedBody).digest("hex");
  if (!safeEqual(signature, expected)) {
    return res.status(403).json({ success: false, message: "Erişim reddedildi. Geçersiz imza." });
  }
  if (!rememberSignature(signature, now)) {
    addLog("sync", `FiveM Köprüsü: Tekrarlanan (replay) istek reddedildi. IP: ${ip}`, "error");
    return res.status(409).json({ success: false, message: "Bu istek daha önce işlendi." });
  }
  next();
}

// Session guard for panel endpoints. `flags` empty = any staff permission.
function requireStaff(flags = [], { status = 401, message = "Bu işlemi yapmak için yetkiniz bulunmamaktadır." } = {}) {
  return async (req, res, next) => {
    if (!req.session.user) {
      return status === 401 ? res.status(401).json({ success: false, message: "Oturum kapalı." }) : res.status(401).end();
    }
    const perms = await getUserPermissions(req.session.user);
    const allowed = flags.length === 0
      ? hasAnyPermission(perms)
      : perms && (perms.isSuperuser || flags.some(flag => perms[flag]));
    if (!allowed) {
      return status === 401 ? res.status(403).json({ success: false, message }) : res.status(403).end();
    }
    next();
  };
}

const SCREEN_FLAGS = ["fivemBridgeCommands", "viewUsers"];

function playerIdentifiers(player) {
  const identifiers = Array.isArray(player.identifiers) ? player.identifiers : [];
  const extract = prefix => {
    const match = identifiers.find(id => typeof id === "string" && id.toLowerCase().startsWith(prefix.toLowerCase() + ":"));
    if (match) return match.substring(match.indexOf(":") + 1);
    if (player[prefix] !== undefined && player[prefix] !== null) {
      const value = String(player[prefix]);
      return value.toLowerCase().startsWith(prefix.toLowerCase() + ":") ? value.substring(prefix.length + 1) : value;
    }
    return "";
  };
  return {
    identifiers,
    generalInfo: {
      fivem: extract("fivem"),
      discord: extract("discord") || (player.discordId ? String(player.discordId) : ""),
      license2: extract("license2"),
      license: extract("license"),
      steam: extract("steam"),
      xbl: extract("xbl") || extract("live"),
      ip: extract("ip")
    }
  };
}

// ---- Game server -> panel ---------------------------------------------------------------

function toPlayerList(players) {
  // Lua serializes an empty player table as {} and keyed tables as objects.
  if (Array.isArray(players)) return players.filter(p => p && typeof p === "object");
  if (players && typeof players === "object") return Object.values(players).filter(p => p && typeof p === "object");
  return [];
}

router.post("/api/fivem/bridge/poll", verifyBridgeRequest, (req, res) => {
  const body = req.body || {};
  if (body.status) {
    const wasOnline = bridgeStatus().online;
    fivem.lastPoll = Date.now();
    fivem.bridgeVersion = Number.isInteger(body.bridgeVersion) ? body.bridgeVersion : 1;
    fivem.activePlayers = toPlayerList(body.players);
    fivem.maxPlayers = Number.isInteger(body.maxPlayers) && body.maxPlayers > 0 ? body.maxPlayers : null;
    if (!wasOnline) {
      addLog("sync", `FiveM Köprüsü: Oyun sunucusu bağlandı (köprü sürümü ${fivem.bridgeVersion}, ${fivem.activePlayers.length} oyuncu).`, "info");
    }
  }
  applyCommandResults(body.results);
  if (Array.isArray(body.consoleLogs)) {
    appendConsoleLogs(...body.consoleLogs.filter(l => l && typeof l.text === "string").map(l => ({ type: String(l.type || "info"), text: l.text.slice(0, 2000) })));
  }
  res.json({ success: true, commands: takeQueuedCommands() });
});

function parseJsonField(value) {
  if (typeof value !== "string") return value && typeof value === "object" ? value : null;
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}

function finiteOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Maps a character payload from the bridge onto FivemCharacter fields. Only reported values are written: a field
// the bridge did not send is left out of the update (keeping the last known value) or stored as null on insert.
function normalizeCharacter(char, existingChar) {
  const money = parseJsonField(char.money) || {};
  const job = parseJsonField(char.job) || {};
  const info = parseJsonField(char.charinfo) || {};
  const meta = parseJsonField(char.metadata) || {};
  const grade = job.grade && typeof job.grade === "object" ? job.grade : {};

  const update = { lastUpdated: new Date() };
  const discordId = String(char.discord_id || char.discordId || char.discord || "").replace(/^discord:/, "");
  if (discordId) update.discordId = discordId;
  if (char.license) update.license = String(char.license).trim();
  const cid = finiteOrNull(char.cid);
  if (cid !== null) update.cid = cid;

  const firstname = info.firstname || char.firstname;
  const lastname = info.lastname || char.lastname;
  if (typeof firstname === "string") update.firstname = firstname;
  if (typeof lastname === "string") update.lastname = lastname;
  const birthdate = info.birthdate || char.birthdate;
  if (typeof birthdate === "string") update.birthdate = birthdate;

  const cash = finiteOrNull(money.cash);
  const bank = finiteOrNull(money.bank);
  if (cash !== null) update["money.cash"] = cash;
  if (bank !== null) update["money.bank"] = bank;

  if (stringOrNull(job.name)) {
    update["job.name"] = job.name.trim();
    update["job.label"] = stringOrNull(job.label);
    update["job.grade"] = stringOrNull(grade.name) || stringOrNull(grade.label) || (typeof job.grade === "string" ? stringOrNull(job.grade) : null);
    const level = finiteOrNull(grade.level !== undefined ? grade.level : grade.grade);
    update["job.gradeLevel"] = level !== null && Number.isInteger(level) ? level : null;
  }

  if (Array.isArray(char.inventory)) {
    update.inventory = char.inventory;
  } else if (typeof char.inventory === "string") {
    const inv = parseJsonField(char.inventory);
    if (Array.isArray(inv)) update.inventory = inv;
  }

  // Playtime only ever grows; a smaller or missing value keeps what we already know.
  const savedPlaytime = existingChar && typeof existingChar.playtime === "number" ? existingChar.playtime : 0;
  const incoming = [char.playtime, char.play_time, meta.playtime, meta.playTime].map(finiteOrNull).find(v => v !== null);
  if (incoming !== undefined && incoming > savedPlaytime) update.playtime = incoming;

  return update;
}

router.post("/api/fivem/bridge/characters", verifyBridgeRequest, async (req, res) => {
  const characters = Array.isArray(req.body.characters) ? req.body.characters.filter(c => c && typeof c.citizenid === "string" && c.citizenid.trim()) : null;
  if (!characters) {
    return res.status(400).json({ success: false, message: "characters dizisi bekleniyor." });
  }
  try {
    const citizenIds = characters.map(c => c.citizenid.trim());
    const [deleted, existing] = await Promise.all([
      DeletedCharacter.find({ citizenid: { $in: citizenIds } }, "citizenid").lean(),
      FivemCharacter.find({ citizenid: { $in: citizenIds } }, { citizenid: 1, playtime: 1 }).lean()
    ]);
    const deletedIds = new Set(deleted.map(d => d.citizenid));
    const existingById = new Map(existing.map(c => [c.citizenid, c]));

    const ops = [];
    for (const char of characters) {
      const citizenid = char.citizenid.trim();
      if (deletedIds.has(citizenid)) continue;
      ops.push({
        updateOne: {
          filter: { citizenid },
          update: { $set: normalizeCharacter(char, existingById.get(citizenid)) },
          upsert: true
        }
      });
    }
    if (ops.length > 0) await FivemCharacter.bulkWrite(ops, { ordered: false });
    if (deletedIds.size > 0) {
      addLog("sync", `FiveM Köprüsü: ${deletedIds.size} silinmiş karakter senkronizasyonda pas geçildi.`, "info");
    }
    res.json({ success: true, synced: ops.length, skipped: deletedIds.size });
  } catch (err) {
    addLog("sync", `FiveM Köprüsü: Karakter senkronizasyonu başarısız: ${err.message}`, "error");
    res.status(500).json({ success: false, message: "Karakterler kaydedilemedi." });
  }
});

function writeFileAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

const SHARED_DATA_KEYS = ["items", "jobs", "gangs", "vehicles"];

router.post("/api/fivem/bridge/shared-data", verifyBridgeRequest, (req, res) => {
  const data = { syncedAt: Date.now(), source: "fivem-bridge" };
  for (const key of SHARED_DATA_KEYS) {
    const value = req.body[key];
    // A missing collection is recorded as null (not reported), not as an empty list.
    data[key] = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  }
  try {
    writeFileAtomic(config.sharedDataPath, JSON.stringify(data, null, 2));
  } catch (err) {
    addLog("sync", `FiveM Köprüsü: Paylaşılan oyun verileri kaydedilemedi: ${err.message}`, "error");
    return res.status(500).json({ success: false, message: "Paylaşılan veriler kaydedilemedi." });
  }
  const counts = SHARED_DATA_KEYS.map(k => `${k}: ${data[k] ? Object.keys(data[k]).length : "yok"}`).join(", ");
  addLog("sync", `FiveM Köprüsü: Paylaşılan oyun verileri alındı (${counts}).`, "info");
  res.json({ success: true });
});

// Live screen frames uploaded by the game client for an active watch session (token-authenticated).
router.post("/api/fivem/screen/upload", screenUpload.single("file"), (req, res) => {
  const token = req.query.token || (req.body && req.body.token);
  const targetPlayer = String(req.query.targetPlayer || (req.body && req.body.targetPlayer) || "");
  if (!token || !targetPlayer) {
    return res.status(400).json({ success: false, message: "Geçersiz parametreler." });
  }
  const activeStream = fivem.activeScreenStreams.get(targetPlayer);
  if (!activeStream || !safeEqual(activeStream.token, token)) {
    return res.status(403).json({ success: false, message: "Geçersiz veya süresi dolmuş yayın oturumu." });
  }
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ success: false, message: "Görüntü verisi bulunamadı." });
  }

  const frame = { buffer: req.file.buffer, mime: req.file.mimetype || "image/jpeg", timestamp: Date.now() };
  fivem.liveScreenFrames.set(targetPlayer, frame);
  activeStream.lastFrameAt = Date.now();

  const subscribers = fivem.screenStreamSubscribers.get(targetPlayer);
  if (subscribers && subscribers.size > 0) {
    const payload = "data: " + JSON.stringify({ base64: frame.buffer.toString("base64"), mime: frame.mime, timestamp: frame.timestamp }) + "\n\n";
    for (const client of subscribers) {
      if (client.writableNeedDrain) continue;
      try {
        client.write(payload);
        if (typeof client.flush === "function") client.flush();
      } catch (err) {}
    }
  }

  const mjpegClients = fivem.mjpegClients.get(targetPlayer);
  if (mjpegClients && mjpegClients.size > 0) {
    const head = Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.buffer.length}\r\n\r\n`);
    for (const client of mjpegClients) {
      if (client.writableNeedDrain) continue;
      try {
        client.write(head);
        client.write(frame.buffer);
        client.write("\r\n");
      } catch (err) {}
    }
  }
  res.status(200).send("1");
});

// ---- Panel -> game server ---------------------------------------------------------------

router.get("/api/fivem/bridge/status", requireStaff(), (req, res) => {
  res.json({ success: true, bridge: bridgeStatus() });
});

router.get("/api/fivem/active-players", requireStaff(), (req, res) => {
  const bridge = bridgeStatus();
  const players = livePlayers();
  res.json({ success: true, bridge, playersCount: bridge.online ? players.length : null, players });
});

function resolveBan(duration, durationSeconds, durationText, isPerma) {
  const durStr = String(duration || "").toLowerCase().trim();
  if (durStr === "perma" || durStr === "kalici" || durStr === "0" || isPerma) {
    return { seconds: 0, label: "Kalıcı (Perma)", isPerma: true };
  }
  if (BAN_DURATIONS[durStr]) {
    const [seconds, label] = BAN_DURATIONS[durStr];
    return { seconds, label, isPerma: false };
  }
  if (!isNaN(Number(durationSeconds)) && Number(durationSeconds) > 0) {
    const seconds = Math.floor(Number(durationSeconds));
    return { seconds, label: durationText || `${Math.round(seconds / 3600)} Saat`, isPerma: false };
  }
  return null;
}

// Actions the panel may send through the generic command endpoint, with the fields each one needs.
const COMMAND_SPECS = {
  setjob: { fields: ["job", "grade"], log: b => ["fivemSetJob", `Setjob. Meslek: ${b.job}, Grade: ${b.grade}`] },
  setgang: { fields: ["gang", "grade"], log: b => ["fivemSetGang", `Setgang. Gang: ${b.gang}, Grade: ${b.grade}`] },
  giveitem: { fields: ["item", "amount"], log: b => ["fivemGiveItem", `Eşya verildi. Eşya: ${b.item}, Miktar: ${b.amount}`] },
  givemoney: { fields: ["type", "amount"], log: b => ["fivemGiveMoney", `Para verildi. Tip: ${b.type}, Miktar: ${b.amount}`] },
  pedmenu: { fields: [], log: () => ["fivemPedMenu", "Ped menüsü açıldı."] },
  kill: { fields: [], log: () => ["fivemKill", "Öldürüldü (kill)."] },
  revive: { fields: [], log: () => ["fivemRevive", "Canlandırıldı (revive)."] },
  send_dm: { fields: ["reason"], log: b => ["fivemSendDM", `DM gönderildi. Mesaj: ${b.reason}`] },
  pedver: { fields: ["ped"], log: b => ["fivemPedVer", `Ped verildi. Model: ${b.ped}`] },
  pedal: { fields: [], log: () => ["fivemPedAl", "Ped geri alındı."] },
  vreturn: { fields: [], log: b => ["fivemVReturn", `Araç çekildi (vreturn)${b.plate ? ", Plaka: " + b.plate : ""}`] },
  teleport: {
    fields: [],
    log: b => ["fivemTeleport", b.location ? `Oyuncu ışınlandı. Lokasyon: ${b.location}` : `Oyuncu ışınlandı. X:${b.x}, Y:${b.y}, Z:${b.z}`]
  },
  kick: { fields: ["reason"] },
  ban: { fields: ["reason"] },
  execute_command: { fields: ["command"], noTarget: true, log: b => ["fivemConsoleCommand", `Konsol komutu: ${b.command}`] }
};

const VALID_PLAYER_ID = /^\d{1,6}$/;

function validateCommandBody(action, b) {
  const spec = COMMAND_SPECS[action];
  if (!spec) return "Geçersiz veya desteklenmeyen eylem.";
  if (!spec.noTarget && !VALID_PLAYER_ID.test(String(b.targetPlayer ?? ""))) return "Geçerli bir hedef oyuncu ID'si gereklidir.";
  for (const field of spec.fields) {
    if (b[field] === undefined || b[field] === null || String(b[field]).trim() === "") return `Eksik alan: ${field}`;
  }
  if (["giveitem", "givemoney"].includes(action) && !(Number.isInteger(Number(b.amount)) && Number(b.amount) > 0)) return "Miktar pozitif bir tam sayı olmalıdır.";
  if (["setjob", "setgang"].includes(action) && !(Number.isInteger(Number(b.grade)) && Number(b.grade) >= 0)) return "Kademe 0 veya daha büyük bir tam sayı olmalıdır.";
  if (action === "givemoney" && !["cash", "bank", "crypto"].includes(b.type)) return "Para tipi cash, bank veya crypto olmalıdır.";
  if (action === "teleport" && !b.location && ![b.x, b.y, b.z].every(v => Number.isFinite(Number(v)) && String(v).trim() !== "")) return "Lokasyon veya geçerli X/Y/Z koordinatları gereklidir.";
  return null;
}

async function recordFivemKick(req, { discordId, playerName, reason }) {
  if (!discordId) return;
  await new PunishmentRecord({
    discordId,
    username: playerName || "Bilinmeyen Kullanıcı",
    punishments: [`Kick: ${reason}`],
    executorId: req.session.user.id || "system",
    executorUsername: req.session.user.username || "Web Panel",
    action: "FiveM Kick",
    reason,
    duration: "Anlık"
  }).save();
}

async function recordFivemBan(req, { discordId, playerName, reason }, ban) {
  const dUser = await DiscordUser.findOne({ discordId });
  if (dUser) {
    if (ban.isPerma) {
      dUser.isPermaBanned = true;
      dUser.isWhitelist = false;
    } else {
      dUser.wlCezaBitis = new Date(Date.now() + ban.seconds * 1000);
    }
    await dUser.save();
  }
  await new PunishmentRecord({
    discordId,
    username: playerName || (dUser ? dUser.username : "Bilinmeyen Kullanıcı"),
    punishments: [`FiveM Ban: ${reason} (${ban.label})`],
    isPerma: ban.isPerma,
    wlDaysAdded: ban.isPerma ? 0 : Math.round(ban.seconds / 86400),
    executorId: req.session.user.id || "system",
    executorUsername: req.session.user.username || "Web Panel",
    action: "FiveM Ban",
    reason,
    duration: ban.label
  }).save();
}

router.post("/api/fivem/bridge/command", requireStaff(["fivemBridgeCommands"]), rateLimit({ name: "bridge-command", windowMs: 60 * 1000, max: 60 }), async (req, res) => {
  const b = req.body || {};
  const action = typeof b.action === "string" ? b.action.trim() : "";
  const invalid = validateCommandBody(action, b);
  if (invalid) {
    return res.status(400).json({ success: false, message: invalid });
  }
  const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 500) : "";
  const targetPlayer = b.targetPlayer !== undefined && b.targetPlayer !== null ? String(b.targetPlayer) : undefined;

  let ban = null;
  if (action === "ban") {
    ban = resolveBan(b.duration, b.durationSeconds, b.durationText, !!b.isPerma);
    if (!ban) return res.status(400).json({ success: false, message: "Geçerli bir yasaklama süresi seçmek zorunludur." });
  }

  const adminUser = req.session.user.username || "Web Panel";
  const payload = {
    command: typeof b.command === "string" ? b.command.trim().slice(0, 500) : undefined,
    targetPlayer,
    citizenid: typeof b.citizenid === "string" ? b.citizenid : undefined,
    amount: b.amount !== undefined ? Number(b.amount) : undefined,
    reason,
    admin: adminUser,
    job: b.job,
    grade: b.grade !== undefined ? Number(b.grade) : undefined,
    ped: b.ped,
    gang: b.gang,
    item: b.item,
    type: b.type,
    x: b.x !== undefined ? Number(b.x) : undefined,
    y: b.y !== undefined ? Number(b.y) : undefined,
    z: b.z !== undefined ? Number(b.z) : undefined,
    location: b.location,
    plate: b.plate,
    playerName: b.playerName || "",
    discordId: b.discordId || "",
    license: b.license || ""
  };
  if (ban) {
    Object.assign(payload, {
      duration: ban.label,
      durationSeconds: ban.seconds,
      expire: ban.isPerma ? PERMA_BAN_EXPIRY : Math.floor(Date.now() / 1000) + ban.seconds,
      isPerma: ban.isPerma
    });
  }

  const result = await dispatchCommand(action, payload);
  addLog("sync", `FiveM Köprüsü: ${action} komutu (hedef: ${targetPlayer || "-"}) -> ${result.status}${result.ok ? "" : ": " + result.message}`, result.ok ? "info" : "error");
  if (!result.ok) return sendDispatchResult(res, result);

  let logEntry = COMMAND_SPECS[action].log ? COMMAND_SPECS[action].log(payload) : null;
  try {
    if (action === "kick") {
      logEntry = ["fivemKick", `Oyuncu sunucudan atıldı (Kick). Hedef: #${targetPlayer}, Sebep: ${reason}`];
      await recordFivemKick(req, { discordId: b.discordId, playerName: b.playerName, reason });
    } else if (action === "ban") {
      logEntry = ["fivemBan", `Oyuncu sunucudan yasaklandı (Ban). Hedef: #${targetPlayer}, Süre: ${ban.label}, Sebep: ${reason}`];
      if (b.discordId && b.syncDiscord !== false) {
        await recordFivemBan(req, { discordId: b.discordId, playerName: b.playerName, reason }, ban);
      }
    }
  } catch (err) {
    // The game-side action already happened; report the bookkeeping failure instead of hiding it.
    addLog("sync", `FiveM Köprüsü: ${action} ceza kaydı yazılamadı: ${err.message}`, "error");
    return sendDispatchResult(res, result, { message: `${result.message} Ancak ceza kaydı veritabanına yazılamadı.`, recordSaved: false });
  }

  if (logEntry) {
    logAction(logEntry[0], {
      executor: actorFrom(req),
      target: { id: targetPlayer || "", username: targetPlayer ? "FiveM ID: " + targetPlayer : "Sunucu" },
      details: `${logEntry[1]} (${result.confirmed ? "onaylandı" : "iletildi, doğrulanamadı"})`,
      context: "FiveM Koprusu"
    });
  }
  sendDispatchResult(res, result);
});

router.get("/display/d/api", async (req, res) => {
  if (!req.session.user) {
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  const perms = await getUserPermissions(req.session.user);
  if (!perms || !perms.isSuperuser) {
    return res.status(403).render("error", {
      status: 403,
      title: "Yetkisiz Erişim",
      message: "Bu sayfayı görüntülemek için Süper Yönetici yetkisine sahip olmalısınız.",
      user: req.session.user || null
    });
  }
  res.render("bridge_display", { user: req.session.user || null });
});

router.get("/api/fivem/bridge/queue", requireStaff(["fivemBridgeCommands"]), (req, res) => {
  const recent = [...fivem.commands.keys()].slice(-50).reverse().map(getCommand);
  res.json({ success: true, bridge: bridgeStatus(), queue: fivem.commandQueue, recent });
});

function charactersOf(discordId) {
  return FivemCharacter.find({ discordId: { $in: [discordId, `discord:${discordId}`] } }).sort({ cid: 1 });
}

router.get("/api/fivem/user-characters/:discordId", requireStaff(), async (req, res) => {
  try {
    res.json({ success: true, characters: await charactersOf(req.params.discordId) });
  } catch (err) {
    res.status(500).json({ success: false, message: "Karakterler alınamadı." });
  }
});

router.get("/api/fivem/player-detail/:discordId", requireStaff(), async (req, res) => {
  try {
    const discId = req.params.discordId;
    const serverId = req.query.serverId;
    const [discordUser, characters] = await Promise.all([
      DiscordUser.findOne({ discordId: discId }).populate("rankId").populate("teamId"),
      charactersOf(discId)
    ]);

    const found = livePlayers().find(p =>
      (serverId && String(p.id) === String(serverId)) ||
      (Array.isArray(p.identifiers) && p.identifiers.some(id => typeof id === "string" && (id === `discord:${discId}` || id === discId))) ||
      (p.discordId && String(p.discordId) === String(discId))
    );

    let onlinePlayer = null;
    if (found) {
      const { identifiers, generalInfo } = playerIdentifiers(found);
      generalInfo.discord = generalInfo.discord || discId;
      onlinePlayer = { id: found.id, name: found.name, ping: found.ping, coords: found.coords || null, discordId: generalInfo.discord, identifiers, generalInfo };
    }
    res.json({ success: true, bridge: bridgeStatus(), discordUser, characters, onlinePlayer });
  } catch (err) {
    res.status(500).json({ success: false, message: "Oyuncu detayı alınamadı." });
  }
});

// Deletes a character on the game server first; the panel copy is removed only once the game accepted the deletion.
router.post("/api/fivem/character/delete", requireStaff(["teamRemoveMember"]), async (req, res) => {
  try {
    const { characterId, citizenid } = req.body;
    if (!characterId && !citizenid) {
      return res.status(400).json({ success: false, message: "Karakter ID veya Citizen ID gereklidir." });
    }
    let character = characterId && mongoose.Types.ObjectId.isValid(characterId) ? await FivemCharacter.findById(characterId) : null;
    if (!character && citizenid) {
      character = await FivemCharacter.findOne({ citizenid: String(citizenid).trim() });
    }
    if (!character) {
      return res.status(404).json({ success: false, message: "Karakter bulunamadı." });
    }

    const charName = `${character.firstname || ""} ${character.lastname || ""}`.trim() || character.citizenid;
    const adminName = req.session.user.username || "Web Panel";
    const onlinePlayer = findOnlinePlayer({ discordId: character.discordId, citizenid: character.citizenid });

    // The bridge drops an online owner itself before deleting the rows.
    const result = await dispatchCommand("delete_character", {
      citizenid: character.citizenid,
      targetPlayer: onlinePlayer ? onlinePlayer.id : null,
      reason: "Karakter web paneli üzerinden silindi.",
      admin: adminName
    });
    if (!result.ok) return sendDispatchResult(res, result);

    // Remember the deletion so a later bridge sync does not re-create the character.
    await DeletedCharacter.updateOne(
      { citizenid: character.citizenid },
      { citizenid: character.citizenid, discordId: character.discordId || "", charName, deletedBy: adminName, deletedAt: new Date() },
      { upsert: true }
    );
    await FivemCharacter.deleteMany({ citizenid: character.citizenid });

    addLog("sync", `FiveM Köprüsü: Karakter silindi (${result.status}). Karakter: ${charName} (CitizenID: ${character.citizenid})`, "info");
    logAction("fivemCharacterDelete", {
      executor: actorFrom(req),
      target: { id: character._id, username: charName },
      details: `FiveM karakteri (${charName} - CID: ${character.citizenid}) silindi (${result.confirmed ? "oyun sunucusu onayladı" : "iletildi, doğrulanamadı"}).`,
      context: "Web Panel"
    });
    sendDispatchResult(res, result, { message: `"${charName}": ${result.message}`, targetDiscordId: character.discordId });
  } catch (err) {
    console.error("Delete character error:", err);
    res.status(500).json({ success: false, message: "Karakter silinirken veritabanı hatası oluştu." });
  }
});

router.get("/api/fivem/active-players-characters", requireStaff(), async (req, res) => {
  try {
    const bridge = bridgeStatus();
    const players = livePlayers().map(p => ({ player: p, ...playerIdentifiers(p) }));
    const discordIds = players.map(p => p.generalInfo.discord).filter(Boolean);
    const characters = discordIds.length ? await FivemCharacter.find({ discordId: { $in: discordIds } }, { discordId: 1, firstname: 1, lastname: 1 }).lean() : [];

    const namesByDiscordId = {};
    for (const c of characters) {
      (namesByDiscordId[c.discordId] = namesByDiscordId[c.discordId] || []).push(`${c.firstname} ${c.lastname}`.trim());
    }

    res.json({
      success: true,
      bridge,
      players: players.map(({ player, identifiers, generalInfo }) => ({
        id: player.id,
        name: player.name,
        ping: player.ping,
        coords: player.coords || null,
        discordId: generalInfo.discord || null,
        identifiers,
        generalInfo,
        characterNames: (generalInfo.discord && namesByDiscordId[generalInfo.discord]) || []
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Aktif oyuncular alınamadı." });
  }
});

// Items/jobs/gangs/vehicles exactly as last reported by the game server. Nothing is substituted when the bridge has
// never reported them: the response says so with available:false.
router.get("/api/fivem/shared-data", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ success: false, message: "Oturum kapalı." });
  }
  let data = null;
  try {
    if (fs.existsSync(config.sharedDataPath)) data = JSON.parse(fs.readFileSync(config.sharedDataPath, "utf8"));
  } catch (err) {
    addLog("sync", `Paylaşılan oyun verisi okunamadı: ${err.message}`, "error");
    return res.status(500).json({ success: false, available: false, message: "Kayıtlı oyun verisi okunamadı (dosya bozuk olabilir)." });
  }
  if (!data) {
    return res.json({
      success: true,
      available: false,
      message: "FiveM sunucusu henüz eşya/meslek verisi göndermedi.",
      items: null, jobs: null, gangs: null, vehicles: null, syncedAt: null, stale: null
    });
  }
  // Older files stored the sync time as "timestamp".
  const syncedAt = Number(data.syncedAt || data.timestamp) || null;
  res.json({
    success: true,
    available: true,
    items: data.items ?? null,
    jobs: data.jobs ?? null,
    gangs: data.gangs ?? null,
    vehicles: data.vehicles ?? null,
    syncedAt: syncedAt ? new Date(syncedAt).toISOString() : null,
    stale: !syncedAt || Date.now() - syncedAt > SHARED_DATA_STALE_MS,
    bridgeOnline: bridgeStatus().online
  });
});

// ---- Live screen watching ---------------------------------------------------------------

// Stops the in-game capture once nobody has been watching a player for `delayMs`.
function scheduleScreenStop(targetPlayer, subscriberMap, delayMs) {
  setTimeout(() => {
    const current = subscriberMap.get(targetPlayer);
    if (current && current.size > 0) return;
    fivem.activeScreenStreams.delete(targetPlayer);
    fivem.liveScreenFrames.delete(targetPlayer);
    queueCommand("cmd_screen_autostop", { action: "stop_screen_watch", targetPlayer });
  }, delayMs);
}

function subscribe(map, targetPlayer, res) {
  if (!map.has(targetPlayer)) map.set(targetPlayer, new Set());
  const set = map.get(targetPlayer);
  set.add(res);
  return set;
}

function disableNagle(req, res) {
  if (req.socket && typeof req.socket.setNoDelay === "function") req.socket.setNoDelay(true);
  if (res.socket && typeof res.socket.setNoDelay === "function") res.socket.setNoDelay(true);
}

const screenAccess = requireStaff(SCREEN_FLAGS, { status: 0 });

router.get("/api/fivem/screen/mjpeg/:id", screenAccess, (req, res) => {
  const targetPlayer = String(req.params.id);
  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  disableNagle(req, res);

  const existing = fivem.liveScreenFrames.get(targetPlayer);
  if (existing && existing.buffer) {
    res.write(Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${existing.buffer.length}\r\n\r\n`));
    res.write(existing.buffer);
    res.write("\r\n");
  }

  const set = subscribe(fivem.mjpegClients, targetPlayer, res);
  req.on("close", () => {
    set.delete(res);
    if (set.size === 0) scheduleScreenStop(targetPlayer, fivem.mjpegClients, MJPEG_IDLE_STOP_MS);
  });
});

router.get("/api/fivem/screen/stream/:id", screenAccess, (req, res) => {
  const targetPlayer = String(req.params.id);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  disableNagle(req, res);
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const subs = subscribe(fivem.screenStreamSubscribers, targetPlayer, res);
  const existingFrame = fivem.liveScreenFrames.get(targetPlayer);
  if (existingFrame) {
    res.write("data: " + JSON.stringify({ base64: existingFrame.buffer.toString("base64"), mime: existingFrame.mime, timestamp: existingFrame.timestamp }) + "\n\n");
  }

  const heartbeat = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch (err) {}
  }, SSE_HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    subs.delete(res);
    if (subs.size === 0) scheduleScreenStop(targetPlayer, fivem.screenStreamSubscribers, SSE_IDLE_STOP_MS);
  });
});

router.post("/api/fivem/screen/start", requireStaff(SCREEN_FLAGS), (req, res) => {
  const { targetPlayer, quality, interval } = req.body;
  if (!targetPlayer) {
    return res.status(400).json({ success: false, message: "Hedef oyuncu belirtilmedi." });
  }
  if (!bridgeStatus().online) {
    return res.status(503).json({ success: false, message: "FiveM sunucusu çevrimdışı; ekran izleme başlatılamaz." });
  }
  const targetPlayerStr = String(targetPlayer);
  const token = crypto.randomBytes(16).toString("hex");
  const parsedInterval = Math.max(MIN_SCREEN_INTERVAL_MS, parseInt(interval, 10) || 16);
  const parsedQuality = Math.min(0.85, Math.max(0.40, parseFloat(quality) || 0.60));

  fivem.activeScreenStreams.set(targetPlayerStr, {
    token,
    admin: req.session.user.username || "Admin",
    startedAt: Date.now(),
    interval: parsedInterval,
    quality: parsedQuality
  });

  const uploadUrl = `${config.siteUrl}/api/fivem/screen/upload?token=${token}&targetPlayer=${encodeURIComponent(targetPlayerStr)}`;
  queueCommand("cmd_screen_start", { action: "start_screen_watch", targetPlayer: targetPlayerStr, token, uploadUrl, interval: parsedInterval, quality: parsedQuality });
  addLog("sync", `FiveM Ekran İzleme: Oyuncu #${targetPlayerStr} için canlı ekran yayını başlatıldı (${req.session.user.username}).`, "info");

  res.json({ success: true, token, targetPlayer: targetPlayerStr, interval: parsedInterval, quality: parsedQuality });
});

router.post("/api/fivem/screen/stop", requireStaff(SCREEN_FLAGS), (req, res) => {
  const { targetPlayer } = req.body;
  if (targetPlayer) {
    const targetPlayerStr = String(targetPlayer);
    fivem.activeScreenStreams.delete(targetPlayerStr);
    fivem.liveScreenFrames.delete(targetPlayerStr);
    queueCommand("cmd_screen_stop", { action: "stop_screen_watch", targetPlayer: targetPlayerStr });
    addLog("sync", `FiveM Ekran İzleme: Oyuncu #${targetPlayerStr} için canlı ekran yayını durduruldu (${req.session.user.username}).`, "info");
  }
  res.json({ success: true });
});

router.get("/api/fivem/screen/latest/:id", requireStaff(SCREEN_FLAGS, { message: "Yetkisiz erişim." }), (req, res) => {
  const frame = fivem.liveScreenFrames.get(String(req.params.id));
  if (!frame) {
    return res.status(404).json({ success: false, message: "Görüntü karesi henüz mevcut değil." });
  }
  res.json({ success: true, base64: frame.buffer.toString("base64"), mime: frame.mime, timestamp: frame.timestamp });
});

module.exports = router;
