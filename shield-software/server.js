const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const isFiveM = typeof GetResourcePath !== "undefined";

let config = {
  apiUrl: "http://localhost:3000/api/fivem/bridge/poll",
  secretKey: "",
  pollInterval: 1000,
  serverStatus: true,
  dbLock: false,
  commands: {},
  locations: {}
};

function getTimestamp() {
  const d = new Date();
  const pad = (n) => (n < 10 ? "0" + n : n);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function log(msg, colorCode = "^7") {
  const time = getTimestamp();
  const header = `^7[${time}] ^5[SHIELD-WEB v1.0.0]^7 `;
  if (isFiveM) {
    console.log(`${header}${colorCode}${msg}^7`);
  } else {
    const termColors = {
      "^1": "\x1b[31m",
      "^2": "\x1b[32m",
      "^3": "\x1b[33m",
      "^4": "\x1b[34m",
      "^5": "\x1b[36m",
      "^6": "\x1b[35m",
      "^7": "\x1b[0m"
    };
    let formattedMsg = `${header}${colorCode}${msg}`;
    for (const [code, ansi] of Object.entries(termColors)) {
      formattedMsg = formattedMsg.split(code).join(ansi);
    }
    console.log(`${formattedMsg}\x1b[0m`);
  }
}

// Config Loader
try {
  let configPath = "";
  if (isFiveM) {
    configPath = path.join(GetResourcePath(GetCurrentResourceName()), "config.json");
  } else {
    configPath = path.join(__dirname, "config.json");
  }
  if (fs.existsSync(configPath)) {
    const loadedConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config = { ...config, ...loadedConfig };
  }
} catch (err) {
  log("[ERROR] Config yuklenirken hata: " + err.message, "^1");
}

/* ==========================================================================
   DATABASE LAYER (NATIVE OXMYSQL ASYNC / PROMISE WRAPPER)
   ========================================================================== */

let dbReady = false;
let hasAdminIdentifiersTable = false;

// Mock database storage for Standalone Node.js mode
const mockPlayersDb = [
  {
    citizenid: "KRX13727",
    cid: 1,
    license: "license:4321c6211d42b82a8ecf53bd537d148d3626baad",
    steam: "steam:110000113253354",
    discord: "discord:212223472498114560",
    name: "Kerem U",
    money: JSON.stringify({ cash: 1500, bank: 25000, crypto: 0 }),
    charinfo: JSON.stringify({ firstname: "Kerem", lastname: "U", birthdate: "1995-05-12", gender: 0, phone: "5551234" }),
    job: JSON.stringify({ name: "police", label: "LSPD", grade: { name: "Memur", level: 1 }, onduty: true }),
    gang: JSON.stringify({ name: "none", label: "Yok", grade: { name: "Yok", level: 0 } }),
    metadata: JSON.stringify({ playtime: 240, hunger: 80, thirst: 85 }),
    inventory: JSON.stringify([
      { name: "phone", label: "Telefon", count: 1, amount: 1, slot: 1 },
      { name: "water_bottle", label: "Su Şişesi", count: 3, amount: 3, slot: 2 }
    ]),
    last_updated: new Date()
  }
];

function mockDbQuery(sql, params = []) {
  return new Promise((resolve) => {
    const upperSql = sql.toUpperCase();
    if (upperSql.includes("SELECT 1")) {
      return resolve([{ 1: 1 }]);
    }
    if (upperSql.includes("SHOW TABLES")) {
      return resolve([
        { Tables_in_db: "players" },
        { Tables_in_db: "fx_admin_identifiers" },
        { Tables_in_db: "player_vehicles" },
        { Tables_in_db: "tgiann_bank_player_accounts" },
        { Tables_in_db: "playerskins" }
      ]);
    }
    if (upperSql.includes("FROM PLAYERS")) {
      if (params.length > 0) {
        const filterVal = params[0];
        const filtered = mockPlayersDb.filter(
          (p) => p.citizenid === filterVal || p.license === filterVal
        );
        return resolve(filtered);
      }
      return resolve([...mockPlayersDb]);
    }
    if (upperSql.includes("FROM PLAYER_VEHICLES")) {
      return resolve([
        { citizenid: "KRX13727", plate: "34ABC123", vehicle: "adder", garage: "pillboxgarage", state: 1, fuel: 100, mileage: 12.5 }
      ]);
    }
    if (upperSql.includes("FROM TGIANN_BANK_PLAYER_ACCOUNTS")) {
      return resolve([
        { citizenid: "KRX13727", iban: "TR01 0000 0000 1234 5678" }
      ]);
    }
    if (upperSql.includes("FROM PLAYERSKINS")) {
      return resolve([
        { citizenid: "KRX13727", model: "mp_m_freemode_01" }
      ]);
    }
    resolve([]);
  });
}

/**
 * Executes a SQL query returning an array of rows.
 */
async function dbQuery(query, params = []) {
  if (config.dbLock) {
    log("[DB-LOCK] Veritabanı kilitli olduğu için sorgu atlandı.", "^3");
    return [];
  }
  if (!isFiveM) return mockDbQuery(query, params);

  const ox = global.exports && global.exports.oxmysql;
  if (!ox) throw new Error("oxmysql export'u bulunamadı");

  if (typeof ox.query_async === "function") {
    return await ox.query_async(query, params);
  }

  return new Promise((resolve, reject) => {
    try {
      ox.query(query, params, (result) => {
        resolve(result || []);
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Executes a SQL query returning a single row.
 */
async function dbSingle(query, params = []) {
  if (config.dbLock) return null;
  if (!isFiveM) {
    const rows = await mockDbQuery(query, params);
    return rows && rows.length > 0 ? rows[0] : null;
  }

  const ox = global.exports && global.exports.oxmysql;
  if (ox && typeof ox.single_async === "function") {
    return await ox.single_async(query, params);
  }

  const rows = await dbQuery(query, params);
  return rows && rows.length > 0 ? rows[0] : null;
}

/**
 * Executes a SQL query returning a single scalar value.
 */
async function dbScalar(query, params = []) {
  if (config.dbLock) return null;
  if (!isFiveM) {
    const rows = await mockDbQuery(query, params);
    if (!rows || rows.length === 0) return null;
    return Object.values(rows[0])[0];
  }

  const ox = global.exports && global.exports.oxmysql;
  if (ox && typeof ox.scalar_async === "function") {
    return await ox.scalar_async(query, params);
  }

  const row = await dbSingle(query, params);
  return row ? Object.values(row)[0] : null;
}

/**
 * Executes an INSERT/UPDATE/DELETE query returning affected rows or insertId.
 */
async function dbExecute(query, params = []) {
  if (config.dbLock) return 0;
  if (!isFiveM) return mockDbQuery(query, params);

  const ox = global.exports && global.exports.oxmysql;
  if (ox && typeof ox.update_async === "function") {
    return await ox.update_async(query, params);
  }
  return await dbQuery(query, params);
}

/**
 * Verifies and initializes MariaDB tables and detects structure.
 */
async function initDatabase() {
  if (config.dbLock) {
    log("[DATABASE] 🔒 KİLİTLİ (SQL Okuma/Yazma Kapalı - Sadece RAM & Canlı Mod)", "^3");
    return;
  }

  if (!isFiveM) {
    dbReady = true;
    hasAdminIdentifiersTable = true;
    log("Standalone Node.js test modu: Mock veritabanı aktif.", "^2");
    return;
  }

  let connected = false;
  for (let attempt = 1; attempt <= 25; attempt++) {
    try {
      if (GetResourceState("oxmysql") === "started") {
        await dbScalar("SELECT 1");
        connected = true;
        break;
      }
    } catch (e) {
      // Waiting for database pool
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (connected) {
    dbReady = true;
    log("MariaDB / oxmysql bağlantısı başarıyla doğrulandı.", "^2");

    try {
      const checkAdminTable = await dbQuery("SHOW TABLES LIKE 'fx_admin_identifiers'");
      if (checkAdminTable && checkAdminTable.length > 0) {
        hasAdminIdentifiersTable = true;
        log("Oyuncu identifier tablosu 'fx_admin_identifiers' devrede.", "^2");
      }
    } catch (err) {
      hasAdminIdentifiersTable = false;
    }

    // Trigger full character sync immediately once DB is connected & ready
    setTimeout(() => {
      syncUpdatedCharacters(true);
    }, 500);
  } else {
    log("[WARN] oxmysql bağlantısı henüz hazır değil. Arka planda bekleniyor...", "^3");
  }
}

setTimeout(initDatabase, 500);

/* ==========================================================================
   FRAMEWORK & PLAYER HELPER FUNCTIONS (ZERO RESMON / DIRECT IN-MEMORY)
   ========================================================================== */

const playerIdentifiersCache = new Map(); // citizenid -> { discord, steam, license }
const licenseIdentifiersCache = new Map(); // license -> { discord, steam }

function getQBCore() {
  if (!isFiveM) return null;
  try {
    if (GetResourceState("qb-core") === "started") {
      return exports["qb-core"].GetCoreObject();
    }
  } catch (e) { }
  return null;
}

/**
 * Returns the live QBCore player object from RAM memory (0ms lag, 0 resmon).
 */
function getLiveQBCorePlayer(target) {
  if (!target) return null;
  const QBCore = getQBCore();
  if (!QBCore || !QBCore.Functions) return null;

  try {
    const strTarget = target.toString().trim();
    if (!isNaN(Number(strTarget)) && strTarget.length <= 5) {
      const p = QBCore.Functions.GetPlayer(parseInt(strTarget, 10));
      if (p) return p;
    }
    if (QBCore.Functions.GetPlayerByCitizenId) {
      const p = QBCore.Functions.GetPlayerByCitizenId(strTarget);
      if (p) return p;
    }
  } catch (e) { }
  return null;
}

/**
 * Finds online player by either server id or citizenid.
 */
function getOnlinePlayer(targetPlayer, citizenid) {
  if (targetPlayer) {
    const p = getLiveQBCorePlayer(targetPlayer);
    if (p) return p;
  }
  if (citizenid) {
    const p = getLiveQBCorePlayer(citizenid);
    if (p) return p;
  }
  return null;
}

function isPlayerOnline(targetId) {
  if (targetId === undefined || targetId === null || targetId === "") return false;
  if (!isFiveM) return true;
  const strId = targetId.toString();
  const playersFunc = typeof getPlayers === "function" ? getPlayers : (typeof GetPlayers === "function" ? GetPlayers : null);
  if (playersFunc) {
    try {
      const players = playersFunc();
      if (players && typeof players[Symbol.iterator] === "function") {
        for (const p of players) {
          if (p.toString() === strId) return true;
        }
      }
    } catch (e) { }
  }
  return false;
}

function cleanIdentifier(id, prefix) {
  if (!id) return "";
  const str = String(id).trim();
  if (prefix && str.toLowerCase().startsWith(prefix.toLowerCase() + ":")) {
    return str.slice(prefix.length + 1);
  }
  return str.replace(/^(discord|steam|license|fivem):/i, "");
}

function getPlayerIdentifierByType(source, type) {
  if (!isFiveM || !source) return "";
  const prefix = `${type}:`;
  const count = typeof GetNumPlayerIdentifiers === "function" ? GetNumPlayerIdentifiers(source) : 0;
  for (let i = 0; i < count; i++) {
    const id = GetPlayerIdentifier(source, i);
    if (id && id.startsWith(prefix)) {
      return id;
    }
  }
  return "";
}

/**
 * Updates player identifiers in memory and persists to fx_admin_identifiers
 * without touching players table (preventing unknown column crashes).
 */
async function updatePlayerIdentifiers(source, citizenid) {
  let discord = "";
  let steam = "";
  let license = "";
  let fivem = "";

  if (isFiveM) {
    const count = typeof GetNumPlayerIdentifiers === "function" ? GetNumPlayerIdentifiers(source) : 0;
    for (let i = 0; i < count; i++) {
      const id = GetPlayerIdentifier(source, i);
      if (id) {
        if (id.startsWith("discord:")) discord = id;
        else if (id.startsWith("steam:")) steam = id;
        else if (id.startsWith("license:")) license = id;
        else if (id.startsWith("fivem:")) fivem = id;
      }
    }
  } else {
    discord = "discord:212223472498114560";
    steam = "steam:110000113253354";
    license = "license:4321c6211d42b82a8ecf53bd537d148d3626baad";
    fivem = "fivem:13806981";
  }

  if (citizenid) {
    playerIdentifiersCache.set(citizenid, { discord, steam, license, fivem });
  }
  if (license) {
    licenseIdentifiersCache.set(license, { discord, steam, fivem });
  }

  if (hasAdminIdentifiersTable && license && (discord || steam || fivem)) {
    try {
      await dbExecute(
        `INSERT INTO fx_admin_identifiers (license, discord, steam, fivem, last_seen)
         VALUES (?, ?, ?, ?, UNIX_TIMESTAMP())
         ON DUPLICATE KEY UPDATE discord = VALUES(discord), steam = VALUES(steam), fivem = VALUES(fivem), last_seen = UNIX_TIMESTAMP()`,
        [license, discord || null, steam || null, fivem || null]
      );
    } catch (e) { }
  }
}

/**
 * Retrieves the live online player list with enriched character and identifier data.
 */
function getPlayersList() {
  const list = [];
  const playersFunc = typeof getPlayers === "function" ? getPlayers : (typeof GetPlayers === "function" ? GetPlayers : null);

  if (playersFunc) {
    try {
      const players = playersFunc();
      if (players && typeof players[Symbol.iterator] === "function") {
        for (const p of players) {
          const strId = p.toString();
          const numId = parseInt(strId, 10) || 1;
          const pName = typeof GetPlayerName === "function" ? GetPlayerName(p) : "Bilinmiyor";
          const pPing = typeof GetPlayerPing === "function" ? GetPlayerPing(p) : 0;
          const identifiers = [];
          let rawDiscord = "";
          let rawSteam = "";
          let rawLicense = "";
          let rawFivem = "";

          if (typeof GetNumPlayerIdentifiers === "function" && typeof GetPlayerIdentifier === "function") {
            const count = GetNumPlayerIdentifiers(p);
            for (let i = 0; i < count; i++) {
              const ident = GetPlayerIdentifier(p, i);
              if (ident) {
                identifiers.push(ident);
                if (ident.startsWith("discord:")) rawDiscord = ident;
                else if (ident.startsWith("steam:")) rawSteam = ident;
                else if (ident.startsWith("license:")) rawLicense = ident;
                else if (ident.startsWith("fivem:")) rawFivem = ident;
              }
            }
          }

          const cleanDiscord = cleanIdentifier(rawDiscord, "discord");
          const cleanSteam = cleanIdentifier(rawSteam, "steam");
          const cleanLicense = cleanIdentifier(rawLicense, "license");
          const cleanFivem = cleanIdentifier(rawFivem, "fivem");

          let citizenid = "";
          let charName = pName;
          let jobStr = "İşsiz";
          let jobName = "unemployed";
          let jobLabel = "İşsiz";
          let jobGrade = 0;
          let jobGradeName = "Yok";
          let gangStr = "Yok";
          let gangName = "none";
          let gangLabel = "Yok";
          let cash = 0;
          let bank = 0;
          let crypto = 0;
          let phone = "";
          let health = 200;
          let armor = 0;
          let hunger = 100;
          let thirst = 100;

          const livePlayer = getLiveQBCorePlayer(p);
          if (livePlayer && livePlayer.PlayerData) {
            const pData = livePlayer.PlayerData;
            citizenid = pData.citizenid || "";
            if (pData.charinfo) {
              const fn = pData.charinfo.firstname || "";
              const ln = pData.charinfo.lastname || "";
              if (fn || ln) charName = `${fn} ${ln}`.trim();
              phone = pData.charinfo.phone || "";
            }
            if (pData.job) {
              jobName = pData.job.name || "unemployed";
              jobLabel = pData.job.label || jobName;
              jobGrade = (pData.job.grade && pData.job.grade.level !== undefined) ? pData.job.grade.level : 0;
              jobGradeName = (pData.job.grade && pData.job.grade.name) || "Yok";
              jobStr = `${jobLabel} (${jobGradeName})`;
            }
            if (pData.gang) {
              gangName = pData.gang.name || "none";
              gangLabel = pData.gang.label || gangName;
              gangStr = gangLabel;
            }
            if (pData.money) {
              cash = Number(pData.money.cash) || 0;
              bank = Number(pData.money.bank) || 0;
              crypto = Number(pData.money.crypto) || 0;
            }
            if (pData.metadata) {
              health = pData.metadata.health !== undefined ? Number(pData.metadata.health) : 200;
              armor = pData.metadata.armor !== undefined ? Number(pData.metadata.armor) : 0;
              hunger = pData.metadata.hunger !== undefined ? Number(pData.metadata.hunger) : 100;
              thirst = pData.metadata.thirst !== undefined ? Number(pData.metadata.thirst) : 100;
            }
          }

          let coordsStr = "vec3(0.0, 0.0, 0.0)";
          let coordsObj = { x: 0, y: 0, z: 0 };
          if (typeof GetPlayerPed === "function" && typeof GetEntityCoords === "function") {
            try {
              const ped = GetPlayerPed(p);
              if (ped && ped !== 0) {
                const c = GetEntityCoords(ped);
                if (c) {
                  const x = Array.isArray(c) ? c[0] : (c.x || 0);
                  const y = Array.isArray(c) ? c[1] : (c.y || 0);
                  const z = Array.isArray(c) ? c[2] : (c.z || 0);
                  coordsObj = { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), z: Number(z.toFixed(2)) };
                  coordsStr = `vec3(${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`;
                }
              }
            } catch (e) { }
          }

          list.push({
            id: strId,
            serverId: numId,
            name: pName,
            charName: charName,
            characterName: charName,
            citizenid: citizenid,
            discord: cleanDiscord || rawDiscord,
            discordId: cleanDiscord,
            discord_id: cleanDiscord,
            raw_discord: rawDiscord,
            steam: cleanSteam || rawSteam,
            steamId: cleanSteam,
            steam_id: cleanSteam,
            raw_steam: rawSteam,
            license: rawLicense,
            license_id: cleanLicense,
            fivem: cleanFivem || rawFivem,
            fivem_id: cleanFivem,
            ping: pPing,
            job: jobStr,
            job_name: jobName,
            job_label: jobLabel,
            job_grade: jobGrade,
            job_grade_name: jobGradeName,
            gang: gangStr,
            gang_name: gangName,
            gang_label: gangLabel,
            cash: cash,
            bank: bank,
            crypto: crypto,
            phone: phone,
            coords: coordsStr,
            coordsStr: coordsStr,
            coordsObj: coordsObj,
            isFrozen: false,
            health: health,
            armor: armor,
            hunger: hunger,
            thirst: thirst,
            identifiers: identifiers
          });
        }
      }
    } catch (err) {
      log("Error fetching players list: " + err.message, "^1");
    }
  }
  return list;
}

/* ==========================================================================
   NETWORK & HTTP BRIDGE
   ========================================================================== */

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 20, keepAliveMsecs: 30000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20, keepAliveMsecs: 30000 });

function makeRequest(urlStr, method, headers, bodyData) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === "https:";
    const protocol = isHttps ? https : http;
    const dataStr = bodyData ? JSON.stringify(bodyData) : "";

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: method,
      agent: isHttps ? httpsAgent : httpAgent,
      headers: {
        "User-Agent": "FiveM-Server-Bridge/1.9.0",
        ...headers,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(dataStr)
      }
    };

    const req = protocol.request(options, (res) => {
      let responseBody = "";
      res.on("data", (chunk) => {
        responseBody += chunk;
      });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(responseBody));
          } catch (err) {
            resolve(responseBody);
          }
        } else {
          reject(new Error(`HTTP Status ${res.statusCode}: ${responseBody}`));
        }
      });
    });

    req.on("error", (err) => {
      reject(err);
    });

    if (dataStr) {
      req.write(dataStr);
    }
    req.end();
  });
}

