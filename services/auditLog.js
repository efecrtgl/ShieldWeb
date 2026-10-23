const ActionLog = require("../models/ActionLog");
const { activeProcesses, isConnected } = require("./botRegistry");

// Executor block used by every audit entry created from a web request.
function actorFrom(req) {
  const user = req && req.session && req.session.user;
  return {
    id: user ? user.id : "system",
    username: user ? user.username : "System",
    ip: req ? req.ip : ""
  };
}

// Sends an audit event to the logger bot (which posts to Discord and persists it);
// falls back to writing the ActionLog directly when the logger bot is offline.
function logAction(action, data = {}) {
  const logData = { ...data, timestamp: data.timestamp ? new Date(data.timestamp) : new Date() };

  const loggerProcess = activeProcesses.logger;
  if (isConnected(loggerProcess)) {
    loggerProcess.send({ type: "LOG_ACTION", action, data: logData });
    return;
  }

  new ActionLog({
    executorId: logData.executor ? logData.executor.id : "system",
    executorUsername: logData.executor ? logData.executor.username : "System",
    targetId: logData.target ? logData.target.id : "",
    targetUsername: logData.target ? logData.target.username : "",
    actionType: action,
    details: logData.details || "",
    timestamp: logData.timestamp,
    executorIp: logData.executor && logData.executor.ip ? logData.executor.ip : "",
    context: logData.context || "Web Panel",
    rawData: logData
  }).save().catch(err => console.error("ActionLog fallback save error:", err.message));
}

module.exports = { actorFrom, logAction };
