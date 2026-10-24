const crypto = require("crypto");
const { timeTr } = require("../utils/format");

const MAX_CONSOLE_LOGS = 500;
// The bridge polls about once a second; no poll for this long means the game server is offline.
const BRIDGE_ONLINE_WINDOW_MS = 7000;
// A command nobody picked up within this time is dropped instead of running much later (e.g. a kill after a restart).
const COMMAND_TTL_MS = 30000;
const MAX_TRACKED_COMMANDS = 300;

// In-memory state shared between the FiveM bridge (game server polling) and the admin panel.
const fivem = {
  // Commands waiting to be picked up by the next bridge poll.
  commandQueue: [],
  // Lifecycle of recent commands, id -> record (see trackCommand).
  commands: new Map(),
  // Player list reported by the last bridge poll. Read it through livePlayers() so stale lists are never shown as live.
  activePlayers: [],
  // sv_maxclients reported by the bridge (null until a bridge that reports it has polled).
  maxPlayers: null,
  // Protocol version reported by the bridge resource (1 = legacy resource without command results).
  bridgeVersion: null,
  // Console lines shown in the admin "server" tab.
  consoleLogs: [],
  // Timestamp of the last successful bridge poll.
  lastPoll: 0,
  serverActionLogs: [],
  childProc: null,
  liveScreenFrames: new Map(),
  activeScreenStreams: new Map(),
  screenStreamSubscribers: new Map(),
  mjpegClients: new Map()
};

function commandId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function isBridgeOnline(now = Date.now()) {
  return fivem.lastPoll > 0 && now - fivem.lastPoll < BRIDGE_ONLINE_WINDOW_MS;
}

// Players of the last poll, or [] once the bridge has gone quiet (a stale list must not look live).
function livePlayers() {
  return isBridgeOnline() ? fivem.activePlayers : [];
}

function bridgeStatus() {
  const online = isBridgeOnline();
  return {
    online,
    lastPollAt: fivem.lastPoll ? new Date(fivem.lastPoll).toISOString() : null,
    playersCount: online ? fivem.activePlayers.length : null,
    maxPlayers: online ? fivem.maxPlayers : null,
    bridgeVersion: fivem.bridgeVersion,
    reportsResults: (fivem.bridgeVersion || 1) >= 2
  };
}

function trackCommand(entry) {
  fivem.commands.set(entry.id, {
    id: entry.id,
    action: entry.action,
    status: "queued",
    createdAt: Date.now(),
    deliveredAt: null,
    completedAt: null,
    error: null,
    result: null,
    waiters: []
  });
  if (fivem.commands.size > MAX_TRACKED_COMMANDS) {
    const oldest = fivem.commands.keys().next().value;
    settle(fivem.commands.get(oldest));
    fivem.commands.delete(oldest);
  }
}

function settle(record) {
  if (!record) return;
  const waiters = record.waiters.splice(0);
  waiters.forEach(fn => fn(publicRecord(record)));
}

// Command record without its internal waiter list.
function publicRecord(record) {
  const rest = { ...record };
  delete rest.waiters;
  return rest;
}

// Queues a command for the game server and returns it.
function queueCommand(prefix, command) {
  const entry = { id: commandId(prefix), ...command };
  fivem.commandQueue.push(entry);
  trackCommand(entry);
  return entry;
}

// Removes commands that waited longer than COMMAND_TTL_MS and marks them expired.
function expireStaleCommands(now = Date.now()) {
  const keep = [];
  for (const cmd of fivem.commandQueue) {
    const record = fivem.commands.get(cmd.id);
    if (record && now - record.createdAt > COMMAND_TTL_MS) {
      record.status = "expired";
      record.completedAt = now;
      record.error = "Oyun sunucusu komutu zamanında almadı.";
      settle(record);
    } else {
      keep.push(cmd);
    }
  }
  fivem.commandQueue = keep;
}

// Hands every pending command to the bridge and marks it delivered.
function takeQueuedCommands(now = Date.now()) {
  expireStaleCommands(now);
  const commands = fivem.commandQueue;
  fivem.commandQueue = [];
  for (const cmd of commands) {
    const record = fivem.commands.get(cmd.id);
    if (!record) continue;
    record.status = "delivered";
    record.deliveredAt = now;
    // Legacy bridges never report back, so "delivered" is the final state we can know.
    if (!(fivem.bridgeVersion >= 2)) settle(record);
  }
  return commands;
}

// Applies { id, ok, error, data } results reported by a v2 bridge.
function applyCommandResults(results, now = Date.now()) {
  if (!Array.isArray(results)) return 0;
  let applied = 0;
  for (const r of results) {
    if (!r || typeof r.id !== "string") continue;
    const record = fivem.commands.get(r.id);
    if (!record || record.status === "succeeded" || record.status === "failed") continue;
    record.status = r.ok === true ? "succeeded" : "failed";
    record.completedAt = now;
    record.error = r.ok === true ? null : String(r.error || "Oyun sunucusu komutu reddetti.").slice(0, 500);
    record.result = r.data && typeof r.data === "object" ? r.data : null;
    settle(record);
    applied++;
  }
  return applied;
}

function getCommand(id) {
  const record = fivem.commands.get(id);
  return record ? publicRecord(record) : null;
}

// Resolves with the command record once it reaches a final state (or the current one after timeoutMs).
function waitForCommand(id, timeoutMs) {
  const record = fivem.commands.get(id);
  if (!record) return Promise.resolve(null);
  const final = ["succeeded", "failed", "expired"].includes(record.status) || (record.status === "delivered" && !(fivem.bridgeVersion >= 2));
  if (final) return Promise.resolve(publicRecord(record));
  return new Promise(resolve => {
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(getCommand(id)), timeoutMs);
    record.waiters.push(finish);
  });
}

// Appends console lines ({ type, text } or full entries) and keeps the buffer bounded.
function appendConsoleLogs(...entries) {
  const time = timeTr();
  for (const entry of entries) {
    fivem.consoleLogs.push({ time, ...entry });
  }
  if (fivem.consoleLogs.length > MAX_CONSOLE_LOGS) {
    fivem.consoleLogs.splice(0, fivem.consoleLogs.length - MAX_CONSOLE_LOGS);
  }
}

// FiveM player currently online for the given Discord id and/or citizen id.
function findOnlinePlayer({ discordId, citizenid } = {}) {
  const cleanId = discordId ? String(discordId).replace("discord:", "") : "";
  return livePlayers().find(p =>
    (citizenid && (p.citizenid === citizenid || p.citizenId === citizenid)) ||
    (cleanId && Array.isArray(p.identifiers) && p.identifiers.some(id => id === `discord:${cleanId}` || id === discordId))
  ) || null;
}

function onlineDiscordIds() {
  const ids = new Set();
  for (const p of livePlayers()) {
    if (!Array.isArray(p.identifiers)) continue;
    for (const id of p.identifiers) {
      if (id && id.startsWith("discord:")) ids.add(id.replace("discord:", ""));
    }
  }
  return ids;
}

module.exports = {
  fivem,
  MAX_CONSOLE_LOGS,
  BRIDGE_ONLINE_WINDOW_MS,
  COMMAND_TTL_MS,
  commandId,
  isBridgeOnline,
  livePlayers,
  bridgeStatus,
  queueCommand,
  takeQueuedCommands,
  applyCommandResults,
  expireStaleCommands,
  getCommand,
  waitForCommand,
  appendConsoleLogs,
  findOnlinePlayer,
  onlineDiscordIds
};