function formatErrorMessage(err) {
  if (!err) return "Bilinmeyen hata";
  let msg = err.message || err.toString();
  try {
    if (msg.includes("HTTP Status ")) {
      const match = msg.match(/HTTP Status (\d+):\s*(.*)/);
      if (match) {
        const statusCode = match[1];
        const rawBody = match[2];
        try {
          const json = JSON.parse(rawBody);
          if (json && json.message) {
            return `HTTP ${statusCode} - ${json.message}`;
          }
        } catch (e) {
          if (rawBody) return `HTTP ${statusCode} - ${rawBody}`;
        }
        return `HTTP Status ${statusCode}`;
      }
    }
  } catch (e) { }
  return msg;
}

let lastPollErrorMsg = null;
let lastPollErrorTime = 0;
let lastCharSyncErrorMsg = null;
let lastCharSyncErrorTime = 0;
let lastSharedSyncErrorMsg = null;
let lastSharedSyncErrorTime = 0;

/* ==========================================================================
   DIRECT CODE EXECUTION (ZERO TERMINAL / RESMON IMPACT)
   ========================================================================== */

/**
 * Server-side transaction verification helpers for economy security.
 * Prevents unverified client amounts, invalid items, or negative balance exploits.
 */
function verifyServerSideAmount(rawAmount, maxCap = 1000) {
  if (rawAmount === undefined || rawAmount === null) return 0;
  const num = Math.floor(Number(rawAmount));
  if (isNaN(num) || !Number.isFinite(num) || num <= 0) return 0;
  return Math.min(num, maxCap);
}

