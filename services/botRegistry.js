// Running Discord bot child processes, keyed by bot id (verification, logger, moderation, sync, management).
const activeProcesses = {};

// In-flight IPC requests awaiting a *_RESPONSE message from a bot, keyed by request id.
const pending = {
  voiceSupport: {},
  teams: {},
  syncWhitelist: {},
  punish: {},
  clearPunish: {},
  liveStats: {},
  bans: {}
};

function isConnected(proc) {
  return !!(proc && !proc.killed && proc.connected);
}

// First connected bot among the given ids, in order of preference.
function getConnectedBot(...botIds) {
  for (const id of botIds) {
    if (isConnected(activeProcesses[id])) return activeProcesses[id];
  }
  return null;
}

// Removes and returns a pending request, cancelling its timeout. Returns null if it already timed out.
function takePending(group, requestId) {
  const entry = pending[group][requestId];
  if (!entry) return null;
  clearTimeout(entry.timeout);
  delete pending[group][requestId];
  return entry;
}

module.exports = { activeProcesses, pending, isConnected, getConnectedBot, takePending };
