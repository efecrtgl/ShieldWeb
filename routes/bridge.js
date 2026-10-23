const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const mongoose = require("mongoose");
const multer = require("multer");
const config = require("../config");
const { ServerStats, PunishmentRecord, DiscordUser, FivemCharacter, DeletedCharacter } = require("../models/ServerInfo");
const { getUserPermissions, hasAnyPermission } = require("../services/permissions");
const { actorFrom, logAction } = require("../services/auditLog");
const { addLog } = require("../services/systemLog");
const { fivem, queueCommand, appendConsoleLogs, findOnlinePlayer, queueCharacterDeletion } = require("../services/fivemState");
const { clientIp } = require("../utils/http");

const router = express.Router();

const MAX_SIGNATURE_AGE_MS = 30000;
const MAX_SCREEN_FRAME_BYTES = 10 * 1024 * 1024;
const MJPEG_IDLE_STOP_MS = 5000;
const SSE_IDLE_STOP_MS = 7000;
const SSE_HEARTBEAT_MS = 10000;
const MIN_SCREEN_INTERVAL_MS = 15;
const DEFAULT_BAN_SECONDS = 3 * 86400;
const PERMA_BAN_EXPIRY = 2147483647;

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

const DEFAULT_SHARED_DATA = {
  items: {
    phone: { name: "phone", label: "Telefon", weight: 150, type: "item", unique: true, useable: true, image: "phone.png", description: "Akıllı telefon" },
    water_bottle: { name: "water_bottle", label: "Su Şişesi", weight: 500, type: "item", unique: false, useable: true, image: "water.png", description: "Temiz içme suyu" },
    sandwich: { name: "sandwich", label: "Sandviç", weight: 200, type: "item", unique: false, useable: true, image: "sandwich.png", description: "Lezzetli bir sandviç" },
    lockpick: { name: "lockpick", label: "Maymuncuk", weight: 100, type: "item", unique: false, useable: true, image: "lockpick.png", description: "Kilitleri açmaya yarar" }
  },
  jobs: {
    unemployed: { label: "İşsiz", grades: { 0: { name: "İşsiz", payment: 50 } } },
    police: { label: "Polis Departmanı", grades: { 0: { name: "Memur", payment: 500 }, 1: { name: "Çavuş", payment: 700 }, 2: { name: "Şerif", payment: 1000 } } },
    ambulance: { label: "Sağlık Bakanlığı", grades: { 0: { name: "Asistan", payment: 450 }, 1: { name: "Paramedik", payment: 650 }, 2: { name: "Doktor", payment: 950 } } }
  },
  gangs: {
    none: { label: "Yok", grades: { 0: { name: "Yok" } } },
    ballas: { label: "Ballas", grades: { 0: { name: "Üye" }, 1: { name: "Lider" } } },
    vagos: { label: "Vagos", grades: { 0: { name: "Üye" }, 1: { name: "Lider" } } }
  },
  vehicles: {
    adder: { name: "Adder", brand: "Truffade", price: 1000000, category: "super" },
    t20: { name: "T20", brand: "Progen", price: 2200000, category: "super" },
    zentorno: { name: "Zentorno", brand: "Pegassi", price: 750000, category: "super" },
    sultan: { name: "Sultan", brand: "Karin", price: 35000, category: "sports" }
  }
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

// Authenticates game-server calls: allowed IP + HMAC-SHA256(timestamp + JSON body) with the shared secret.
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
  const drift = Math.abs(Date.now() - parseInt(timestamp, 10));
  if (isNaN(drift) || drift > MAX_SIGNATURE_AGE_MS) {
    return res.status(403).json({ success: false, message: "Erişim reddedildi. Geçersiz veya zaman aşımına uğramış zaman damgası." });
  }

  const expected = crypto.createHmac("sha256", config.fivemBridge.secretKey).update(timestamp + JSON.stringify(req.body)).digest("hex");
  if (!safeEqual(signature, expected)) {
    return res.status(403).json({ success: false, message: "Erişim reddedildi. Geçersiz imza." });
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
      license2: extract("license2") || extract("licanse2"),
      license: extract("license") || extract("licanse"),
      steam: extract("steam"),
      xbl: extract("xbl") || extract("live"),
      ip: extract("ip") || (player.endpoint ? String(player.endpoint).split(":")[0] : "") || (player.ip ? String(player.ip) : "")
    }
  };
}