function verifyServerSideItem(rawItem, QBCoreObj) {
  if (typeof rawItem !== "string") return "";
  const cleaned = rawItem.trim().toLowerCase();
  if (!/^[a-z0-9_.-]+$/.test(cleaned)) return "";
  const QBC = QBCoreObj || getQBCore();
  if (QBC && QBC.Shared && QBC.Shared.Items && Object.keys(QBC.Shared.Items).length > 0) {
    if (!QBC.Shared.Items[cleaned]) return "";
  }
  return cleaned;
}

/**
 * Server-side verified Economy Executants.
 * All amounts and items are strictly calculated and validated on the server.
 */
async function serverAddPlayerItem(targetPlayer, citizenid, rawItem, rawAmount) {
  const itemCode = verifyServerSideItem(rawItem);
  const verifiedAmount = verifyServerSideAmount(rawAmount, 1000);

  if (!itemCode) {
    log("[SECURITY ERROR] serverAddPlayerItem: Eşya kütükte bulunamadı veya geçersiz karakter", "^1");
    return false;
  }
  if (verifiedAmount <= 0) {
    log(`[SECURITY WARNING] serverAddPlayerItem: Geçersiz eşya miktarı (${rawAmount}) reddedildi`, "^1");
    return false;
  }

  const player = getOnlinePlayer(targetPlayer, citizenid);
  if (player) {
    const srcNum = parseInt(player.PlayerData.source, 10);
    let given = false;
    if (GetResourceState("ox_inventory") === "started") {
      try {
        const ox = exports["ox_inventory"];
        if (ox && typeof ox.AddItem === "function") {
          given = ox.AddItem(srcNum, itemCode, verifiedAmount);
        }
      } catch (e) { }
    }
    if (!given && player.Functions && typeof player.Functions.AddItem === "function") {
      player.Functions.AddItem(itemCode, verifiedAmount);
      player.Functions.Save();
    }
    log(`[KOD MOTORU] Canlı oyuncuya eşya verildi: ${player.PlayerData.citizenid} -> ${itemCode} x${verifiedAmount}`, "^2");
  } else if (citizenid) {
    const citId = citizenid;
    const row = await dbSingle("SELECT inventory FROM players WHERE citizenid = ?", [citId]);
    if (row) {
      let inv = [];
      try { inv = typeof row.inventory === "string" ? JSON.parse(row.inventory) : (row.inventory || []); } catch (e) { }
      if (!Array.isArray(inv)) inv = Object.values(inv);

      const existing = inv.find((i) => i && (i.name === itemCode || i.item === itemCode));
      if (existing) {
        existing.count = (existing.count || existing.amount || 1) + verifiedAmount;
        if (existing.amount !== undefined) existing.amount = existing.count;
      } else {
        const maxSlot = inv.reduce((max, i) => (i && i.slot > max ? i.slot : max), 0);
        inv.push({
          name: itemCode,
          count: verifiedAmount,
          amount: verifiedAmount,
          slot: maxSlot + 1
        });
      }
      await dbExecute("UPDATE players SET inventory = ? WHERE citizenid = ?", [JSON.stringify(inv), citId]);
      log(`[KOD MOTORU - OFFLINE] Çevrimdışı oyuncuya eşya eklendi: ${citId} -> ${itemCode} x${verifiedAmount}`, "^2");
    }
  }
  queueCharacterSync(citizenid || (player && player.PlayerData.citizenid));
  return true;
}

async function serverRemovePlayerItem(targetPlayer, citizenid, rawItem, rawAmount, rawSlot) {
  const rawItemStr = typeof rawItem === "string" ? rawItem.trim().toLowerCase() : "";
  const itemCode = verifyServerSideItem(rawItemStr) || rawItemStr;
  const itemSlot = rawSlot !== undefined && rawSlot !== null ? Number(rawSlot) : null;
  const verifiedAmount = verifyServerSideAmount(rawAmount, 1000) || 1;

  if (verifiedAmount <= 0) {
    log(`[SECURITY WARNING] serverRemovePlayerItem: Geçersiz miktar (${rawAmount}) reddedildi`, "^1");
    return false;
  }

  const player = getOnlinePlayer(targetPlayer, citizenid);
  if (player) {
    const srcNum = parseInt(player.PlayerData.source, 10);
    let removed = false;
    if (GetResourceState("ox_inventory") === "started") {
      try {
        const ox = exports["ox_inventory"];
        if (ox && typeof ox.RemoveItem === "function") {
          ox.RemoveItem(srcNum, itemCode, verifiedAmount, null, itemSlot);
          removed = true;
        }
      } catch (e) { }
    }
    if (!removed && player.Functions && typeof player.Functions.RemoveItem === "function") {
      player.Functions.RemoveItem(itemCode, verifiedAmount, itemSlot);
      player.Functions.Save();
    }
    log(`[KOD MOTORU] Canlı oyuncudan eşya silindi: ${itemCode || 'Slot ' + itemSlot} x${verifiedAmount}`, "^2");
  } else if (citizenid) {
    const citId = citizenid;
    const row = await dbSingle("SELECT inventory FROM players WHERE citizenid = ?", [citId]);
    if (row) {
      let inv = [];
      try { inv = typeof row.inventory === "string" ? JSON.parse(row.inventory) : (row.inventory || []); } catch (e) { }
      if (!Array.isArray(inv)) inv = Object.values(inv);

      if (itemSlot !== undefined && itemSlot !== null) {
        inv = inv.filter((i) => i && i.slot !== Number(itemSlot));
      } else if (itemCode) {
        inv = inv.filter((i) => {
          if (!i) return false;
          if (i.name === itemCode || i.item === itemCode) {
            const currentCount = i.count || i.amount || 1;
            if (currentCount > verifiedAmount) {
              i.count = currentCount - verifiedAmount;
              i.amount = i.count;
              return true;
            }
            return false;
          }
          return true;
        });
      }
      await dbExecute("UPDATE players SET inventory = ? WHERE citizenid = ?", [JSON.stringify(inv), citId]);
      log(`[KOD MOTORU - OFFLINE] Çevrimdışı oyuncudan eşya silindi: ${citId}`, "^2");
    }
  }
  queueCharacterSync(citizenid || (player && player.PlayerData.citizenid));
  return true;
}

async function serverClearPlayerInventory(targetPlayer, citizenid) {
  const player = getOnlinePlayer(targetPlayer, citizenid);
  if (player) {
    const srcNum = parseInt(player.PlayerData.source, 10);
    if (GetResourceState("ox_inventory") === "started") {
      try {
        const ox = exports["ox_inventory"];
        if (ox && typeof ox.ClearInventory === "function") {
          ox.ClearInventory(srcNum);
        }
      } catch (e) { }
    }
    if (player.Functions && typeof player.Functions.ClearInventory === "function") {
      player.Functions.ClearInventory();
    }
    player.Functions.Save();
    log(`[KOD MOTORU] Canlı oyuncunun envanteri sıfırlandı: ${player.PlayerData.citizenid}`, "^2");
  }

  const citId = citizenid || (player && player.PlayerData.citizenid);
  if (citId) {
    await dbExecute("UPDATE players SET inventory = '[]' WHERE citizenid = ?", [citId]);
    log(`[KOD MOTORU] SQL envanter verisi sıfırlandı: ${citId}`, "^2");
  }
  queueCharacterSync(citId);
  return true;
}

async function serverAddPlayerMoney(targetPlayer, citizenid, rawType, rawAmount) {
  const moneyType = rawType === "bank" ? "bank" : (rawType === "crypto" ? "crypto" : "cash");
  const verifiedAmount = verifyServerSideAmount(rawAmount, 100000000);

  if (verifiedAmount <= 0) {
    log(`[SECURITY WARNING] serverAddPlayerMoney: Geçersiz para miktarı ($${rawAmount}) reddedildi`, "^1");
    return false;
  }

  const player = getOnlinePlayer(targetPlayer, citizenid);
  if (player) {
    if (player.Functions && typeof player.Functions.AddMoney === "function") {
      player.Functions.AddMoney(moneyType, verifiedAmount, "SHIELD-WEB Bridge Server Verified");
      player.Functions.Save();
      log(`[KOD MOTORU] Canlı oyuncuya para eklendi: ${player.PlayerData.citizenid} -> $${verifiedAmount} (${moneyType})`, "^2");
    }
  } else if (citizenid) {
    const citId = citizenid;
    const row = await dbSingle("SELECT money FROM players WHERE citizenid = ?", [citId]);
    if (row) {
      let money = {};
      try { money = typeof row.money === "string" ? JSON.parse(row.money) : (row.money || {}); } catch (e) { }
      money[moneyType] = (Number(money[moneyType]) || 0) + verifiedAmount;
      await dbExecute("UPDATE players SET money = ? WHERE citizenid = ?", [JSON.stringify(money), citId]);
      log(`[KOD MOTORU - OFFLINE] Çevrimdışı oyuncuya para eklendi: ${citId} -> $${verifiedAmount} (${moneyType})`, "^2");
    }
  }
  queueCharacterSync(citizenid || (player && player.PlayerData.citizenid));
  return true;
}

/**
 * Executes incoming web bridge commands directly through framework exports,
 * player objects, and direct SQL without invoking the terminal/console.
 */
