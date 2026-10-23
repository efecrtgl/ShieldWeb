const crypto = require("crypto");
const { timeTr } = require("../utils/format");

const MAX_CONSOLE_LOGS = 500;

// In-memory state shared between the FiveM bridge (game server polling) and the admin panel.
const fivem = {
  // Commands waiting to be picked up by the next bridge poll.
  commandQueue: [],
  // Player list reported by the last bridge poll.
  activePlayers: [],
  // Console lines shown in the admin "server" tab.
  consoleLogs: [],
  // Timestamp of the last successful bridge poll.
  lastPoll: 0,
  serverControl: null,
  serverActionLogs: [],
  childProc: null,
  liveScreenFrames: new Map(),
  activeScreenStreams: new Map(),
  screenStreamSubscribers: new Map(),
  mjpegClients: new Map()
};

function commandId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomInt(1000)}`;
}

// Queues a command for the game server and returns it.
function queueCommand(prefix, command) {
  const entry = { id: commandId(prefix), ...command };
  fivem.commandQueue.push(entry);
  return entry;
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
  return fivem.activePlayers.find(p =>
    (citizenid && (p.citizenid === citizenid || p.citizenId === citizenid)) ||
    (cleanId && Array.isArray(p.identifiers) && p.identifiers.some(id => id === `discord:${cleanId}` || id === discordId))
  ) || null;
}

function onlineDiscordIds() {
  const ids = new Set();
  for (const p of fivem.activePlayers) {
    if (!Array.isArray(p.identifiers)) continue;
    for (const id of p.identifiers) {
      if (id && id.startsWith("discord:")) ids.add(id.replace("discord:", ""));
    }
  }
  return ids;
}

// SQL executed by the bridge on the game server to drop a character row (value is quote-escaped).
function deletePlayerSql(citizenid) {
  return `DELETE FROM players WHERE citizenid = '${String(citizenid).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

// Queues every delete-character command variant understood by the supported bridge/framework versions.
function queueCharacterDeletion(baseData, { actions, consoleCommands = [], sqlActions }) {
  actions.forEach((act, i) => queueCommand(`cmd_del_${i}`, { action: act, type: act, ...baseData }));
  consoleCommands.forEach((command, i) => queueCommand(`cmd_del_console${i + 1}`, { action: "command", command, ...baseData }));
  const sql = deletePlayerSql(baseData.citizenid);
  sqlActions.forEach((act, i) => queueCommand(`cmd_del_sql${i + 1}`, { action: act, query: sql, sql, ...baseData }));
}

module.exports = {
  fivem,
  MAX_CONSOLE_LOGS,
  commandId,
  queueCommand,
  appendConsoleLogs,
  findOnlinePlayer,
  onlineDiscordIds,
  deletePlayerSql,
  queueCharacterDeletion
};