// ---- Game server -> panel ---------------------------------------------------------------

router.post("/api/fivem/bridge/poll", verifyBridgeRequest, async (req, res) => {
  if (req.body && req.body.status) {
    fivem.lastPoll = Date.now();
    addLog("sync", `FiveM Köprüsü: Oyun sunucusu durumu alındı. Aktif oyuncu: ${req.body.playersCount || 0}`, "info");
    const { players } = req.body;
    if (players) {
      // Lua serializes an empty player table as {} and keyed tables as objects.
      fivem.activePlayers = Array.isArray(players) ? players : (typeof players === "object" ? Object.values(players) : []);
    }
    try {
      await ServerStats.updateOne({}, { activePlayers: req.body.playersCount || 0 }, { upsert: true });
    } catch (err) {
      addLog("sync", `FiveM Köprüsü: İstatistik güncellenirken hata: ${err.message}`, "error");
    }
  }

  if (req.body && Array.isArray(req.body.consoleLogs)) {
    appendConsoleLogs(...req.body.consoleLogs);
  }

  const commands = fivem.commandQueue.splice(0, fivem.commandQueue.length);
  res.json({ success: true, commands });
});

function parseJsonField(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}

// Normalizes a QBCore/ESX "players" row sent by the bridge into a FivemCharacter update.
function normalizeCharacter(char, existingChar) {
  const money = parseJsonField(char.money) || {};
  const job = parseJsonField(char.job) || {};
  const info = parseJsonField(char.charinfo) || {};
  const meta = parseJsonField(char.metadata) || {};

  let firstname = info.firstname || char.firstname || "";
  let lastname = info.lastname || char.lastname || "";
  if (!firstname && !lastname && char.name) {
    const parts = String(char.name).split(" ");
    firstname = parts[0] || "Karakter";
    lastname = parts.slice(1).join(" ");
  }
  if (!firstname && !lastname) {
    firstname = "Karakter";
    lastname = char.citizenid || "";
  }

  const savedPlaytime = existingChar && typeof existingChar.playtime === "number" ? existingChar.playtime : 0;
  const incomingPlaytime = [char.playtime, char.play_time, meta.playtime, meta.playTime]
    .find(v => v !== undefined && v !== null && !isNaN(Number(v)));
  const playtime = incomingPlaytime !== undefined && Number(incomingPlaytime) > savedPlaytime ? Number(incomingPlaytime) : savedPlaytime;

  let inventory = [];
  if (typeof char.inventory === "string") {
    inventory = parseJsonField(char.inventory) || [];
  } else if (Array.isArray(char.inventory)) {
    inventory = char.inventory;
  }

  return {
    discordId: String(char.discord || "").replace(/^discord:/, ""),
    license: char.license ? String(char.license).trim() : (existingChar && existingChar.license ? existingChar.license : ""),
    cid: char.cid || 1,
    firstname,
    lastname,
    birthdate: info.birthdate || char.birthdate || "",
    money: { cash: money.cash || 0, bank: money.bank || 0 },
    job: {
      name: job.name || "unemployed",
      label: job.label || "Civilian",
      grade: (job.grade && (job.grade.name || job.grade.label)) || "Freelancer"
    },
    inventory,
    playtime,
    lastUpdated: new Date()
  };
}