async function executeBridgeCommand(cmd) {
  if (!cmd || !cmd.action) return;
  log(`İşlem alınıyor: ${cmd.action} (ID: ${cmd.id || 'Yok'})`, "^2");

  const QBCore = getQBCore();

  // 1. SETJOB
  if (cmd.action === "setjob") {
    const jobName = cmd.job;
    const gradeNum = Number(cmd.grade) || 0;
    if (!jobName) {
      log("[ERROR] setjob: Meslek adı eksik", "^1");
      return;
    }

    const player = getOnlinePlayer(cmd.targetPlayer, cmd.citizenid);
    if (player) {
      // Direct framework execution (0ms resmon)
      if (player.Functions && player.Functions.SetJob) {
        player.Functions.SetJob(jobName, gradeNum);
        player.Functions.Save();
        log(`[KOD MOTORU] Canlı oyuncu mesleği atandı: ${player.PlayerData.citizenid} -> ${jobName} (${gradeNum})`, "^2");
      }
    } else if (cmd.citizenid) {
      // Offline direct SQL update
      const citId = cmd.citizenid;
      const row = await dbSingle("SELECT job FROM players WHERE citizenid = ?", [citId]);
      if (row) {
        let job = {};
        try { job = typeof row.job === "string" ? JSON.parse(row.job) : (row.job || {}); } catch (e) { }
        const sharedJobs = (QBCore && QBCore.Shared && QBCore.Shared.Jobs) || {};
        const jobInfo = sharedJobs[jobName] || {};
        const gradeInfo = (jobInfo.grades && jobInfo.grades[gradeNum.toString()]) || {};

        job.name = jobName;
        job.label = jobInfo.label || jobName;
        job.grade = {
          name: gradeInfo.name || `Kademe ${gradeNum}`,
          level: gradeNum
        };
        job.onduty = true;
        job.isboss = gradeInfo.isboss || false;
        job.payment = gradeInfo.payment || 0;

        await dbExecute("UPDATE players SET job = ? WHERE citizenid = ?", [JSON.stringify(job), citId]);
        log(`[KOD MOTORU - OFFLINE] Çevrimdışı oyuncu mesleği güncellendi: ${citId} -> ${jobName} (${gradeNum})`, "^2");
      }
    }
    queueCharacterSync(cmd.citizenid || (player && player.PlayerData.citizenid));
  }

  // 2. SETGANG
  else if (cmd.action === "setgang") {
    const gangName = cmd.gang;
    const gradeNum = Number(cmd.grade) || 0;
    if (!gangName) {
      log("[ERROR] setgang: Çete adı eksik", "^1");
      return;
    }

    const player = getOnlinePlayer(cmd.targetPlayer, cmd.citizenid);
    if (player) {
      if (player.Functions && player.Functions.SetGang) {
        player.Functions.SetGang(gangName, gradeNum);
        player.Functions.Save();
        log(`[KOD MOTORU] Canlı oyuncu çetesi atandı: ${player.PlayerData.citizenid} -> ${gangName} (${gradeNum})`, "^2");
      }
    } else if (cmd.citizenid) {
      const citId = cmd.citizenid;
      const row = await dbSingle("SELECT gang FROM players WHERE citizenid = ?", [citId]);
      if (row) {
        let gang = {};
        try { gang = typeof row.gang === "string" ? JSON.parse(row.gang) : (row.gang || {}); } catch (e) { }
        const sharedGangs = (QBCore && QBCore.Shared && QBCore.Shared.Gangs) || {};
        const gangInfo = sharedGangs[gangName] || {};
        const gradeInfo = (gangInfo.grades && gangInfo.grades[gradeNum.toString()]) || {};

        gang.name = gangName;
        gang.label = gangInfo.label || gangName;
        gang.grade = {
          name: gradeInfo.name || `Kademe ${gradeNum}`,
          level: gradeNum
        };
        gang.isboss = gradeInfo.isboss || false;

        await dbExecute("UPDATE players SET gang = ? WHERE citizenid = ?", [JSON.stringify(gang), citId]);
        log(`[KOD MOTORU - OFFLINE] Çevrimdışı oyuncu çetesi güncellendi: ${citId} -> ${gangName} (${gradeNum})`, "^2");
      }
    }
    queueCharacterSync(cmd.citizenid || (player && player.PlayerData.citizenid));
  }

  // 3. GIVEITEM
  else if (cmd.action === "giveitem" || cmd.action === "give_item") {
    await serverAddPlayerItem(cmd.targetPlayer, cmd.citizenid, cmd.item, cmd.amount);
  }

  // 4. REMOVEITEM / DELETE_ITEM
  else if (cmd.action === "removeitem" || cmd.action === "remove_item" || cmd.action === "delete_item") {
    await serverRemovePlayerItem(cmd.targetPlayer, cmd.citizenid, cmd.item || cmd.itemName, cmd.amount, cmd.slot);
  }

  // 5. CLEARINVENTORY
  else if (cmd.action === "clearinventory" || cmd.action === "clear_inventory" || cmd.action === "delete_inventory") {
    await serverClearPlayerInventory(cmd.targetPlayer, cmd.citizenid);
  }

  // 6. GIVEMONEY
  else if (cmd.action === "givemoney") {
    await serverAddPlayerMoney(cmd.targetPlayer, cmd.citizenid, cmd.type, cmd.amount);
  }

  // 7. REVIVE
  else if (cmd.action === "revive") {
    const player = getOnlinePlayer(cmd.targetPlayer, cmd.citizenid);
    if (player && isFiveM) {
      const src = parseInt(player.PlayerData.source, 10);
      TriggerClientEvent("hospital:client:Revive", src);
      TriggerClientEvent("hospital:client:HealInjuries", src, "full");
      log(`[KOD MOTORU] Oyuncu canlandırıldı (ID: ${src})`, "^2");
    }
  }

  // 8. KILL
  else if (cmd.action === "kill") {
    const player = getOnlinePlayer(cmd.targetPlayer, cmd.citizenid);
    if (player && isFiveM) {
      const src = parseInt(player.PlayerData.source, 10);
      TriggerClientEvent("hospital:client:KillPlayer", src);
      log(`[KOD MOTORU] Oyuncu öldürüldü (ID: ${src})`, "^2");
    }
  }

  // 9. PEDMENU (CLOTHING / APPEARANCE)
  else if (cmd.action === "pedmenu") {
    const player = getOnlinePlayer(cmd.targetPlayer, cmd.citizenid);
    if (player && isFiveM) {
      const src = parseInt(player.PlayerData.source, 10);
      TriggerClientEvent("illenium-appearance:client:openClothingMenu", src);
      TriggerClientEvent("qb-clothing:client:openMenu", src);
      log(`[KOD MOTORU] Oyuncu için kıyafet/ped menüsü açıldı (ID: ${src})`, "^2");
    }
  }

  // 10. PEDVER
  else if (cmd.action === "pedver") {
    const player = getOnlinePlayer(cmd.targetPlayer, cmd.citizenid);
    if (player && cmd.ped && isFiveM) {
      const src = parseInt(player.PlayerData.source, 10);
      TriggerClientEvent("illenium-appearance:client:changePed", src, cmd.ped);
      log(`[KOD MOTORU] Oyuncu ped modeli değiştirildi: ID ${src} -> ${cmd.ped}`, "^2");
    }
  }

  // 11. PEDAL
  else if (cmd.action === "pedal") {
    const player = getOnlinePlayer(cmd.targetPlayer, cmd.citizenid);
    if (player && isFiveM) {
      const src = parseInt(player.PlayerData.source, 10);
      TriggerClientEvent("illenium-appearance:client:resetPed", src);
      log(`[KOD MOTORU] Oyuncu ped modeli sıfırlandı (ID: ${src})`, "^2");
    }
  }

  // 12. VRETURN (VEHICLE RETURN)
  else if (cmd.action === "vreturn") {
    let plate = cmd.plate;
    if (!plate && cmd.command) {
      const parts = cmd.command.trim().split(/\s+/);
      if (parts.length >= 3) plate = parts[2];
      else if (parts.length === 2) plate = parts[1];
    }
    if (plate) {
      const formattedPlate = plate.toString().trim().toUpperCase();
      if (isFiveM) {
        const player = getOnlinePlayer(cmd.targetPlayer, cmd.citizenid);
        if (player && player.PlayerData && player.PlayerData.source) {
          const src = parseInt(player.PlayerData.source, 10);
          TriggerClientEvent("arcanium-web:client:vreturn", src, formattedPlate);
          TriggerClientEvent("ps-web:client:vreturn", src, formattedPlate);
          log(`[KOD MOTORU] Araç çekme isteği hedef oyuncuya iletildi: Plaka ${formattedPlate} (ID: ${src})`, "^2");
        } else {
          // Check vehicle owner in SQL to find online player source
          dbSingle("SELECT citizenid FROM player_vehicles WHERE UPPER(REPLACE(plate, ' ', '')) = ?", [formattedPlate.replace(/\s+/g, '')]).then((row) => {
            if (row && row.citizenid) {
              const ownerPlayer = getLiveQBCorePlayer(row.citizenid);
              if (ownerPlayer && ownerPlayer.PlayerData && ownerPlayer.PlayerData.source) {
                const src = parseInt(ownerPlayer.PlayerData.source, 10);
                TriggerClientEvent("arcanium-web:client:vreturn", src, formattedPlate);
                TriggerClientEvent("ps-web:client:vreturn", src, formattedPlate);
                log(`[KOD MOTORU] Araç sahibi oyuncuya vreturn iletildi: Plaka ${formattedPlate} (ID: ${src})`, "^2");
                return;
              }
            }
            log(`[KOD MOTORU] Araç çekme isteği işlendi (Çevrimdışı/Sahipsiz): Plaka ${formattedPlate}`, "^2");
          }).catch(() => { });
        }
      }
    }
  }

  // 13. SEND_DM (ADMIN DIRECT MESSAGE)
  else if (cmd.action === "send_dm") {
    const player = getOnlinePlayer(cmd.targetPlayer, cmd.citizenid);
    if (player && isFiveM) {
      const src = parseInt(player.PlayerData.source, 10);
      const adminName = cmd.admin || "Yönetici";
      const message = cmd.reason || cmd.command || "";
      TriggerClientEvent("chat:addMessage", src, {
        template: '<div style="padding: 16px; background: rgba(15, 23, 42, 0.95); border: 2px solid #3b82f6; border-radius: 10px; font-family: sans-serif; box-shadow: 0 10px 25px rgba(0,0,0,0.8); max-width: 600px; margin: 15px auto; text-align: center;"><div style="font-weight: 800; color: #3b82f6; font-size: 16px; margin-bottom: 8px;">SHIELD-WEB Yetkili Mesajı ({0})</div><div style="color: #fff; font-size: 14px; line-height: 1.5;">{1}</div></div>',
        args: [adminName, message]
      });
      TriggerClientEvent("QBCore:Notify", src, `Yetkili Mesajı (${adminName}): ${message}`, "primary", 10000);
      log(`[KOD MOTORU] Oyuncuya yetkili mesajı iletildi (ID: ${src})`, "^2");
    }
  }

  // 14. UPDATE_CHARACTER
  else if (cmd.action === "update_character") {
    const citId = cmd.citizenid || cmd.identifier || "";
    if (citId) {
      const player = getLiveQBCorePlayer(citId);
      if (player) {
        if (cmd.firstname !== undefined && player.PlayerData.charinfo) player.PlayerData.charinfo.firstname = cmd.firstname;
        if (cmd.lastname !== undefined && player.PlayerData.charinfo) player.PlayerData.charinfo.lastname = cmd.lastname;
        if (cmd.birthdate !== undefined && player.PlayerData.charinfo) player.PlayerData.charinfo.birthdate = cmd.birthdate;
        if (cmd.cash !== undefined && player.Functions.SetMoney) player.Functions.SetMoney("cash", Number(cmd.cash));
        if (cmd.bank !== undefined && player.Functions.SetMoney) player.Functions.SetMoney("bank", Number(cmd.bank));
        if (cmd.jobName !== undefined && player.Functions.SetJob) {
          player.Functions.SetJob(cmd.jobName, Number(cmd.jobGrade) || 0);
        }
        player.Functions.Save();
        log(`[KOD MOTORU] Canlı oyuncu RAM verisi güncellendi: ${citId}`, "^2");
      }

      const row = await dbSingle("SELECT charinfo, money, job FROM players WHERE citizenid = ?", [citId]);
      if (row) {
        let charinfo = {};
        try { charinfo = typeof row.charinfo === "string" ? JSON.parse(row.charinfo) : (row.charinfo || {}); } catch (e) { }
        let money = {};
        try { money = typeof row.money === "string" ? JSON.parse(row.money) : (row.money || {}); } catch (e) { }
        let job = {};
        try { job = typeof row.job === "string" ? JSON.parse(row.job) : (row.job || {}); } catch (e) { }

        if (cmd.firstname !== undefined) charinfo.firstname = cmd.firstname;
        if (cmd.lastname !== undefined) charinfo.lastname = cmd.lastname;
        if (cmd.birthdate !== undefined) charinfo.birthdate = cmd.birthdate;
        if (cmd.cash !== undefined) money.cash = Number(cmd.cash);
        if (cmd.bank !== undefined) money.bank = Number(cmd.bank);
        if (cmd.jobName !== undefined) job.name = cmd.jobName;
        if (cmd.jobGrade !== undefined) {
          const lvl = Number(cmd.jobGrade) || 0;
          job.grade = { level: lvl, name: cmd.jobGrade.toString() };
        }

        const fullName = `${charinfo.firstname || ''} ${charinfo.lastname || ''}`.trim() || "Karakter";
        await dbExecute(
          "UPDATE players SET charinfo = ?, money = ?, job = ?, name = ? WHERE citizenid = ?",
          [JSON.stringify(charinfo), JSON.stringify(money), JSON.stringify(job), fullName, citId]
        );
        log(`[KOD MOTORU] Veritabanı karakteri güncellendi: ${citId} (${fullName})`, "^2");
      }
      queueCharacterSync(citId);
    }
  }

  // 15. DELETE_CHARACTER
  else if (cmd.action === "delete_character") {
    const citizenid = cmd.citizenid;
    if (citizenid) {
      const livePlayer = getLiveQBCorePlayer(citizenid);
      if (livePlayer && livePlayer.PlayerData && livePlayer.PlayerData.source && isFiveM) {
        DropPlayer(parseInt(livePlayer.PlayerData.source, 10), "Karakteriniz yetkili tarafından silindi. Lütfen tekrar bağlanın.");
      }
      await dbExecute("DELETE FROM players WHERE citizenid = ?", [citizenid]);
      await dbExecute("DELETE FROM player_vehicles WHERE citizenid = ?", [citizenid]).catch(() => { });
      await dbExecute("DELETE FROM player_houses WHERE citizenid = ?", [citizenid]).catch(() => { });
      await dbExecute("DELETE FROM player_mails WHERE citizenid = ?", [citizenid]).catch(() => { });
      await dbExecute("DELETE FROM player_outfits WHERE citizenid = ?", [citizenid]).catch(() => { });
      await dbExecute("DELETE FROM playerskins WHERE citizenid = ?", [citizenid]).catch(() => { });
      await dbExecute("DELETE FROM tgiann_bank_player_accounts WHERE citizenid = ?", [citizenid]).catch(() => { });
      log(`[KOD MOTORU] Karakter ve ilişkili tablolar silindi: ${citizenid}`, "^2");
    }
  }

  // 16. SYNC CHARACTERS
  else if (
    cmd.action === "get_characters" ||
    cmd.action === "fetch_characters" ||
    cmd.action === "sync_characters" ||
    cmd.action === "sync_all"
  ) {
    log("[INFO] Web panelinden tam karakter senkronizasyon isteği alındı.", "^2");
    queueCharacterSync(true);
  }

  // 17. SAFE DIRECT API RESOURCE & BROADCAST EXECUTION (NO ExecuteCommand AST RISK)
  else if (cmd.action === "execute_command" && cmd.command && isFiveM) {
    const rawCmd = String(cmd.command).trim();
    const parts = rawCmd.split(/\s+/);
    const cmdName = parts[0].toLowerCase();
    const resName = parts[1] || "";

    if (cmdName === "start" || cmdName === "ensure") {
      if (resName && typeof StartResource === "function") {
        StartResource(resName);
        log(`[API MOTORU] Sunucu kaynağı başlatıldı: ${resName}`, "^2");
      }
    } else if (cmdName === "stop") {
      if (resName && typeof StopResource === "function") {
        StopResource(resName);
        log(`[API MOTORU] Sunucu kaynağı durduruldu: ${resName}`, "^2");
      }
    } else if (cmdName === "restart") {
      if (resName && typeof StopResource === "function" && typeof StartResource === "function") {
        StopResource(resName);
        setTimeout(() => StartResource(resName), 500);
        log(`[API MOTORU] Sunucu kaynağı yeniden başlatıldı: ${resName}`, "^2");
      }
    } else if (cmdName === "say" || cmdName === "announce") {
      const announcement = parts.slice(1).join(" ");
      if (announcement) {
        TriggerClientEvent("chat:addMessage", -1, {
          color: [255, 165, 0],
          multiline: true,
          args: ["[YÖNETİCİ DUYURUSU]", announcement]
        });
        log(`[API MOTORU] Sunucu duyurusu yayınlandı: ${announcement}`, "^2");
      }
    } else {
      log(`[SECURITY WARNING] İzin verilmeyen veya güvensiz komut engellendi: ${rawCmd}`, "^1");
    }
  }

  // 18. KICK (PLAYER DISCONNECT)
  else if (cmd.action === "kick") {
    const src = parseInt(cmd.targetPlayer, 10);
    const reason = cmd.reason || "Sunucudan yetkili tarafından atıldınız.";
    const admin = cmd.admin || "Yönetici";
    if (isFiveM && !isNaN(src)) {
      let pName = "Bilinmeyen";
      try {
        if (typeof GetPlayerName === "function") pName = GetPlayerName(src) || pName;
      } catch (e) {}
      DropPlayer(src, `[SHIELD] Sunucudan Atıldınız (Kick)\nSebep: ${reason}\nYetkili: ${admin}`);
      log(`[KOD MOTORU] Oyuncu sunucudan atıldı (Kick): ID ${src} (${pName}) | Sebep: ${reason} | Yetkili: ${admin}`, "^2");
    } else {
      log(`[MOCK/TEST] Oyuncu kicklendi: ID ${cmd.targetPlayer} | Sebep: ${reason}`, "^2");
    }
  }

  // 19. BAN (PLAYER BAN & SQL INSERT & DISCONNECT)
  else if (cmd.action === "ban") {
    const src = parseInt(cmd.targetPlayer, 10);
    const reason = cmd.reason || "Sunucudan yasaklandınız.";
    const admin = cmd.admin || "Yönetici";
    const durationLabel = cmd.duration || (cmd.isPerma ? "Kalıcı (Perma)" : "Süreli");
    const expireTime = Number(cmd.expire) || (cmd.isPerma ? 2147483647 : (Math.floor(Date.now() / 1000) + (Number(cmd.durationSeconds) || 86400)));

    if (isFiveM && !isNaN(src)) {
      let pName = cmd.playerName || "Bilinmeyen";
      let license = cmd.license || "";
      let discord = cmd.discordId ? ("discord:" + cmd.discordId) : "";
      let ip = "";

      try {
        if (typeof GetPlayerName === "function") pName = GetPlayerName(src) || pName;
        if (typeof GetPlayerEndpoint === "function") ip = GetPlayerEndpoint(src) || "";
        if (typeof GetNumPlayerIdentifiers === "function" && typeof GetPlayerIdentifier === "function") {
          const count = GetNumPlayerIdentifiers(src);
          for (let i = 0; i < count; i++) {
            const ident = GetPlayerIdentifier(src, i);
            if (!ident) continue;
            if (ident.startsWith("license:") && !license) license = ident;
            else if (ident.startsWith("discord:") && !discord) discord = ident;
            else if (ident.startsWith("ip:") && !ip) ip = ident.replace("ip:", "");
          }
        }
      } catch (e) {}

      // QBCore Framework Ban Function Call if available
      try {
        if (QBCore && QBCore.Functions) {
          if (typeof QBCore.Functions.CreateBan === "function") {
            QBCore.Functions.CreateBan(src, reason, cmd.isPerma ? 2147483647 : (cmd.durationSeconds || 86400), admin);
          } else if (typeof QBCore.Functions.Ban === "function") {
            QBCore.Functions.Ban(src, reason, cmd.isPerma ? 2147483647 : (cmd.durationSeconds || 86400), admin);
          }
        }
      } catch (e) {
        log(`[KOD MOTORU] QBCore ban fonksiyon uyarısı: ${e.message}`, "^3");
      }

      // Direct SQL bans table insert for server database compatibility
      try {
        await dbExecute(
          "INSERT INTO bans (name, license, discord, ip, reason, expire, bannedby) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [pName, license, discord, ip, reason, expireTime, admin]
        ).catch(() => {});
      } catch (e) {}

      // Immediately kick/disconnect player with formatted reason and duration
      DropPlayer(src, `[SHIELD] Sunucudan Yasaklandınız (Ban)\nSüre: ${durationLabel}\nSebep: ${reason}\nYetkili: ${admin}`);
      log(`[KOD MOTORU] Oyuncu yasaklandı (Ban): ID ${src} (${pName}) | Süre: ${durationLabel} | Sebep: ${reason} | Yetkili: ${admin}`, "^2");
    } else {
      log(`[MOCK/TEST] Oyuncu yasaklandı (Ban): ID ${cmd.targetPlayer} | Süre: ${durationLabel} | Sebep: ${reason}`, "^2");
    }
  }
  else if (cmd.action === "start_screen_watch") {
    const player = getOnlinePlayer(cmd.targetPlayer, cmd.citizenid);
    if (player && isFiveM) {
      const src = parseInt(player.PlayerData.source, 10);
      TriggerClientEvent("shield:client:startScreenWatch", src, {
        token: cmd.token,
        uploadUrl: cmd.uploadUrl,
        interval: cmd.interval || 850,
        quality: cmd.quality || 0.45
      });
      log(`[EKRAN İZLEME] Canlı ekran izleme başlatıldı: ID ${src}`, "^2");
    } else if (cmd.targetPlayer && isFiveM) {
      const srcNum = parseInt(cmd.targetPlayer, 10);
      if (!isNaN(srcNum)) {
        TriggerClientEvent("shield:client:startScreenWatch", srcNum, {
          token: cmd.token,
          uploadUrl: cmd.uploadUrl,
          interval: cmd.interval || 850,
          quality: cmd.quality || 0.45
        });
        log(`[EKRAN İZLEME] Canlı ekran izleme başlatıldı: ID ${srcNum}`, "^2");
      }
    }
  }
  else if (cmd.action === "stop_screen_watch") {
    const player = getOnlinePlayer(cmd.targetPlayer, cmd.citizenid);
    if (player && isFiveM) {
      const src = parseInt(player.PlayerData.source, 10);
      TriggerClientEvent("shield:client:stopScreenWatch", src);
      log(`[EKRAN İZLEME] Canlı ekran izleme sonlandırıldı: ID ${src}`, "^2");
    } else if (cmd.targetPlayer && isFiveM) {
      const srcNum = parseInt(cmd.targetPlayer, 10);
      if (!isNaN(srcNum)) {
        TriggerClientEvent("shield:client:stopScreenWatch", srcNum);
        log(`[EKRAN İZLEME] Canlı ekran izleme sonlandırıldı: ID ${srcNum}`, "^2");
      }
    }
  }
}

