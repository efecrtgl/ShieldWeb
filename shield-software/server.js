const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Protocol version reported to the panel. v2 = command results are sent back with the next poll.
const BRIDGE_VERSION = 2;
const RESOURCE_VERSION = "2.1.0";
const REQUEST_TIMEOUT_MS = 10000;
const MAX_PENDING_RESULTS = 200;
const CHARACTER_CHUNK_SIZE = 50;
const FULL_SYNC_INTERVAL_MS = 60000;
const SHARED_SYNC_INTERVAL_MS = 600000;
const MAX_ITEM_AMOUNT = 1000;
const MAX_MONEY_AMOUNT = 100000000;
const PERMA_BAN_EXPIRY = 2147483647;

const isFiveM = typeof GetResourcePath !== "undefined";
// Unit tests load this file outside FiveM with SHIELD_BRIDGE_TEST=1: nothing is started, internals are exported.
const isTest = !isFiveM && process.env.SHIELD_BRIDGE_TEST === "1";

let config = {
  apiUrl: "",
  secretKey: "",
  pollInterval: 1000,
  dbLock: false,
  locations: {}
};

function getTimestamp() {
  const d = new Date();
  const pad = n => (n < 10 ? "0" + n : n);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function log(msg, colorCode = "^7") {
  const header = `^7[${getTimestamp()}] ^5[SHIELD-WEB v${RESOURCE_VERSION}]^7 `;
  if (isFiveM) {
    console.log(`${header}${colorCode}${msg}^7`);
    return;
  }
  if (isTest) return;
  const termColors = { "^1": "\x1b[31m", "^2": "\x1b[32m", "^3": "\x1b[33m", "^4": "\x1b[34m", "^5": "\x1b[36m", "^6": "\x1b[35m", "^7": "\x1b[0m" };
  let formatted = `${header}${colorCode}${msg}`;
  for (const [code, ansi] of Object.entries(termColors)) formatted = formatted.split(code).join(ansi);
  console.log(`${formatted}\x1b[0m`);
}

function loadConfig() {
  const configPath = isFiveM
    ? path.join(GetResourcePath(GetCurrentResourceName()), "config.json")
    : path.join(__dirname, "config.json");
  if (!fs.existsSync(configPath)) {
    log(`[HATA] config.json bulunamadı (${configPath}). config.example.json dosyasını kopyalayıp doldurun.`, "^1");
    return false;
  }
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(configPath, "utf8")) };
  } catch (err) {
    log("[HATA] config.json okunamadı: " + err.message, "^1");
    return false;
  }
  if (!config.apiUrl || !/^https?:\/\//.test(config.apiUrl)) {
    log("[HATA] config.json: apiUrl geçerli bir http(s) adresi olmalıdır.", "^1");
    return false;
  }
  if (!config.secretKey || config.secretKey.startsWith("CHANGE_ME")) {
    log("[HATA] config.json: secretKey ayarlanmamış (panel .env içindeki FIVEM_BRIDGE_SECRET ile aynı olmalı).", "^1");
    return false;
  }
  return true;
}

// Panel endpoint next to the configured poll URL, e.g. ".../bridge/poll" -> ".../bridge/characters".
function bridgeUrl(endpoint) {
  return config.apiUrl.replace(/\/poll\/?$/, `/${endpoint}`);
}

/* ==========================================================================
   DATABASE LAYER (oxmysql)
   ========================================================================== */

let dbReady = false;
let hasAdminIdentifiersTable = false;

class DbLockedError extends Error {
  constructor() {
    super("Veritabanı kilitli (config.dbLock = true); SQL işlemi yapılmadı.");
  }
}

function oxmysql() {
  const ox = global.exports && global.exports.oxmysql;
  if (!ox) throw new Error("oxmysql export'u bulunamadı");
  return ox;
}

async function dbQuery(query, params = []) {
  if (config.dbLock) throw new DbLockedError();
  const ox = oxmysql();
  if (typeof ox.query_async === "function") return (await ox.query_async(query, params)) || [];
  return new Promise((resolve, reject) => {
    try {
      ox.query(query, params, result => resolve(result || []));
    } catch (err) {
      reject(err);
    }
  });
}

async function dbSingle(query, params = []) {
  if (config.dbLock) throw new DbLockedError();
  const ox = oxmysql();
  if (typeof ox.single_async === "function") return (await ox.single_async(query, params)) || null;
  const rows = await dbQuery(query, params);
  return rows.length > 0 ? rows[0] : null;
}

// Returns the number of affected rows.
async function dbExecute(query, params = []) {
  if (config.dbLock) throw new DbLockedError();
  const ox = oxmysql();
  const result = typeof ox.update_async === "function" ? await ox.update_async(query, params) : await dbQuery(query, params);
  if (typeof result === "number") return result;
  return result && typeof result.affectedRows === "number" ? result.affectedRows : 0;
}

async function initDatabase() {
  if (config.dbLock) {
    log("[DATABASE] KİLİTLİ: SQL okuma/yazma kapalı; yalnızca çevrimiçi oyuncu verisi gönderilecek.", "^3");
    return;
  }
  for (let attempt = 1; attempt <= 25; attempt++) {
    try {
      if (GetResourceState("oxmysql") === "started") {
        await dbQuery("SELECT 1");
        dbReady = true;
        break;
      }
    } catch (e) {
      // oxmysql pool not ready yet
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!dbReady) {
    log("[UYARI] oxmysql bağlantısı kurulamadı; karakter senkronizasyonu ve çevrimdışı işlemler çalışmayacak.", "^3");
    return;
  }
  log("MariaDB / oxmysql bağlantısı doğrulandı.", "^2");
  try {
    const rows = await dbQuery("SHOW TABLES LIKE 'fx_admin_identifiers'");
    hasAdminIdentifiersTable = rows.length > 0;
    if (hasAdminIdentifiersTable) log("Oyuncu identifier tablosu 'fx_admin_identifiers' devrede.", "^2");
  } catch (err) {
    hasAdminIdentifiersTable = false;
  }
  setTimeout(() => syncUpdatedCharacters(true), 500);
}

function parseJson(value, fallback) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch (e) {
    return fallback;
  }
}

/* ==========================================================================
   FRAMEWORK & PLAYER HELPERS (QBCore)
   ========================================================================== */

const playerIdentifiersCache = new Map(); // citizenid -> { discord, steam, license, fivem }
const licenseIdentifiersCache = new Map(); // license -> { discord, steam, fivem }

function getQBCore() {
  if (!isFiveM) return null;
  try {
    if (GetResourceState("qb-core") === "started") return exports["qb-core"].GetCoreObject();
  } catch (e) { }
  return null;
}

// Live QBCore player by server id or citizenid.
function getLiveQBCorePlayer(target) {
  if (target === undefined || target === null || target === "") return null;
  const QBCore = getQBCore();
  if (!QBCore || !QBCore.Functions) return null;
  try {
    const str = String(target).trim();
    if (/^\d{1,6}$/.test(str)) {
      const p = QBCore.Functions.GetPlayer(parseInt(str, 10));
      if (p) return p;
    }
    if (QBCore.Functions.GetPlayerByCitizenId) {
      const p = QBCore.Functions.GetPlayerByCitizenId(str);
      if (p) return p;
    }
  } catch (e) { }
  return null;
}