router.post("/api/fivem/bridge/characters", verifyBridgeRequest, async (req, res) => {
  const characters = req.body.characters;
  if (Array.isArray(characters)) {
    const deletedCitizenIds = new Set((await DeletedCharacter.find({}, "citizenid").lean()).map(d => d.citizenid));
    for (const char of characters) {
      if (!char || !char.citizenid) continue;
      if (deletedCitizenIds.has(char.citizenid)) {
        addLog("sync", `FiveM Köprüsü: Silinmiş karakter pas geçildi (CitizenID: ${char.citizenid})`, "info");
        continue;
      }
      const existingChar = await FivemCharacter.findOne({ citizenid: char.citizenid });
      await FivemCharacter.findOneAndUpdate({ citizenid: char.citizenid }, normalizeCharacter(char, existingChar), { upsert: true });
    }
    addLog("sync", `FiveM Köprüsü: ${characters.length} adet karakter senkronize edildi.`, "info");
  }
  res.json({ success: true });
});

router.post("/api/fivem/bridge/shared-data", verifyBridgeRequest, (req, res) => {
  const data = {
    items: req.body.items || {},
    jobs: req.body.jobs || {},
    gangs: req.body.gangs || {},
    vehicles: req.body.vehicles || {},
    timestamp: Date.now()
  };
  fs.writeFileSync(config.sharedDataPath, JSON.stringify(data, null, 2), "utf8");
  addLog("sync", "FiveM Köprüsü: Paylaşılan oyun verileri (items, jobs, gangs, vehicles) başarıyla senkronize edildi.", "info");
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

router.get("/api/fivem/active-players", requireStaff(), (req, res) => {
  res.json({ success: true, playersCount: fivem.activePlayers.length, players: fivem.activePlayers });
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
    const seconds = Number(durationSeconds);
    return { seconds, label: durationText || `${Math.round(seconds / 3600)} Saat`, isPerma: false };
  }
  return { seconds: DEFAULT_BAN_SECONDS, label: "3 Gün", isPerma: false };
}

const COMMAND_LOG_DESCRIPTIONS = {
  setjob: b => ["fivemSetJob", `Setjob atildi. Meslek: ${b.job}, Grade: ${b.grade}`],
  setgang: b => ["fivemSetGang", `Setgang atildi. Gang: ${b.gang}, Grade: ${b.grade}`],
  giveitem: b => ["fivemGiveItem", `Eşya verildi. Eşya: ${b.item}, Miktar: ${b.amount}`],
  pedmenu: () => ["fivemPedMenu", "Ped menusu acildi."],
  kill: () => ["fivemKill", "Olduruldu (kill)."],
  revive: () => ["fivemRevive", "Canlandirildi (revive)."],
  send_dm: b => ["fivemSendDM", `DM atildi. Mesaj: ${b.reason || ""}`],
  pedver: b => ["fivemPedVer", `Ped verildi. Model: ${b.ped}`],
  pedal: () => ["fivemPedAl", "Ped geri alindi."],
  givemoney: b => ["fivemGiveMoney", `Para verildi. Tip: ${b.type || "cash"}, Miktar: ${b.amount}`],
  vreturn: b => ["fivemVReturn", `Araba çekildi (vreturn). Target: ID #${b.targetPlayer}${b.plate ? ", Plaka: " + b.plate : ""}`],
  teleport: b => ["fivemTeleport", b.location
    ? `Oyuncu ışınlandı. Lokasyon: ${b.location}`
    : `Oyuncu ışınlandı. Koordinatlar: X:${b.x || 0}, Y:${b.y || 0}, Z:${b.z || 0}`]
};

async function recordFivemKick(req, { discordId, playerName, reason }) {
  if (!discordId) return;
  try {
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
  } catch (err) {
    console.error("Kick ceza kaydı hatası:", err);
  }
}

async function recordFivemBan(req, { discordId, playerName, reason }, ban) {
  try {
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
  } catch (err) {
    console.error("Ban ceza kaydı hatası:", err);
  }
}

router.post("/api/fivem/bridge/command", requireStaff(["fivemBridgeCommands"]), async (req, res) => {
  const b = req.body;
  const { action, targetPlayer } = b;
  if (!action) {
    return res.status(400).json({ success: false, message: "Geçersiz eylem." });
  }
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (action === "kick" || action === "ban") {
    if (!reason) {
      return res.status(400).json({ success: false, message: action === "kick" ? "Kick sebebi girmek zorunludur." : "Ban sebebi girmek zorunludur." });
    }
    if (action === "ban" && !b.duration) {
      return res.status(400).json({ success: false, message: "Yasaklama süresi seçmek zorunludur." });
    }
    if (!targetPlayer) {
      return res.status(400).json({ success: false, message: "Hedef oyuncu bulunamadı." });
    }
  }

  const ban = action === "ban"
    ? resolveBan(b.duration, b.durationSeconds, b.durationText, !!b.isPerma)
    : { seconds: 0, label: b.durationText || "3 Gün", isPerma: !!b.isPerma };

  const vreturnCommand = action === "vreturn" ? (b.plate ? `vreturn ${targetPlayer} ${b.plate}` : `vreturn ${targetPlayer}`) : undefined;
  const { id: commandId } = queueCommand("cmd", {
    action,
    command: b.command || vreturnCommand,
    targetPlayer,
    amount: b.amount,
    identifier: b.identifier,
    reason: b.reason || b.command || "",
    admin: req.session.user.username || "Web Panel",
    job: b.job,
    grade: b.grade,
    ped: b.ped,
    gang: b.gang,
    item: b.item,
    type: b.type,
    x: b.x,
    y: b.y,
    z: b.z,
    location: b.location,
    plate: b.plate,
    duration: ban.label,
    durationSeconds: ban.seconds,
    expire: ban.isPerma ? PERMA_BAN_EXPIRY : Math.floor(Date.now() / 1000) + ban.seconds,
    isPerma: ban.isPerma,
    playerName: b.playerName || "",
    discordId: b.discordId || "",
    license: b.license || "",
    timestamp: Date.now()
  });
  addLog("sync", `FiveM Köprüsü: Yeni köprü komutu kuyruğa eklendi. ID: ${commandId} (Eylem: ${action})`, "info");

  let logEntry = COMMAND_LOG_DESCRIPTIONS[action] ? COMMAND_LOG_DESCRIPTIONS[action](b) : null;
  if (action === "kick") {
    const details = `Oyuncu sunucudan atıldı (Kick). Hedef: #${targetPlayer}, Sebep: ${reason}`;
    logEntry = ["fivemKick", details];
    addLog("sync", `FiveM Köprüsü: ${details}, Yetkili: ${req.session.user.username}`, "info");
    await recordFivemKick(req, { discordId: b.discordId, playerName: b.playerName, reason });
  } else if (action === "ban") {
    const details = `Oyuncu sunucudan yasaklandı (Ban). Hedef: #${targetPlayer}, Süre: ${ban.label}, Sebep: ${reason}`;
    logEntry = ["fivemBan", details];
    addLog("sync", `FiveM Köprüsü: ${details}, Yetkili: ${req.session.user.username}`, "info");
    if (b.discordId && b.syncDiscord !== false) {
      await recordFivemBan(req, { discordId: b.discordId, playerName: b.playerName, reason }, ban);
    }
  }

  if (logEntry) {
    logAction(logEntry[0], {
      executor: actorFrom(req),
      target: { id: targetPlayer ? targetPlayer.toString() : "", username: targetPlayer ? "FiveM ID: " + targetPlayer : "Bilinmeyen" },
      details: logEntry[1],
      context: "FiveM Koprusu"
    });
  }
  res.json({ success: true, message: "Komut kuyruğa başarıyla eklendi.", commandId });
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
  res.json({ success: true, queue: fivem.commandQueue });
});

function charactersOf(discordId) {
  return FivemCharacter.find({ discordId: { $in: [discordId, `discord:${discordId}`] } }).sort({ cid: 1 });
}

router.get("/api/fivem/user-characters/:discordId", requireStaff(), async (req, res) => {
  try {
    res.json({ success: true, characters: await charactersOf(req.params.discordId) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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

    const found = fivem.activePlayers.find(p =>
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
    res.json({ success: true, discordUser, characters, onlinePlayer });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

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

    // 1) Kick the player if online, 2) queue every delete variant the bridge understands.
    if (onlinePlayer) {
      queueCommand("cmd_kick", {
        action: "kick",
        type: "kick",
        targetPlayer: onlinePlayer.id,
        citizenid: character.citizenid,
        reason: "Karakteriniz web paneli üzerinden silindi.",
        admin: adminName,
        timestamp: Date.now()
      });
    }
    queueCharacterDeletion({
      citizenid: character.citizenid,
      identifier: character.citizenid,
      charId: character._id.toString(),
      targetPlayer: onlinePlayer ? onlinePlayer.id : null,
      reason: "Karakter web paneli üzerinden silindi.",
      admin: adminName,
      timestamp: Date.now()
    }, {
      actions: ["delete_character", "deletecharacter", "delchar", "delete_char", "deleteChar"],
      consoleCommands: [`deletechar ${character.citizenid}`, `qb-core:deletechar ${character.citizenid}`],
      sqlActions: ["execute_sql", "sql"]
    });

    // 3) Remember the deletion so the next bridge sync does not re-create the character.
    await DeletedCharacter.updateOne(
      { citizenid: character.citizenid },
      { citizenid: character.citizenid, discordId: character.discordId || "", charName, deletedBy: adminName, deletedAt: new Date() },
      { upsert: true }
    );
    await FivemCharacter.deleteMany({ citizenid: character.citizenid });

    addLog("sync", `FiveM Köprüsü: Karakter silme işlemi gerçekleştirildi (Önce Kick -> Sonra SQL Data Silme). Karakter: ${charName} (CitizenID: ${character.citizenid}${onlinePlayer ? ", Aktif Oyuncu ID: #" + onlinePlayer.id : ""})`, "info");
    logAction("fivemCharacterDelete", {
      executor: actorFrom(req),
      target: { id: character._id, username: charName },
      details: `FiveM Karakteri (${charName} - CID: ${character.citizenid}) kicklendi ve veritabanından kalıcı olarak silindi.`,
      context: "Web Panel"
    });

    res.json({ success: true, message: `"${charName}" isimli karakter veritabanından silindi.`, targetDiscordId: character.discordId });
  } catch (err) {
    console.error("Delete character error:", err);
    res.status(500).json({ success: false, message: "Karakter silinirken veritabanı hatası oluştu." });
  }
});

router.get("/api/fivem/active-players-characters", requireStaff(), async (req, res) => {
  try {
    const players = fivem.activePlayers.map(p => ({ player: p, ...playerIdentifiers(p) }));
    const discordIds = players.map(p => p.generalInfo.discord).filter(Boolean);
    const characters = await FivemCharacter.find({ discordId: { $in: discordIds } });

    const namesByDiscordId = {};
    for (const c of characters) {
      (namesByDiscordId[c.discordId] = namesByDiscordId[c.discordId] || []).push(`${c.firstname} ${c.lastname}`);
    }

    res.json({
      success: true,
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
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/api/fivem/shared-data", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ success: false, message: "Oturum kapalı." });
  }
  try {
    if (!fs.existsSync(config.sharedDataPath)) {
      fs.writeFileSync(config.sharedDataPath, JSON.stringify({ ...DEFAULT_SHARED_DATA, timestamp: Date.now() }, null, 2), "utf8");
    }
    const data = JSON.parse(fs.readFileSync(config.sharedDataPath, "utf8"));
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
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