/* ==========================================================================
   POLL LOOP (SEND STATUS & RECEIVE ACTIONS)
   ========================================================================== */

async function pollServer() {
  try {
    const playersList = getPlayersList();

    const requestBody = {
      status: "active",
      playersCount: playersList.length,
      players: playersList,
      timestamp: Date.now()
    };

    const timestampHeader = Date.now().toString();
    const payloadToSign = timestampHeader + JSON.stringify(requestBody);
    const signature = crypto
      .createHmac("sha256", config.secretKey)
      .update(payloadToSign)
      .digest("hex");

    const headers = {
      "X-Bridge-Timestamp": timestampHeader,
      "X-Bridge-Signature": signature
    };

    const response = await makeRequest(config.apiUrl, "POST", headers, requestBody);
    if (response && response.success) {
      lastPollErrorMsg = null;
      if (response.commands && response.commands.length > 0) {
        for (const cmd of response.commands) {
          await executeBridgeCommand(cmd);
        }
        // Immediately query again for rapid reaction
        setTimeout(pollServer, 100);
      }
    }
  } catch (err) {
    if (err && err.message && err.message.includes("429")) {
      log("[WARN] Rate limit algılandı (HTTP 429). Bekleniyor...", "^3");
    } else {
      const errFormatted = formatErrorMessage(err);
      const now = Date.now();
      if (errFormatted !== lastPollErrorMsg || now - lastPollErrorTime > 60000) {
        lastPollErrorMsg = errFormatted;
        lastPollErrorTime = now;
        log(`[ERROR] Poll sunucu hatası - KFAPI11-b (${errFormatted})`, "^1");
        if (errFormatted.includes("Yetkisiz IP") || errFormatted.includes("403")) {
          log("[IP UYARISI] FiveM sunucunuzun IP adresi web panelinizdeki izinli IP listesinde tanımlı değil veya yetkisiz!", "^3");
        }
      }
    }
  }
}