function getOnlinePlayer(targetPlayer, citizenid) {
  return getLiveQBCorePlayer(targetPlayer) || getLiveQBCorePlayer(citizenid) || null;
}

function playerSource(player) {
  return parseInt(player.PlayerData.source, 10);
}

function isServerIdOnline(serverId) {
  if (!isFiveM || !/^\d{1,6}$/.test(String(serverId))) return false;
  try {
    return !!GetPlayerName(String(serverId));
  } catch (e) {
    return false;
  }
}

function cleanIdentifier(id, prefix) {
  if (!id) return "";
  const str = String(id).trim();
  if (prefix && str.toLowerCase().startsWith(prefix.toLowerCase() + ":")) return str.slice(prefix.length + 1);
  return str.replace(/^(discord|steam|license|fivem):/i, "");
}

function readIdentifiers(source) {
  const result = { all: [], discord: "", steam: "", license: "", fivem: "" };
  if (!isFiveM || typeof GetNumPlayerIdentifiers !== "function") return result;
  const count = GetNumPlayerIdentifiers(source);
  for (let i = 0; i < count; i++) {
    const id = GetPlayerIdentifier(source, i);
    if (!id) continue;
    result.all.push(id);
    for (const type of ["discord", "steam", "license", "fivem"]) {
      if (id.startsWith(type + ":") && !result[type]) result[type] = id;
    }
  }
  return result;
}

// Caches identifiers and persists them to fx_admin_identifiers (the players table has no identifier columns).
async function updatePlayerIdentifiers(source, citizenid) {
  const { discord, steam, license, fivem } = readIdentifiers(source);
  if (citizenid) playerIdentifiersCache.set(citizenid, { discord, steam, license, fivem });
  if (license) licenseIdentifiersCache.set(license, { discord, steam, fivem });
  if (dbReady && hasAdminIdentifiersTable && license && (discord || steam || fivem)) {
    try {
      await dbExecute(
        `INSERT INTO fx_admin_identifiers (license, discord, steam, fivem, last_seen)
         VALUES (?, ?, ?, ?, UNIX_TIMESTAMP())
         ON DUPLICATE KEY UPDATE discord = VALUES(discord), steam = VALUES(steam), fivem = VALUES(fivem), last_seen = UNIX_TIMESTAMP()`,
        [license, discord || null, steam || null, fivem || null]
      );
    } catch (e) {
      log(`[UYARI] fx_admin_identifiers güncellenemedi: ${e.message}`, "^3");
    }
  }
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function serverPlayerIds() {
  const fn = typeof getPlayers === "function" ? getPlayers : (typeof GetPlayers === "function" ? GetPlayers : null);
  if (!fn) return [];
  try {
    const players = fn();
    return players && typeof players[Symbol.iterator] === "function" ? [...players].map(String) : [];
  } catch (e) {
    return [];
  }
}

function pedState(serverId) {
  const state = { coords: null, health: null, armor: null };
  if (typeof GetPlayerPed !== "function") return state;
  try {
    const ped = GetPlayerPed(serverId);
    if (!ped) return state;
    if (typeof GetEntityCoords === "function") {
      const c = GetEntityCoords(ped);
      const [x, y, z] = Array.isArray(c) ? c : [c && c.x, c && c.y, c && c.z];
      if ([x, y, z].every(Number.isFinite)) {
        state.coords = { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), z: Number(z.toFixed(2)) };
      }
    }
    if (typeof GetEntityHealth === "function") state.health = numberOrNull(GetEntityHealth(ped));
    if (typeof GetPedArmour === "function") state.armor = numberOrNull(GetPedArmour(ped));
  } catch (e) { }
  return state;
}

// Live online players. A value the server could not read is null, never a placeholder.
function getPlayersList() {
  const list = [];
  for (const strId of serverPlayerIds()) {
    try {
      const ids = readIdentifiers(strId);
      const ped = pedState(strId);
      const entry = {
        id: strId,
        serverId: parseInt(strId, 10),
        name: typeof GetPlayerName === "function" ? GetPlayerName(strId) || null : null,
        ping: typeof GetPlayerPing === "function" ? numberOrNull(GetPlayerPing(strId)) : null,
        identifiers: ids.all,
        discord: cleanIdentifier(ids.discord, "discord") || null,
        discordId: cleanIdentifier(ids.discord, "discord") || null,
        steam: cleanIdentifier(ids.steam, "steam") || null,
        license: ids.license || null,
        fivem: cleanIdentifier(ids.fivem, "fivem") || null,
        coords: ped.coords ? `vec3(${ped.coords.x}, ${ped.coords.y}, ${ped.coords.z})` : null,
        coordsObj: ped.coords,
        health: ped.health,
        armor: ped.armor,
        characterLoaded: false,
        citizenid: null,
        charName: null,
        job: null, job_name: null, job_label: null, job_grade: null, job_grade_name: null,
        gang: null, gang_name: null, gang_label: null,
        cash: null, bank: null, crypto: null,
        phone: null, hunger: null, thirst: null
      };

      const live = getLiveQBCorePlayer(strId);
      if (live && live.PlayerData) {
        const pData = live.PlayerData;
        const charinfo = pData.charinfo || {};
        const job = pData.job || null;
        const gang = pData.gang || null;
        const money = pData.money || {};
        const meta = pData.metadata || {};
        const fullName = `${charinfo.firstname || ""} ${charinfo.lastname || ""}`.trim();
        Object.assign(entry, {
          characterLoaded: true,
          citizenid: pData.citizenid || null,
          charName: fullName || null,
          characterName: fullName || null,
          phone: charinfo.phone || null,
          cash: numberOrNull(money.cash),
          bank: numberOrNull(money.bank),
          crypto: numberOrNull(money.crypto),
          hunger: numberOrNull(meta.hunger),
          thirst: numberOrNull(meta.thirst)
        });
        if (job && job.name) {
          const gradeName = job.grade && job.grade.name ? job.grade.name : null;
          Object.assign(entry, {
            job_name: job.name,
            job_label: job.label || null,
            job_grade: job.grade ? numberOrNull(job.grade.level) : null,
            job_grade_name: gradeName,
            job: `${job.label || job.name}${gradeName ? ` (${gradeName})` : ""}`
          });
        }
        if (gang && gang.name) {
          Object.assign(entry, { gang_name: gang.name, gang_label: gang.label || null, gang: gang.label || gang.name });
        }
      }
      list.push(entry);
    } catch (err) {
      log(`Oyuncu bilgisi okunamadı (ID ${strId}): ${err.message}`, "^1");
    }
  }
  return list;
}

function maxPlayers() {
  if (typeof GetConvarInt !== "function") return null;
  const value = GetConvarInt("sv_maxclients", 0);
  return value > 0 ? value : null;
}