/* ==========================================================================
   CHARACTER DATA EXTRACTION & SYNC ENGINE
   ========================================================================== */

async function sendCharactersInChunks(list) {
  const chunkSize = 50;
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    await sendCharactersChunk(chunk);
  }
}

async function sendCharactersChunk(chunk) {
  try {
    const requestBody = {
      characters: chunk,
      timestamp: Date.now()
    };

    const timestampHeader = Date.now().toString();
    const payloadToSign = timestampHeader + JSON.stringify(requestBody);
    const signature = crypto
      .createHmac("sha256", config.secretKey)
      .update(payloadToSign)
      .digest("hex");

    const headers = {
      "X-Bridge-Timestamp": timestampHeader,
      "X-Bridge-Signature": signature
    };

    const charUrl = config.apiUrl.replace("/poll", "/characters");
    await makeRequest(charUrl, "POST", headers, requestBody);
    lastCharSyncErrorMsg = null;
  } catch (err) {
    const errFormatted = formatErrorMessage(err);
    const now = Date.now();
    if (errFormatted !== lastCharSyncErrorMsg || now - lastCharSyncErrorTime > 60000) {
      lastCharSyncErrorMsg = errFormatted;
      lastCharSyncErrorTime = now;
      log(`[ERROR] Karakter senkronizasyon hatası - KFAPI11-c (${errFormatted})`, "^1");
    }
  }
}

function enrichInventoryItems(rawInventory, allSharedItems) {
  let list = rawInventory;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch (e) {
      list = [];
    }
  }

  if (!Array.isArray(list)) {
    if (list && typeof list === "object") {
      list = Object.values(list);
    } else {
      list = [];
    }
  }

  const enriched = list.map((item) => {
    if (!item || typeof item !== "object") return item;
    const itemName = item.name || item.item || "";
    const sharedInfo = allSharedItems && allSharedItems[itemName] ? allSharedItems[itemName] : {};

    let imageName = item.image || item.icon || sharedInfo.image || sharedInfo.icon;
    if (!imageName && itemName) {
      imageName = `${itemName}.png`;
    } else if (!imageName) {
      imageName = "default.png";
    }

    const itemLabel = item.label || sharedInfo.label || itemName;
    const countVal = item.count !== undefined ? item.count : (item.amount !== undefined ? item.amount : (item.quantity || 1));

    return {
      ...item,
      name: itemName,
      label: itemLabel,
      count: countVal,
      amount: countVal,
      image: imageName,
      icon: imageName
    };
  });

  return JSON.stringify(enriched);
}

const playerOnlineSessions = {};

function updateOnlineSessions(onlineList) {
  const currentIdentifiers = new Set();
  const now = Date.now();

  if (Array.isArray(onlineList)) {
    for (const p of onlineList) {
      const idKey = p.identifiers && p.identifiers.length > 0 ? p.identifiers.join("|") : p.id;
      currentIdentifiers.add(idKey);
      if (!playerOnlineSessions[idKey]) {
        playerOnlineSessions[idKey] = now;
      }
    }
  }

  for (const key of Object.keys(playerOnlineSessions)) {
    if (!currentIdentifiers.has(key)) {
      delete playerOnlineSessions[key];
    }
  }
}

function getOnlineSessionMinutes(pIdentifiers) {
  if (!pIdentifiers || pIdentifiers.length === 0) return 0;
  const idKey = pIdentifiers.join("|");
  const startTime = playerOnlineSessions[idKey];
  if (!startTime) return 0;
  return Math.floor((Date.now() - startTime) / 60000);
}