/* ==========================================================================
   NETWORK
   ========================================================================== */

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10, keepAliveMsecs: 30000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10, keepAliveMsecs: 30000 });

class HttpStatusError extends Error {
  constructor(status, body) {
    let detail = body;
    try {
      const json = JSON.parse(body);
      if (json && json.message) detail = json.message;
    } catch (e) { }
    super(`HTTP ${status}${detail ? " - " + String(detail).slice(0, 300) : ""}`);
    this.status = status;
  }
}

// Signs and POSTs `body` to the panel. The exact string that is signed is the one sent.
function signedPost(urlStr, body) {
  const dataStr = JSON.stringify(body);
  const timestamp = Date.now().toString();
  const signature = crypto.createHmac("sha256", config.secretKey).update(timestamp + dataStr).digest("hex");
  const url = new URL(urlStr);
  const isHttps = url.protocol === "https:";

  return new Promise((resolve, reject) => {
    const req = (isHttps ? https : http).request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      agent: isHttps ? httpsAgent : httpAgent,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        "User-Agent": `Shield-FiveM-Bridge/${RESOURCE_VERSION}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(dataStr),
        "X-Bridge-Timestamp": timestamp,
        "X-Bridge-Signature": signature
      }
    }, res => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { responseBody += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new HttpStatusError(res.statusCode, responseBody));
        try {
          resolve(JSON.parse(responseBody));
        } catch (err) {
          reject(new Error("Panel geçersiz JSON döndürdü."));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`Zaman aşımı (${REQUEST_TIMEOUT_MS} ms)`)));
    req.on("error", reject);
    req.end(dataStr);
  });
}

// Logs the same error at most once a minute per channel.
const lastErrors = {};
function logThrottled(channel, message) {
  const now = Date.now();
  const last = lastErrors[channel];
  if (last && last.message === message && now - last.at < 60000) return;
  lastErrors[channel] = { message, at: now };
  log(`[HATA] ${channel}: ${message}`, "^1");
  if (/403/.test(message) && /IP/i.test(message)) {
    log("[IP UYARISI] Bu sunucunun IP adresi panelin FIVEM_BRIDGE_ALLOWED_IP listesinde değil.", "^3");
  }
}

/* ==========================================================================
   COMMAND EXECUTION
   Every handler returns { ok, error?, data? }; the result is reported to the panel with the next poll.
   ========================================================================== */

const success = data => ({ ok: true, ...(data ? { data } : {}) });
const failure = error => ({ ok: false, error });

function verifyAmount(rawAmount, maxCap) {
  const num = Number(rawAmount);
  if (!Number.isInteger(num) || num <= 0) return { error: `Geçersiz miktar (${rawAmount}).` };
  if (num > maxCap) return { error: `Miktar üst sınırı aşıyor (en fazla ${maxCap}).` };
  return { value: num };
}

// Item code validated against the server's item list when one is available.
function verifyItem(rawItem) {
  if (typeof rawItem !== "string") return { error: "Eşya kodu eksik." };
  const code = rawItem.trim().toLowerCase();
  if (!/^[a-z0-9_.-]{1,64}$/.test(code)) return { error: "Eşya kodu geçersiz karakter içeriyor." };
  const items = getSharedData().items;
  if (items && Object.keys(items).length > 0 && !items[code]) return { error: `'${code}' sunucunun eşya listesinde yok.` };
  return { value: code };
}

function requireOnline(cmd) {
  const player = getOnlinePlayer(cmd.targetPlayer, cmd.citizenid);
  return player ? { player } : { error: "Oyuncu şu anda oyunda değil veya karakteri yüklenmemiş." };
}

async function readPlayerColumn(citizenid, column) {
  const row = await dbSingle(`SELECT ${column} FROM players WHERE citizenid = ?`, [citizenid]);
  return row ? parseJson(row[column], null) : undefined;
}

function sharedGroup(kind, name) {
  const QBCore = getQBCore();
  const all = QBCore && QBCore.Shared ? QBCore.Shared[kind] : null;
  if (!all || Object.keys(all).length === 0) return { unknownList: true };
  return all[name] ? { info: all[name] } : { missing: true };
}

async function setGroup(cmd, kind) {
  const isJob = kind === "Jobs";
  const name = typeof (isJob ? cmd.job : cmd.gang) === "string" ? (isJob ? cmd.job : cmd.gang).trim() : "";
  const grade = Number(cmd.grade);
  if (!name) return failure(isJob ? "Meslek adı eksik." : "Çete adı eksik.");
  if (!Number.isInteger(grade) || grade < 0) return failure("Kademe 0 veya daha büyük bir tam sayı olmalıdır.");

  const group = sharedGroup(kind, name);
  if (group.missing) return failure(`'${name}' sunucuda tanımlı bir ${isJob ? "meslek" : "çete"} değil.`);
  if (group.info && group.info.grades && !group.info.grades[String(grade)]) return failure(`'${name}' için ${grade} numaralı kademe tanımlı değil.`);

  const player = getOnlinePlayer(cmd.targetPlayer, cmd.citizenid);
  if (player) {
    const fn = isJob ? player.Functions.SetJob : player.Functions.SetGang;
    if (typeof fn !== "function") return failure("Framework bu işlemi desteklemiyor.");
    if (fn(name, grade) === false) return failure("Framework işlemi reddetti.");
    player.Functions.Save();
    queueCharacterSync(player.PlayerData.citizenid);
    return success({ online: true });
  }

  if (!cmd.citizenid) return failure("Oyuncu çevrimiçi değil ve citizenid verilmedi.");
  if (!group.info) return failure("Sunucunun meslek/çete listesi okunamadığı için çevrimdışı atama yapılamaz.");
  const column = isJob ? "job" : "gang";
  const current = await readPlayerColumn(cmd.citizenid, column);
  if (current === undefined) return failure("Karakter oyun veritabanında bulunamadı.");
  const gradeInfo = (group.info.grades && group.info.grades[String(grade)]) || {};
  const value = { ...(current || {}), name, label: group.info.label || name, grade: { name: gradeInfo.name || null, level: grade }, isboss: !!gradeInfo.isboss };
  if (isJob) {
    value.onduty = current && typeof current.onduty === "boolean" ? current.onduty : !!group.info.defaultDuty;
    value.payment = typeof gradeInfo.payment === "number" ? gradeInfo.payment : (current && current.payment) || 0;
  }
  await dbExecute(`UPDATE players SET ${column} = ? WHERE citizenid = ?`, [JSON.stringify(value), cmd.citizenid]);
  queueCharacterSync(cmd.citizenid);
  return success({ online: false });
}

async function giveItem(cmd) {
  const item = verifyItem(cmd.item);
  if (item.error) return failure(item.error);
  const amount = verifyAmount(cmd.amount, MAX_ITEM_AMOUNT);
  if (amount.error) return failure(amount.error);

  const player = getOnlinePlayer(cmd.targetPlayer, cmd.citizenid);
  if (player) {
    let given;
    if (GetResourceState("ox_inventory") === "started") {
      given = exports["ox_inventory"].AddItem(playerSource(player), item.value, amount.value);
    } else if (typeof player.Functions.AddItem === "function") {
      given = player.Functions.AddItem(item.value, amount.value);
      player.Functions.Save();
    } else {
      return failure("Envanter sistemi bulunamadı.");
    }
    if (!given) return failure("Envanter eşyayı kabul etmedi (yer/ağırlık yetersiz olabilir).");
    queueCharacterSync(player.PlayerData.citizenid);
    return success({ online: true });
  }

  if (!cmd.citizenid) return failure("Oyuncu çevrimiçi değil ve citizenid verilmedi.");
  if (GetResourceState("ox_inventory") === "started") return failure("ox_inventory kullanılırken çevrimdışı oyuncuya eşya verilemez.");
  const inv = await readPlayerColumn(cmd.citizenid, "inventory");
  if (inv === undefined) return failure("Karakter oyun veritabanında bulunamadı.");
  const items = Array.isArray(inv) ? inv : Object.values(inv || {});
  const existing = items.find(i => i && (i.name === item.value || i.item === item.value));
  if (existing) {
    existing.amount = Number(existing.amount ?? existing.count ?? 0) + amount.value;
    if (existing.count !== undefined) existing.count = existing.amount;
  } else {
    const maxSlot = items.reduce((max, i) => (i && i.slot > max ? i.slot : max), 0);
    items.push({ name: item.value, amount: amount.value, info: {}, slot: maxSlot + 1 });
  }
  await dbExecute("UPDATE players SET inventory = ? WHERE citizenid = ?", [JSON.stringify(items), cmd.citizenid]);
  queueCharacterSync(cmd.citizenid);
  return success({ online: false });
}

async function removeItem(cmd) {
  const code = typeof (cmd.item || cmd.itemName) === "string" ? (cmd.item || cmd.itemName).trim().toLowerCase() : "";
  const slot = cmd.slot !== undefined && cmd.slot !== null && cmd.slot !== "" ? Number(cmd.slot) : null;
  if (!code && slot === null) return failure("Eşya kodu veya slot gereklidir.");
  if (slot !== null && (!Number.isInteger(slot) || slot < 0)) return failure("Geçersiz slot.");
  const amount = verifyAmount(cmd.amount === undefined ? 1 : cmd.amount, MAX_ITEM_AMOUNT);
  if (amount.error) return failure(amount.error);

  const player = getOnlinePlayer(cmd.targetPlayer, cmd.citizenid);
  if (player) {
    let removed;
    if (GetResourceState("ox_inventory") === "started") {
      removed = exports["ox_inventory"].RemoveItem(playerSource(player), code, amount.value, null, slot === null ? undefined : slot);
    } else if (typeof player.Functions.RemoveItem === "function") {
      removed = player.Functions.RemoveItem(code, amount.value, slot === null ? undefined : slot);
      player.Functions.Save();
    } else {
      return failure("Envanter sistemi bulunamadı.");
    }
    if (!removed) return failure("Eşya envanterde bulunamadı veya silinemedi.");
    queueCharacterSync(player.PlayerData.citizenid);
    return success({ online: true });
  }

  if (!cmd.citizenid) return failure("Oyuncu çevrimiçi değil ve citizenid verilmedi.");
  const inv = await readPlayerColumn(cmd.citizenid, "inventory");
  if (inv === undefined) return failure("Karakter oyun veritabanında bulunamadı.");
  const items = Array.isArray(inv) ? inv : Object.values(inv || {});
  const index = items.findIndex(i => i && (slot !== null ? Number(i.slot) === slot : (i.name === code || i.item === code)));
  if (index === -1) return failure("Eşya envanterde bulunamadı.");
  const target = items[index];
  const count = Number(target.amount ?? target.count ?? 1);
  if (slot === null && count > amount.value) {
    target.amount = count - amount.value;
    if (target.count !== undefined) target.count = target.amount;
  } else {
    items.splice(index, 1);
  }
  await dbExecute("UPDATE players SET inventory = ? WHERE citizenid = ?", [JSON.stringify(items), cmd.citizenid]);
  queueCharacterSync(cmd.citizenid);
  return success({ online: false });
}

async function clearInventory(cmd) {
  const player = getOnlinePlayer(cmd.targetPlayer, cmd.citizenid);
  if (player) {
    if (GetResourceState("ox_inventory") === "started") {
      exports["ox_inventory"].ClearInventory(playerSource(player));
    } else if (typeof player.Functions.ClearInventory === "function") {
      player.Functions.ClearInventory();
    } else {
      return failure("Envanter sistemi bulunamadı.");
    }
    player.Functions.Save();
    queueCharacterSync(player.PlayerData.citizenid);
    return success({ online: true });
  }
  if (!cmd.citizenid) return failure("Oyuncu çevrimiçi değil ve citizenid verilmedi.");
  const affected = await dbExecute("UPDATE players SET inventory = '[]' WHERE citizenid = ?", [cmd.citizenid]);
  if (!affected) return failure("Karakter oyun veritabanında bulunamadı.");
  queueCharacterSync(cmd.citizenid);
  return success({ online: false });
}

async function giveMoney(cmd) {
  if (!["cash", "bank", "crypto"].includes(cmd.type)) return failure("Para tipi cash, bank veya crypto olmalıdır.");
  const amount = verifyAmount(cmd.amount, MAX_MONEY_AMOUNT);
  if (amount.error) return failure(amount.error);

  const player = getOnlinePlayer(cmd.targetPlayer, cmd.citizenid);
  if (player) {
    if (typeof player.Functions.AddMoney !== "function") return failure("Framework para eklemeyi desteklemiyor.");
    if (player.Functions.AddMoney(cmd.type, amount.value, "Shield Web Panel") === false) return failure("Framework işlemi reddetti.");
    player.Functions.Save();
    queueCharacterSync(player.PlayerData.citizenid);
    return success({ online: true });
  }
  if (!cmd.citizenid) return failure("Oyuncu çevrimiçi değil ve citizenid verilmedi.");
  const money = await readPlayerColumn(cmd.citizenid, "money");
  if (money === undefined) return failure("Karakter oyun veritabanında bulunamadı.");
  const next = { ...(money || {}) };
  next[cmd.type] = (Number(next[cmd.type]) || 0) + amount.value;
  await dbExecute("UPDATE players SET money = ? WHERE citizenid = ?", [JSON.stringify(next), cmd.citizenid]);
  queueCharacterSync(cmd.citizenid);
  return success({ online: false });
}

// Applies only the fields the panel sent (it sends just what the editor changed).
async function updateCharacter(cmd) {
  const citizenid = cmd.citizenid;
  if (!citizenid) return failure("citizenid gereklidir.");
  const names = {};
  for (const key of ["firstname", "lastname", "birthdate"]) {
    if (typeof cmd[key] === "string") names[key] = cmd[key];
  }
  const money = {};
  for (const key of ["cash", "bank"]) {
    if (cmd[key] === undefined) continue;
    const n = Number(cmd[key]);
    if (!Number.isFinite(n) || n < 0) return failure(`Geçersiz ${key} değeri.`);
    money[key] = Math.floor(n);
  }
  const hasJob = typeof cmd.jobName === "string" && cmd.jobName.trim();

  const player = getLiveQBCorePlayer(citizenid);
  if (player) {
    if (hasJob) {
      const res = await setGroup({ job: cmd.jobName, grade: cmd.jobGrade, citizenid }, "Jobs");
      if (!res.ok) return res;
    }
    if (Object.keys(names).length > 0) {
      const charinfo = { ...(player.PlayerData.charinfo || {}), ...names };
      if (typeof player.Functions.SetPlayerData === "function") player.Functions.SetPlayerData("charinfo", charinfo);
      else player.PlayerData.charinfo = charinfo;
    }
    for (const [type, value] of Object.entries(money)) {
      if (player.Functions.SetMoney(type, value, "Shield Web Panel") === false) return failure(`${type} değeri ayarlanamadı.`);
    }
    player.Functions.Save();
    queueCharacterSync(citizenid);
    return success({ online: true });
  }

  const row = await dbSingle("SELECT charinfo, money FROM players WHERE citizenid = ?", [citizenid]);
  if (!row) return failure("Karakter oyun veritabanında bulunamadı.");
  if (hasJob) {
    const res = await setGroup({ job: cmd.jobName, grade: cmd.jobGrade, citizenid }, "Jobs");
    if (!res.ok) return res;
  }
  const sets = [];
  const params = [];
  if (Object.keys(names).length > 0) {
    const charinfo = { ...parseJson(row.charinfo, {}), ...names };
    sets.push("charinfo = ?", "name = ?");
    params.push(JSON.stringify(charinfo), `${charinfo.firstname || ""} ${charinfo.lastname || ""}`.trim());
  }
  if (Object.keys(money).length > 0) {
    sets.push("money = ?");
    params.push(JSON.stringify({ ...parseJson(row.money, {}), ...money }));
  }
  if (sets.length > 0) await dbExecute(`UPDATE players SET ${sets.join(", ")} WHERE citizenid = ?`, [...params, citizenid]);
  queueCharacterSync(citizenid);
  return success({ online: false });
}

const CHARACTER_TABLES = ["player_vehicles", "player_houses", "player_mails", "player_outfits", "playerskins", "tgiann_bank_player_accounts"];

async function deleteCharacter(cmd) {
  const citizenid = typeof cmd.citizenid === "string" ? cmd.citizenid.trim() : "";
  if (!citizenid) return failure("citizenid gereklidir.");
  const live = getLiveQBCorePlayer(citizenid);
  if (live) DropPlayer(String(playerSource(live)), "Karakteriniz yetkili tarafından silindi. Lütfen tekrar bağlanın.");
  const deleted = await dbExecute("DELETE FROM players WHERE citizenid = ?", [citizenid]);
  const cleanup = {};
  for (const table of CHARACTER_TABLES) {
    try {
      cleanup[table] = await dbExecute(`DELETE FROM ${table} WHERE citizenid = ?`, [citizenid]);
    } catch (e) {
      // Optional tables that this server may not have.
      cleanup[table] = null;
    }
  }
  log(`[KOD MOTORU] Karakter silindi: ${citizenid} (players: ${deleted})`, "^2");
  return success({ playersRowsDeleted: deleted, alreadyAbsent: deleted === 0, cleanup });
}

function teleport(cmd) {
  const target = requireOnline(cmd);
  if (target.error) return failure(target.error);
  let coords = null;
  if (cmd.location) {
    const loc = config.locations && config.locations[cmd.location];
    if (!loc) return failure(`'${cmd.location}' konumu config.json içinde tanımlı değil.`);
    coords = [Number(loc.x), Number(loc.y), Number(loc.z)];
  } else {
    coords = [Number(cmd.x), Number(cmd.y), Number(cmd.z)];
  }
  if (!coords.every(Number.isFinite)) return failure("Geçersiz koordinat.");
  TriggerClientEvent("arcanium-web:client:teleport", playerSource(target.player), ...coords);
  return success();
}

function vehicleReturn(cmd) {
  const plate = String(cmd.plate || "").trim().toUpperCase();
  if (!plate) return failure("Plaka gereklidir.");
  const target = requireOnline(cmd);
  if (target.error) return failure(target.error);
  // The client moves the vehicle only if it exists in the world near the player; it cannot report back.
  TriggerClientEvent("arcanium-web:client:vreturn", playerSource(target.player), plate);
  return success({ note: "İstek oyuncuya iletildi; araç dünyada yoksa taşınmaz." });
}

function clientEvent(eventNames, argsFn) {
  return cmd => {
    const target = requireOnline(cmd);
    if (target.error) return failure(target.error);
    const src = playerSource(target.player);
    const args = argsFn ? argsFn(cmd) : [];
    if (args === null) return failure("Eksik parametre.");
    for (const name of eventNames) TriggerClientEvent(name, src, ...args);
    return success();
  };
}

function sendDm(cmd) {
  const target = requireOnline(cmd);
  if (target.error) return failure(target.error);
  const message = String(cmd.reason || "").slice(0, 500);
  if (!message) return failure("Mesaj boş.");
  const adminName = String(cmd.admin || "Yönetici").slice(0, 64);
  const src = playerSource(target.player);
  // chat:addMessage args are inserted as text by the chat resource.
  TriggerClientEvent("chat:addMessage", src, { color: [59, 130, 246], multiline: true, args: [`Yetkili Mesajı (${adminName})`, message] });
  TriggerClientEvent("QBCore:Notify", src, `Yetkili Mesajı (${adminName}): ${message}`, "primary", 10000);
  return success();
}

function kick(cmd) {
  const src = String(cmd.targetPlayer || "");
  if (!isServerIdOnline(src)) return failure("Oyuncu sunucuda değil.");
  const reason = String(cmd.reason || "Sunucudan yetkili tarafından atıldınız.").slice(0, 300);
  DropPlayer(src, `[SHIELD] Sunucudan Atıldınız (Kick)\nSebep: ${reason}\nYetkili: ${cmd.admin || "Yönetici"}`);
  return success();
}

async function ban(cmd) {
  const src = String(cmd.targetPlayer || "");
  if (!isServerIdOnline(src)) return failure("Oyuncu sunucuda değil.");
  const reason = String(cmd.reason || "Sunucudan yasaklandınız.").slice(0, 300);
  const admin = String(cmd.admin || "Yönetici").slice(0, 64);
  const isPerma = !!cmd.isPerma;
  const durationSeconds = Number(cmd.durationSeconds);
  if (!isPerma && !(durationSeconds > 0)) return failure("Geçersiz ban süresi.");
  const expire = isPerma ? PERMA_BAN_EXPIRY : Math.floor(Date.now() / 1000) + durationSeconds;
  const ids = readIdentifiers(src);
  const name = GetPlayerName(src) || cmd.playerName || null;
  const ip = (ids.all.find(i => i.startsWith("ip:")) || "").replace("ip:", "") || (typeof GetPlayerEndpoint === "function" ? GetPlayerEndpoint(src) : "") || null;

  let recorded = false;
  try {
    await dbExecute(
      "INSERT INTO bans (name, license, discord, ip, reason, expire, bannedby) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [name, ids.license || cmd.license || null, ids.discord || (cmd.discordId ? `discord:${cmd.discordId}` : null), ip, reason, expire, admin]
    );
    recorded = true;
  } catch (e) {
    log(`[UYARI] bans tablosuna yazılamadı: ${e.message}`, "^3");
  }
  DropPlayer(src, `[SHIELD] Sunucudan Yasaklandınız (Ban)\nSüre: ${cmd.duration || (isPerma ? "Kalıcı" : "Süreli")}\nSebep: ${reason}\nYetkili: ${admin}`);
  if (!recorded) return failure("Oyuncu atıldı ancak ban kaydı 'bans' tablosuna yazılamadı; tekrar bağlanabilir.");
  return success();
}

// Console-style commands the panel may run. Everything else is refused.
function executeConsoleCommand(cmd) {
  const parts = String(cmd.command || "").trim().split(/\s+/);
  const name = (parts[0] || "").toLowerCase();
  const arg = parts[1] || "";
  const resourcePattern = /^[a-zA-Z0-9_\-[\]]+$/;

  if (["start", "ensure", "stop", "restart"].includes(name)) {
    if (!resourcePattern.test(arg)) return failure("Geçerli bir resource adı gereklidir.");
    if (arg === GetCurrentResourceName()) return failure("Köprü kendi resource'unu yönetemez.");
    if (GetResourceState(arg) === "missing") return failure(`'${arg}' adlı bir resource bulunamadı.`);
    if (name === "stop") return StopResource(arg) ? success() : failure(`'${arg}' durdurulamadı.`);
    if (name === "restart") {
      StopResource(arg);
      return StartResource(arg) ? success() : failure(`'${arg}' yeniden başlatılamadı.`);
    }
    if (GetResourceState(arg) === "started") return success({ note: "Zaten çalışıyor." });
    return StartResource(arg) ? success() : failure(`'${arg}' başlatılamadı.`);
  }
  if (name === "say" || name === "announce") {
    const text = parts.slice(1).join(" ").slice(0, 500);
    if (!text) return failure("Duyuru metni boş.");
    TriggerClientEvent("chat:addMessage", -1, { color: [255, 165, 0], multiline: true, args: ["[YÖNETİCİ DUYURUSU]", text] });
    return success();
  }
  return failure(`İzin verilmeyen komut: '${name}'. İzin verilenler: start, ensure, stop, restart, say, announce.`);
}

// Screen watching works for any connected player, even before a character is loaded.
function connectedSource(cmd) {
  const player = getOnlinePlayer(cmd.targetPlayer, cmd.citizenid);
  if (player) return playerSource(player);
  return isServerIdOnline(cmd.targetPlayer) ? parseInt(cmd.targetPlayer, 10) : null;
}

function startScreenWatch(cmd) {
  const src = connectedSource(cmd);
  if (src === null) return failure("Oyuncu sunucuda değil.");
  if (GetResourceState("screenshot-basic") !== "started") return failure("screenshot-basic resource'u çalışmıyor.");
  if (!cmd.uploadUrl) return failure("Yükleme adresi eksik.");
  TriggerClientEvent("shield:client:startScreenWatch", src, {
    uploadUrl: cmd.uploadUrl,
    interval: cmd.interval,
    quality: cmd.quality
  });
  return success();
}

function stopScreenWatch(cmd) {
  const src = connectedSource(cmd);
  if (src === null) return success({ note: "Oyuncu artık oyunda değil." });
  TriggerClientEvent("shield:client:stopScreenWatch", src);
  return success();
}

async function syncCharactersCommand(cmd) {
  if (cmd.citizenid) {
    const ok = await syncUpdatedCharacters(String(cmd.citizenid));
    return ok ? success() : failure("Karakter verisi okunamadı veya panele gönderilemedi.");
  }
  queueCharacterSync(true);
  return success({ queued: true });
}

const COMMAND_HANDLERS = {
  setjob: cmd => setGroup(cmd, "Jobs"),
  setgang: cmd => setGroup(cmd, "Gangs"),
  giveitem: giveItem,
  removeitem: removeItem,
  clearinventory: clearInventory,
  givemoney: giveMoney,
  update_character: updateCharacter,
  delete_character: deleteCharacter,
  sync_characters: syncCharactersCommand,
  teleport,
  vreturn: vehicleReturn,
  revive: clientEvent(["hospital:client:Revive"]),
  kill: clientEvent(["hospital:client:KillPlayer"]),
  // Both appearance resources are tried; the one that is not installed simply ignores the event.
  pedmenu: clientEvent(["illenium-appearance:client:openClothingMenu", "qb-clothing:client:openMenu"]),
  pedver: clientEvent(["illenium-appearance:client:changePed"], cmd => (cmd.ped ? [String(cmd.ped)] : null)),
  pedal: clientEvent(["illenium-appearance:client:resetPed"]),
  send_dm: sendDm,
  kick,
  ban,
  execute_command: executeConsoleCommand,
  start_screen_watch: startScreenWatch,
  stop_screen_watch: stopScreenWatch
};

// Action names sent by older panel versions.
const ACTION_ALIASES = {
  give_item: "giveitem",
  remove_item: "removeitem",
  delete_item: "removeitem",
  clear_inventory: "clearinventory",
  delete_inventory: "clearinventory",
  get_characters: "sync_characters",
  fetch_characters: "sync_characters",
  sync_all: "sync_characters",
  execute_raw: "execute_command",
  console_command: "execute_command"
};

async function executeBridgeCommand(cmd) {
  if (!cmd || typeof cmd.action !== "string") return failure("Geçersiz komut.");
  const action = ACTION_ALIASES[cmd.action] || cmd.action;
  const handler = COMMAND_HANDLERS[action];
  if (!handler) return failure(`Bu köprü sürümü '${cmd.action}' eylemini desteklemiyor.`);
  try {
    const result = await handler(cmd);
    log(`[KOMUT] ${action} (${cmd.id || "-"}) -> ${result.ok ? "başarılı" : "başarısız: " + result.error}`, result.ok ? "^2" : "^3");
    return result;
  } catch (err) {
    log(`[KOMUT] ${action} (${cmd.id || "-"}) hata: ${err.message}`, "^1");
    return failure(err instanceof DbLockedError ? err.message : `Sunucu hatası: ${err.message}`);
  }
}

/* ==========================================================================
   POLL LOOP
   ========================================================================== */

let pendingResults = [];
let pollInFlight = false;

async function pollServer() {
  if (pollInFlight) return;
  pollInFlight = true;
  const reporting = pendingResults;
  pendingResults = [];
  let moreWork = false;
  try {
    const playersList = getPlayersList();
    const response = await signedPost(config.apiUrl, {
      status: "active",
      bridgeVersion: BRIDGE_VERSION,
      playersCount: playersList.length,
      maxPlayers: maxPlayers(),
      players: playersList,
      results: reporting,
      timestamp: Date.now()
    });
    delete lastErrors.Poll;
    const commands = response && Array.isArray(response.commands) ? response.commands : [];
    for (const cmd of commands) {
      const result = await executeBridgeCommand(cmd);
      if (cmd && cmd.id) pendingResults.push({ id: String(cmd.id), ...result });
    }
    moreWork = commands.length > 0;
  } catch (err) {
    // Results not delivered go back to the front of the queue for the next attempt.
    pendingResults = reporting.concat(pendingResults).slice(-MAX_PENDING_RESULTS);
    if (err.status === 429) log("[UYARI] Panel hız sınırı (HTTP 429). Bekleniyor...", "^3");
    else logThrottled("Poll", err.message);
  } finally {
    pollInFlight = false;
  }
  // Report results and pick up follow-up commands right away.
  if (moreWork) setTimeout(pollServer, 100);
}

/* ==========================================================================
   CHARACTER SYNC
   ========================================================================== */

async function sendCharacters(list) {
  for (let i = 0; i < list.length; i += CHARACTER_CHUNK_SIZE) {
    try {
      await signedPost(bridgeUrl("characters"), { characters: list.slice(i, i + CHARACTER_CHUNK_SIZE), timestamp: Date.now() });
      delete lastErrors.Characters;
    } catch (err) {
      logThrottled("Characters", err.message);
      return false;
    }
  }
  return true;
}

// Item list with labels/images filled in from the server's item registry where the inventory entry lacks them.
function enrichInventoryItems(rawInventory, sharedItems) {
  const parsed = parseJson(rawInventory, []);
  const list = Array.isArray(parsed) ? parsed : Object.values(parsed || {});
  return list.filter(item => item && typeof item === "object").map(item => {
    const name = item.name || item.item || null;
    const shared = (name && sharedItems && sharedItems[name]) || {};
    const count = numberOrNull(item.count ?? item.amount ?? item.quantity);
    const image = item.image || item.icon || shared.image || shared.icon || null;
    return { ...item, name, label: item.label || shared.label || null, count, amount: count, image, icon: image };
  });
}

const playerOnlineSessions = new Map();

function updateOnlineSessions(onlineList) {
  const current = new Set();
  const now = Date.now();
  for (const p of onlineList) {
    const key = p.license || p.id;
    current.add(key);
    if (!playerOnlineSessions.has(key)) playerOnlineSessions.set(key, now);
  }
  for (const key of playerOnlineSessions.keys()) {
    if (!current.has(key)) playerOnlineSessions.delete(key);
  }
}

function sessionMinutes(license) {
  const start = license ? playerOnlineSessions.get(license) : null;
  return start ? Math.floor((Date.now() - start) / 60000) : 0;
}

// Character payload for the panel. Every value comes from the framework/database; missing values stay null.
function buildCharacterPayload({ citizenid, cid, license, name, charinfo, money, job, gang, metadata, inventory, identifiers, vehicles, iban, skinModel, online, lastSeen }) {
  const fullName = `${charinfo.firstname || ""} ${charinfo.lastname || ""}`.trim() || name || null;
  const storedPlaytime = numberOrNull(metadata.playtime ?? metadata.playTime);
  return {
    citizenid,
    cid: numberOrNull(cid),
    license: license || null,
    discord: identifiers.discord || null,
    discord_id: cleanIdentifier(identifiers.discord, "discord") || null,
    steam: identifiers.steam || null,
    fivem: identifiers.fivem || null,
    name: fullName,
    firstname: typeof charinfo.firstname === "string" ? charinfo.firstname : null,
    lastname: typeof charinfo.lastname === "string" ? charinfo.lastname : null,
    birthdate: typeof charinfo.birthdate === "string" ? charinfo.birthdate : null,
    phone: charinfo.phone || null,
    gender_raw: charinfo.gender ?? null,
    nationality: charinfo.nationality || null,
    skin_model: skinModel || null,
    iban: iban || charinfo.account || null,
    money,
    charinfo,
    job: job && job.name ? job : null,
    gang: gang && gang.name ? gang : null,
    metadata,
    inventory,
    vehicles: Array.isArray(vehicles) ? vehicles : [],
    playtime: storedPlaytime === null ? null : storedPlaytime + (online ? sessionMinutes(license) : 0),
    is_online: !!online,
    serverId: online ? online.id : null,
    last_seen: online ? null : (lastSeen ? new Date(lastSeen).toISOString() : null)
  };
}

let pendingSyncIds = new Set();
let syncTimer = null;

function queueCharacterSync(target) {
  if (target === true) pendingSyncIds.add("__ALL__");
  else if (typeof target === "string" && target.trim()) pendingSyncIds.add(target.trim());
  else return;
  if (syncTimer) return;
  syncTimer = setTimeout(async () => {
    syncTimer = null;
    const ids = [...pendingSyncIds];
    pendingSyncIds.clear();
    if (ids.includes("__ALL__")) await syncUpdatedCharacters(true);
    else for (const id of ids) await syncUpdatedCharacters(id);
  }, 300);
}

async function lookupByCitizen(query, params) {
  const map = {};
  try {
    for (const row of await dbQuery(query, params)) (map[row.citizenid] = map[row.citizenid] || []).push(row);
  } catch (e) {
    // Optional table that this server may not have.
  }
  return map;
}

let syncInFlight = false;

// Pushes characters to the panel: one (by citizenid) or all. Returns true when the panel accepted the data.
async function syncUpdatedCharacters(target) {
  if (!dbReady) return false;
  const one = typeof target === "string" && target.trim() ? target.trim() : null;
  if (!one && syncInFlight) return true;
  if (!one) syncInFlight = true;
  try {
    const shared = getSharedData().items;
    const onlinePlayers = getPlayersList();
    updateOnlineSessions(onlinePlayers);
    const onlineByCitizen = new Map(onlinePlayers.filter(p => p.citizenid).map(p => [p.citizenid, p]));
    const onlineByLicense = new Map(onlinePlayers.filter(p => p.license).map(p => [p.license, p]));

    const where = one ? " WHERE citizenid = ?" : "";
    const params = one ? [one] : [];
    const [vehicles, banks, skins] = await Promise.all([
      lookupByCitizen(`SELECT citizenid, plate, vehicle, garage, state, fuel FROM player_vehicles${where}`, params),
      lookupByCitizen(`SELECT citizenid, iban FROM tgiann_bank_player_accounts${where}`, params),
      lookupByCitizen(`SELECT citizenid, model FROM playerskins WHERE active = 1${one ? " AND citizenid = ?" : ""}`, params)
    ]);

    const select = "p.citizenid, p.cid, p.license, p.name, p.money, p.charinfo, p.job, p.gang, p.metadata, p.inventory, p.last_updated";
    const rows = hasAdminIdentifiersTable
      ? await dbQuery(`SELECT ${select}, f.discord, f.steam, f.fivem FROM players p LEFT JOIN fx_admin_identifiers f ON f.license = p.license${one ? " WHERE p.citizenid = ?" : ""}`, params)
      : await dbQuery(`SELECT ${select} FROM players p${one ? " WHERE p.citizenid = ?" : ""}`, params);
    if (one && rows.length === 0) return false;

    const payload = rows.map(row => {
      const live = getLiveQBCorePlayer(row.citizenid);
      const pData = live && live.PlayerData ? live.PlayerData : null;
      const online = onlineByCitizen.get(row.citizenid) || (row.license && onlineByLicense.get(row.license)) || null;
      const cached = playerIdentifiersCache.get(row.citizenid) || licenseIdentifiersCache.get(row.license) || {};

      let inventory = row.inventory;
      if (pData && online && GetResourceState("ox_inventory") === "started") {
        try {
          const liveInv = exports["ox_inventory"].GetInventoryItems(parseInt(online.id, 10));
          if (liveInv) inventory = Array.isArray(liveInv) ? liveInv : Object.values(liveInv);
        } catch (e) { }
      } else if (pData && pData.items) {
        inventory = Object.values(pData.items);
      }

      const vehicleRows = (vehicles[row.citizenid] || []).map(v => ({
        plate: v.plate || null,
        vehicle: v.vehicle || null,
        garage: v.garage || null,
        state: numberOrNull(v.state),
        fuel: numberOrNull(v.fuel)
      }));

      // A loaded character's in-memory data is newer than the last database save.
      return buildCharacterPayload({
        citizenid: row.citizenid,
        cid: pData ? pData.cid : row.cid,
        license: row.license,
        name: row.name,
        charinfo: pData ? pData.charinfo || {} : parseJson(row.charinfo, {}),
        money: pData ? pData.money || {} : parseJson(row.money, {}),
        job: pData ? pData.job : parseJson(row.job, null),
        gang: pData ? pData.gang : parseJson(row.gang, null),
        metadata: pData ? pData.metadata || {} : parseJson(row.metadata, {}),
        inventory: enrichInventoryItems(inventory, shared),
        identifiers: {
          discord: row.discord || cached.discord || (online && online.identifiers.find(i => i.startsWith("discord:"))) || "",
          steam: row.steam || cached.steam || "",
          fivem: row.fivem || cached.fivem || ""
        },
        vehicles: vehicleRows,
        iban: (banks[row.citizenid] || [])[0] ? banks[row.citizenid][0].iban : null,
        skinModel: (skins[row.citizenid] || [])[0] ? skins[row.citizenid][0].model : null,
        online,
        lastSeen: row.last_updated
      });
    });
    if (payload.length === 0) return true;
    return await sendCharacters(payload);
  } catch (err) {
    logThrottled("CharacterSync", err.message);
    return false;
  } finally {
    if (!one) syncInFlight = false;
  }
}

/* ==========================================================================
   SHARED DATA (ITEMS, JOBS, GANGS, VEHICLES)
   ========================================================================== */

// Reads the server's own registries. A registry that cannot be read is null (unknown), not an empty list.
function getSharedData() {
  const QBCore = getQBCore();
  const result = { items: null, jobs: null, gangs: null, vehicles: null };
  if (QBCore && QBCore.Shared) {
    result.items = QBCore.Shared.Items ? { ...QBCore.Shared.Items } : null;
    result.jobs = QBCore.Shared.Jobs ? { ...QBCore.Shared.Jobs } : null;
    result.gangs = QBCore.Shared.Gangs ? { ...QBCore.Shared.Gangs } : null;
    result.vehicles = QBCore.Shared.Vehicles ? { ...QBCore.Shared.Vehicles } : null;
  }
  if (isFiveM && GetResourceState("ox_inventory") === "started") {
    try {
      const oxItems = exports["ox_inventory"].Items();
      if (oxItems) {
        result.items = result.items || {};
        for (const [key, item] of Object.entries(oxItems)) {
          const image = item.image || (item.client && item.client.image) || null;
          result.items[key] = {
            name: item.name || key,
            label: item.label || null,
            weight: numberOrNull(item.weight),
            image,
            icon: image,
            description: item.description || null
          };
        }
      }
    } catch (e) { }
  }
  return result;
}

async function syncSharedData() {
  const data = getSharedData();
  if (!data.items && !data.jobs && !data.gangs && !data.vehicles) {
    logThrottled("SharedData", "Framework kayıtları (QBCore.Shared / ox_inventory) okunamadı; panele veri gönderilmedi.");
    return;
  }
  try {
    await signedPost(bridgeUrl("shared-data"), { ...data, timestamp: Date.now() });
    delete lastErrors.SharedData;
  } catch (err) {
    logThrottled("SharedData", err.message);
  }
}

/* ==========================================================================
   STARTUP
   ========================================================================== */

function start() {
  if (!loadConfig()) {
    log("Köprü yapılandırma hatası nedeniyle başlatılmadı.", "^1");
    return;
  }
  log("==========================================================================", "^2");
  log(`  SHIELD-SOFTWARE KÖPRÜSÜ v${RESOURCE_VERSION} (protokol v${BRIDGE_VERSION})`, "^4");
  log(`  Panel     : ${config.apiUrl}`, "^5");
  log(`  Poll      : ${config.pollInterval} ms`, "^5");
  log(`  Veritabanı: ${config.dbLock ? "KİLİTLİ" : "oxmysql (QBCore players)"}`, "^5");
  log("==========================================================================", "^2");

  setTimeout(initDatabase, 500);
  setInterval(pollServer, Math.max(250, Number(config.pollInterval) || 1000));
  setInterval(() => syncUpdatedCharacters(true), FULL_SYNC_INTERVAL_MS);
  setTimeout(syncSharedData, 2000);
  setInterval(syncSharedData, SHARED_SYNC_INTERVAL_MS);

  // Local server event raised by qb-core; deliberately not a net event so clients cannot trigger it.
  on("QBCore:Server:PlayerLoaded", player => {
    if (!player || !player.PlayerData) return;
    updatePlayerIdentifiers(player.PlayerData.source, player.PlayerData.citizenid);
    if (player.PlayerData.citizenid) queueCharacterSync(player.PlayerData.citizenid);
  });
  on("playerDropped", () => {
    setTimeout(() => queueCharacterSync(true), 1000);
  });
}

if (isFiveM) {
  start();
} else if (isTest) {
  module.exports = {
    executeBridgeCommand,
    executeConsoleCommand,
    verifyAmount,
    verifyItem,
    enrichInventoryItems,
    buildCharacterPayload,
    bridgeUrl,
    signedPost,
    pollServer,
    getPendingResults: () => pendingResults,
    setConfig: next => { config = { ...config, ...next }; },
    COMMAND_HANDLERS,
    ACTION_ALIASES,
    BRIDGE_VERSION
  };
} else {
  log("Bu dosya bir FiveM resource'udur; FXServer içinde çalıştırılmalıdır.", "^3");
}