function formatDateOrTime(val) {
  if (!val) return "Bilinmiyor";
  try {
    let d = null;
    if (val instanceof Date) {
      d = val;
    } else if (typeof val === "number") {
      d = new Date(val < 10000000000 ? val * 1000 : val);
    } else if (typeof val === "string") {
      if (!isNaN(Number(val)) && Number(val) > 100000000) {
        const num = Number(val);
        d = new Date(num < 10000000000 ? num * 1000 : num);
      } else {
        d = new Date(val);
      }
    }
    if (d && !isNaN(d.getTime())) {
      const pad = (n) => (n < 10 ? "0" + n : n);
      return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  } catch (e) { }
  return String(val);
}

function calculatePlayTime(row, metadata, sessionMinutes = 0) {
  let minutes = 0;
  if (row && row.playtime !== undefined && row.playtime !== null && Number(row.playtime) > 0) {
    minutes = Number(row.playtime);
  } else if (row && row.play_time !== undefined && row.play_time !== null && Number(row.play_time) > 0) {
    minutes = Number(row.play_time);
  } else if (metadata && metadata.playtime !== undefined && metadata.playtime !== null && Number(metadata.playtime) > 0) {
    minutes = Number(metadata.playtime);
  } else if (metadata && metadata.playTime !== undefined && metadata.playTime !== null && Number(metadata.playTime) > 0) {
    minutes = Number(metadata.playTime);
  } else if (metadata && metadata.playtime !== undefined && metadata.playtime !== null) {
    minutes = Number(metadata.playtime) || 0;
  } else if (row && row.playtime !== undefined && row.playtime !== null) {
    minutes = Number(row.playtime) || 0;
  }

  if (minutes > 500000) {
    minutes = Math.floor(minutes / 60);
  }
  return minutes + sessionMinutes;
}

let pendingSyncCitIds = new Set();
let syncQueueTimeout = null;

function queueCharacterSync(targetCitId) {
  if (typeof targetCitId === "string" && targetCitId.trim() && targetCitId !== "true") {
    pendingSyncCitIds.add(targetCitId.trim());
  } else if (targetCitId === true || targetCitId === "true") {
    pendingSyncCitIds.add("__ALL__");
  }

  if (syncQueueTimeout) return;

  syncQueueTimeout = setTimeout(async () => {
    syncQueueTimeout = null;
    const ids = Array.from(pendingSyncCitIds);
    pendingSyncCitIds.clear();

    if (ids.includes("__ALL__")) {
      await syncUpdatedCharacters(true);
    } else {
      for (const id of ids) {
        await syncUpdatedCharacters(id);
      }
    }
  }, 300);
}

/**
 * Builds a 360-degree comprehensive character payload ensuring complete
 * compatibility with all web panel views (Discord avatar, vehicles, IBAN, jobs, money, stats).
 */
function buildEnrichedCharacterObject({
  citId,
  cid,
  license,
  name,
  charinfo,
  money,
  job,
  gang,
  metadata,
  enrichedInvJson,
  rawDiscord,
  rawSteam,
  rawFivem,
  vehicles,
  iban,
  skinModel,
  isOnline,
  onlinePlayerObj,
  sessionMinutes,
  rawLastLogin
}) {
  const cleanDiscord = cleanIdentifier(rawDiscord, "discord");
  const cleanSteam = cleanIdentifier(rawSteam, "steam");
  const cleanLicense = cleanIdentifier(license, "license");
  const cleanFivem = cleanIdentifier(rawFivem, "fivem");

  const firstname = charinfo.firstname || "";
  const lastname = charinfo.lastname || "";
  const fullName = `${firstname} ${lastname}`.trim() || name || "Karakter";

  const cash = Number(money.cash) || 0;
  const bank = Number(money.bank) || 0;
  const cryptoVal = Number(money.crypto) || 0;

  const jobName = job.name || "unemployed";
  const jobLabel = job.label || jobName;
  const jobGrade = (job.grade && job.grade.level !== undefined) ? job.grade.level : 0;
  const jobGradeName = (job.grade && job.grade.name) || "Yok";

  const gangName = gang.name || "none";
  const gangLabel = gang.label || gangName;
  const gangGrade = (gang.grade && gang.grade.level !== undefined) ? gang.grade.level : 0;
  const gangGradeName = (gang.grade && gang.grade.name) || "Yok";

  const totalPlaytime = calculatePlayTime({ playtime: metadata.playtime }, metadata, sessionMinutes || 0);
  const lastLoginText = isOnline ? "Şu Anda Oyunda" : formatDateOrTime(rawLastLogin);

  const pVehicles = Array.isArray(vehicles) ? vehicles : [];

  return {
    // Core Identifiers
    citizenid: citId,
    cid: Number(cid) || 1,
    license: license || "",
    license_id: cleanLicense,
    raw_license: license || "",

    // Discord (Clean snowflake numeric ID for Discord API / avatars, plus raw prefix)
    discord: cleanDiscord || rawDiscord || "",
    discord_id: cleanDiscord || "",
    discordId: cleanDiscord || "",
    raw_discord: rawDiscord || "",

    // Steam & FiveM
    steam: cleanSteam || rawSteam || "",
    steam_id: cleanSteam || "",
    steamId: cleanSteam || "",
    raw_steam: rawSteam || "",
    fivem: cleanFivem || rawFivem || "",
    fivem_id: cleanFivem || "",

    // Names
    name: fullName,
    charName: fullName,
    character_name: fullName,
    fullname: fullName,
    player_name: name || fullName,
    firstname: firstname,
    lastname: lastname,

    // Personal Info
    phone: charinfo.phone || charinfo.phoneNumber || "",
    gender: (charinfo.gender === 0 || charinfo.gender === "0" || charinfo.gender === "m") ? "Erkek" : "Kadın",
    gender_raw: charinfo.gender,
    birthdate: charinfo.birthdate || "",
    nationality: charinfo.nationality || "",
    skin_model: skinModel || "mp_m_freemode_01",

    // Banking & Financials
    cash: cash,
    bank: bank,
    crypto: cryptoVal,
    total_money: cash + bank,
    iban: iban || charinfo.account || "",
    account: charinfo.account || iban || "",

    // Job & Organization
    job_name: jobName,
    job_label: jobLabel,
    job_grade: jobGrade,
    job_grade_name: jobGradeName,
    job_payment: job.payment || (job.grade && job.grade.payment) || 0,
    onduty: Boolean(job.onduty),
    isboss: Boolean(job.isboss || (job.grade && job.grade.isboss)),

    gang_name: gangName,
    gang_label: gangLabel,
    gang_grade: gangGrade,
    gang_grade_name: gangGradeName,
    gang_isboss: Boolean(gang.isboss || (gang.grade && gang.grade.isboss)),

    // Owned Vehicles
    vehicles: pVehicles,
    vehicles_count: pVehicles.length,

    // Health, Vitals & License Stats
    health: metadata.health !== undefined ? Number(metadata.health) : 200,
    armor: metadata.armor !== undefined ? Number(metadata.armor) : 0,
    hunger: metadata.hunger !== undefined ? Number(metadata.hunger) : 100,
    thirst: metadata.thirst !== undefined ? Number(metadata.thirst) : 100,
    stress: metadata.stress !== undefined ? Number(metadata.stress) : 0,
    isdead: Boolean(metadata.isdead || metadata.inlaststand),
    licences: metadata.licences || {},
    licenses: metadata.licences || {},
    driver_license: Boolean(metadata.licences && metadata.licences.driver),
    weapon_license: Boolean(metadata.licences && metadata.licences.weapon),
    business_license: Boolean(metadata.licences && metadata.licences.business),
    bloodtype: metadata.bloodtype || "Bilinmiyor",
    fingerprint: metadata.fingerprint || "",

    // Online State
    is_online: isOnline,
    isOnline: isOnline,
    status: isOnline ? "online" : "offline",
    serverId: isOnline && onlinePlayerObj ? onlinePlayerObj.id : null,
    source: isOnline && onlinePlayerObj ? onlinePlayerObj.id : null,
    ping: isOnline && onlinePlayerObj ? (onlinePlayerObj.ping || 0) : 0,

    // JSON Fields (Backward compatibility with legacy dashboard parsers)
    money: typeof money === "string" ? money : JSON.stringify(money),
    money_data: money,
    charinfo: typeof charinfo === "string" ? charinfo : JSON.stringify(charinfo),
    charinfo_data: charinfo,
    job: typeof job === "string" ? job : JSON.stringify(job),
    job_data: job,
    gang: typeof gang === "string" ? gang : JSON.stringify(gang),
    gang_data: gang,
    metadata: typeof metadata === "string" ? metadata : JSON.stringify({
      ...metadata,
      playtime: totalPlaytime,
      last_login: lastLoginText,
      last_seen: lastLoginText,
      last_updated: lastLoginText
    }),
    metadata_data: metadata,
    inventory: enrichedInvJson,

    // Timestamps
    playtime: totalPlaytime,
    last_login: lastLoginText,
    last_seen: lastLoginText,
    last_updated: lastLoginText
  };
}

async function syncUpdatedCharacters(targetCitId) {
  if (config.dbLock) {
    log("[DB-LOCK] Veritabanı kilitli olduğu için karakter çekme atlandı.", "^3");
    return;
  }

  const filterCitId = typeof targetCitId === "string" && targetCitId.trim() && targetCitId !== "true" ? targetCitId.trim() : null;
  const sharedItems = getSharedData().items;
  const onlinePlayers = getPlayersList();
  updateOnlineSessions(onlinePlayers);

  // 1. Fetch Owned Vehicles
  let vehiclesByCit = {};
  try {
    const vQuery = filterCitId
      ? "SELECT citizenid, plate, vehicle, garage, state, fuel, mileage FROM player_vehicles WHERE citizenid = ?"
      : "SELECT citizenid, plate, vehicle, garage, state, fuel, mileage FROM player_vehicles";
    const vParams = filterCitId ? [filterCitId] : [];
    const vRows = await dbQuery(vQuery, vParams);
    if (vRows && Array.isArray(vRows)) {
      for (const v of vRows) {
        if (!vehiclesByCit[v.citizenid]) vehiclesByCit[v.citizenid] = [];
        vehiclesByCit[v.citizenid].push({
          plate: v.plate || "",
          vehicle: v.vehicle || "",
          garage: v.garage || "Garaj",
          state: v.state !== undefined ? v.state : 1,
          fuel: v.fuel !== undefined ? v.fuel : 100,
          mileage: Number(v.mileage) || 0
        });
      }
    }
  } catch (e) { }

  // 2. Fetch Bank IBANs
  let ibanByCit = {};
  try {
    const bQuery = filterCitId
      ? "SELECT citizenid, iban FROM tgiann_bank_player_accounts WHERE citizenid = ?"
      : "SELECT citizenid, iban FROM tgiann_bank_player_accounts";
    const bParams = filterCitId ? [filterCitId] : [];
    const bRows = await dbQuery(bQuery, bParams);
    if (bRows && Array.isArray(bRows)) {
      for (const b of bRows) {
        ibanByCit[b.citizenid] = b.iban;
      }
    }
  } catch (e) { }

  // 3. Fetch Skin Models
  let skinByCit = {};
  try {
    const sQuery = filterCitId
      ? "SELECT citizenid, model FROM playerskins WHERE active = 1 AND citizenid = ?"
      : "SELECT citizenid, model FROM playerskins WHERE active = 1";
    const sParams = filterCitId ? [filterCitId] : [];
    const sRows = await dbQuery(sQuery, sParams);
    if (sRows && Array.isArray(sRows)) {
      for (const s of sRows) {
        skinByCit[s.citizenid] = s.model;
      }
    }
  } catch (e) { }

  // OPTIMIZATION 1: If player is online, sync 100% directly from RAM memory (0ms SQL lag, 0 resmon)
  if (filterCitId && isFiveM) {
    const livePlayer = getLiveQBCorePlayer(filterCitId);
    if (livePlayer && livePlayer.PlayerData) {
      const pData = livePlayer.PlayerData;
      const src = pData.source;

      let rawInv = "[]";
      if (GetResourceState("ox_inventory") === "started") {
        try {
          const liveOx = exports["ox_inventory"].GetInventory(src) || exports["ox_inventory"].GetPlayerItems(src);
          if (liveOx) {
            const itemsArr = Array.isArray(liveOx) ? liveOx : (liveOx.items ? Object.values(liveOx.items) : Object.values(liveOx));
            if (itemsArr && itemsArr.length > 0) rawInv = JSON.stringify(itemsArr);
          }
        } catch (e) { }
      } else if (pData.items) {
        rawInv = JSON.stringify(Object.values(pData.items));
      }

      const enrichedInvJson = enrichInventoryItems(rawInv, sharedItems);
      const sessionMinutes = getOnlineSessionMinutes([pData.license, pData.discord, pData.steam, pData.citizenid]);

      const cachedIds = playerIdentifiersCache.get(filterCitId) || {};
      const discord = cachedIds.discord || getPlayerIdentifierByType(src, "discord") || "";
      const steam = cachedIds.steam || getPlayerIdentifierByType(src, "steam") || "";
      const fivem = cachedIds.fivem || getPlayerIdentifierByType(src, "fivem") || "";

      const characterObj = buildEnrichedCharacterObject({
        citId: pData.citizenid,
        cid: pData.cid || 1,
        license: pData.license || "",
        name: pData.name || "Karakter",
        charinfo: pData.charinfo || {},
        money: pData.money || {},
        job: pData.job || {},
        gang: pData.gang || {},
        metadata: pData.metadata || {},
        enrichedInvJson: enrichedInvJson,
        rawDiscord: discord,
        rawSteam: steam,
        rawFivem: fivem,
        vehicles: vehiclesByCit[filterCitId] || [],
        iban: ibanByCit[filterCitId] || (pData.charinfo && pData.charinfo.account) || "",
        skinModel: skinByCit[filterCitId] || "mp_m_freemode_01",
        isOnline: true,
        onlinePlayerObj: { id: src.toString(), ping: GetPlayerPing(src) || 0 },
        sessionMinutes: sessionMinutes,
        rawLastLogin: "Şu Anda Oyunda"
      });

      log(`[SHIELD-SOFTWARE] RAM'den (0ms SQL) detaylı canlı karakter senkronize ediliyor: ${filterCitId}`, "^2");
      await sendCharactersInChunks([characterObj]);
      return;
    }
  }

  // OPTIMIZATION 2: SQL Query matching exact MariaDB zrptemel schema (No invalid steam/discord columns)
  let queryStr = "";
  let queryParams = [];

  if (hasAdminIdentifiersTable) {
    if (filterCitId) {
      queryStr = `
        SELECT p.citizenid, p.cid, p.license, p.name, p.money, p.charinfo, p.job, p.gang, p.metadata, p.inventory, p.last_updated,
               f.discord, f.steam, f.fivem
        FROM players p
        LEFT JOIN fx_admin_identifiers f ON f.license = p.license
        WHERE p.citizenid = ? OR p.license = ?
      `;
      queryParams = [filterCitId, filterCitId];
    } else {
      queryStr = `
        SELECT p.citizenid, p.cid, p.license, p.name, p.money, p.charinfo, p.job, p.gang, p.metadata, p.inventory, p.last_updated,
               f.discord, f.steam, f.fivem
        FROM players p
        LEFT JOIN fx_admin_identifiers f ON f.license = p.license
      `;
    }
  } else {
    if (filterCitId) {
      queryStr = "SELECT citizenid, cid, license, name, money, charinfo, job, gang, metadata, inventory, last_updated FROM players WHERE citizenid = ? OR license = ?";
      queryParams = [filterCitId, filterCitId];
    } else {
      queryStr = "SELECT citizenid, cid, license, name, money, charinfo, job, gang, metadata, inventory, last_updated FROM players";
    }
  }

  try {
    const results = await dbQuery(queryStr, queryParams);
    if (results && results.length > 0) {
      log(`[SHIELD-SOFTWARE] SQL'den ${results.length} adet detaylı karakter verisi çekildi. Web paneline senkronize ediliyor...`, "^2");

      const onlineMap = {};
      for (const p of onlinePlayers) {
        if (p.identifiers) {
          for (const id of p.identifiers) {
            onlineMap[id] = p;
          }
        }
        if (p.citizenid) onlineMap[p.citizenid] = p;
      }

      const mapped = results.map((row) => {
        const citId = row.citizenid || "";
        const license = row.license || "";
        let discord = row.discord || "";
        let steam = row.steam || "";
        let fivem = row.fivem || "";

        const cachedIds = playerIdentifiersCache.get(citId) || licenseIdentifiersCache.get(license);
        if (cachedIds) {
          if (!discord && cachedIds.discord) discord = cachedIds.discord;
          if (!steam && cachedIds.steam) steam = cachedIds.steam;
          if (!fivem && cachedIds.fivem) fivem = cachedIds.fivem;
        }

        const onlinePlayerObj = onlineMap[license] || onlineMap[discord] || onlineMap[steam] || onlineMap[citId];
        const isOnline = Boolean(onlinePlayerObj);
        const sessionMinutes = isOnline && onlinePlayerObj ? getOnlineSessionMinutes(onlinePlayerObj.identifiers) : 0;

        let charinfo = {};
        try { charinfo = typeof row.charinfo === "string" ? JSON.parse(row.charinfo) : (row.charinfo || {}); } catch (e) { }

        let money = {};
        try { money = typeof row.money === "string" ? JSON.parse(row.money) : (row.money || {}); } catch (e) { }

        let job = {};
        try { job = typeof row.job === "string" ? JSON.parse(row.job) : (row.job || {}); } catch (e) { }

        let gang = {};
        try { gang = typeof row.gang === "string" ? JSON.parse(row.gang) : (row.gang || {}); } catch (e) { }

        let rawInv = row.inventory || "[]";
        if (isOnline && onlinePlayerObj && isFiveM) {
          try {
            const srcNum = parseInt(onlinePlayerObj.id, 10);
            if (!isNaN(srcNum) && GetResourceState("ox_inventory") === "started") {
              const liveOx = exports["ox_inventory"].GetInventory(srcNum) || exports["ox_inventory"].GetPlayerItems(srcNum);
              if (liveOx) {
                const itemsArr = Array.isArray(liveOx) ? liveOx : (liveOx.items ? Object.values(liveOx.items) : Object.values(liveOx));
                if (itemsArr && itemsArr.length > 0) rawInv = JSON.stringify(itemsArr);
              }
            }
          } catch (e) { }
        }
        const enrichedInvJson = enrichInventoryItems(rawInv, sharedItems);

        let metadata = {};
        try { metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : (row.metadata || {}); } catch (e) { }

        return buildEnrichedCharacterObject({
          citId: citId,
          cid: row.cid || 1,
          license: license,
          name: row.name || "Karakter",
          charinfo: charinfo,
          money: money,
          job: job,
          gang: gang,
          metadata: metadata,
          enrichedInvJson: enrichedInvJson,
          rawDiscord: discord,
          rawSteam: steam,
          rawFivem: fivem,
          vehicles: vehiclesByCit[citId] || [],
          iban: ibanByCit[citId] || (charinfo && charinfo.account) || "",
          skinModel: skinByCit[citId] || "mp_m_freemode_01",
          isOnline: isOnline,
          onlinePlayerObj: onlinePlayerObj,
          sessionMinutes: sessionMinutes,
          rawLastLogin: row.last_updated || metadata.lastlogin || metadata.last_seen
        });
      });

      await sendCharactersInChunks(mapped);
    }
  } catch (err) {
    log(`[ERROR] Karakter listesi SQL çekme hatası: ${err.message}`, "^1");
  }
}

/* ==========================================================================
   SHARED DATA (ITEMS, JOBS, GANGS, VEHICLES)
   ========================================================================== */

function getSharedData() {
  let items = {};
  let jobs = {};
  let gangs = {};
  let vehicles = {};

  const QBCore = getQBCore();
  if (QBCore && QBCore.Shared) {
    items = { ...(QBCore.Shared.Items || {}) };
    jobs = { ...(QBCore.Shared.Jobs || {}) };
    gangs = { ...(QBCore.Shared.Gangs || {}) };
    vehicles = { ...(QBCore.Shared.Vehicles || {}) };
  } else if (!isFiveM) {
    items = {
      phone: { name: "phone", label: "Telefon", weight: 150, image: "phone.png", description: "Akıllı telefon" },
      water_bottle: { name: "water_bottle", label: "Su Şişesi", weight: 500, image: "water.png", description: "Temiz içme suyu" },
      sandwich: { name: "sandwich", label: "Sandviç", weight: 200, image: "sandwich.png", description: "Lezzetli sandviç" }
    };
    jobs = {
      unemployed: { label: "İşsiz", grades: { "0": { name: "İşsiz", payment: 50 } } },
      police: { label: "Polis Departmanı", grades: { "0": { name: "Memur", payment: 500 } } }
    };
    gangs = {
      none: { label: "Yok", grades: { "0": { name: "Yok" } } }
    };
    vehicles = {
      adder: { name: "Adder", brand: "Truffade", price: 1000000, category: "super" }
    };
  }

  // ox_inventory items merge
  if (isFiveM && GetResourceState("ox_inventory") === "started") {
    try {
      const oxItems = exports["ox_inventory"].Items();
      if (oxItems) {
        for (const [key, item] of Object.entries(oxItems)) {
          const imageName = item.image || (item.client && item.client.image) || `${key}.png`;
          items[key] = {
            name: item.name || key,
            label: item.label || key,
            weight: item.weight || 0,
            image: imageName,
            icon: imageName,
            description: item.description || ""
          };
        }
      }
    } catch (e) { }
  }

  for (const [k, v] of Object.entries(items)) {
    if (!v.image && !v.icon) {
      v.image = `${k}.png`;
      v.icon = `${k}.png`;
    } else if (!v.image) {
      v.image = v.icon;
    } else if (!v.icon) {
      v.icon = v.image;
    }
  }

  return { items, jobs, gangs, vehicles };
}

async function syncSharedData() {
  try {
    const sharedData = getSharedData();
    const requestBody = {
      ...sharedData,
      timestamp: Date.now()
    };

    const timestampHeader = Date.now().toString();
    const payloadToSign = timestampHeader + JSON.stringify(requestBody);
    const signature = crypto
      .createHmac("sha256", config.secretKey)
      .update(payloadToSign)
      .digest("hex");

    const headers = {
      "X-Bridge-Timestamp": timestampHeader,
      "X-Bridge-Signature": signature
    };

    const sharedUrl = config.apiUrl.replace("/poll", "/shared-data");
    await makeRequest(sharedUrl, "POST", headers, requestBody);
    lastSharedSyncErrorMsg = null;
  } catch (err) {
    const errFormatted = formatErrorMessage(err);
    const now = Date.now();
    if (errFormatted !== lastSharedSyncErrorMsg || now - lastSharedSyncErrorTime > 60000) {
      lastSharedSyncErrorMsg = errFormatted;
      lastSharedSyncErrorTime = now;
      log(`[ERROR] Paylaşılan veri senkronizasyon hatası - KFAPI11-d (${errFormatted})`, "^1");
    }
  }
}

function printStartupBanner() {
  log("==========================================================================", "^2");
  log("        🚀 SHIELD-SOFTWARE (Shield Web) BRIDGE MANAGEMENT SYSTEM v1.9.0           ", "^4");
  log("--------------------------------------------------------------------------", "^7");
  log("  [STATUS]      : ONLINE & ACTIVE", "^2");
  log(`  [ENVIRONMENT] : ${isFiveM ? "FiveM FXServer Resource" : "Standalone Node.js Mode"}`, "^3");
  log(`  [POLL RATE]   : ${config.pollInterval}ms (Instant Action Delivery)`, "^3");
  log(`  [DATABASE]    : ${config.dbLock ? "🔒 KİLİTLİ" : "MariaDB 'players' (QBCore) - oxmysql Doğrudan Async"}`, "^5");
  log(`  [API URL]     : ${config.apiUrl}`, "^5");
  log("==========================================================================", "^2");
}

printStartupBanner();

setInterval(pollServer, config.pollInterval);
setTimeout(() => syncUpdatedCharacters(true), 3000);
setInterval(() => syncUpdatedCharacters(true), 60000); // Periodic character sync every 60s
setTimeout(syncSharedData, 2000);
setInterval(syncSharedData, 600000);

/* ==========================================================================
   FIVEM EVENT LISTENERS
   ========================================================================== */

if (isFiveM) {
  onNet("QBCore:Server:PlayerLoaded", (player) => {
    if (!player || !player.PlayerData) return;
    const citizenid = player.PlayerData.citizenid;
    const source = player.PlayerData.source;
    updatePlayerIdentifiers(source, citizenid);
    if (citizenid) {
      queueCharacterSync(citizenid);
    }
  });

  on("playerDropped", () => {
    const src = source;
    // Fast update on player disconnect
    setTimeout(() => queueCharacterSync(true), 1000);
  });
}

if (!isFiveM) {
  module.exports = {
    executeBridgeCommand,
    getPlayersList,
    getSharedData,
    isPlayerOnline,
    dbQuery,
    dbSingle,
    dbExecute,
    enrichInventoryItems,
    buildEnrichedCharacterObject,
    syncUpdatedCharacters
  };
}
