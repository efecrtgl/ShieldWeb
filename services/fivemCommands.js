const { fivem, isBridgeOnline, queueCommand, waitForCommand } = require("./fivemState");

// How long a panel request waits for the game server to report the command result.
const DEFAULT_RESULT_WAIT_MS = 8000;

const OFFLINE_MESSAGE = "FiveM sunucusu şu anda çevrimdışı (köprü yanıt vermiyor). Komut gönderilmedi.";

// Sends one command to the game server and reports what is actually known about its outcome.
//   ok        : the command ran (succeeded) or was handed to a legacy bridge that cannot report results (delivered)
//   confirmed : the game server reported success
//   httpStatus: suggested status for the panel response
async function dispatchCommand(action, payload = {}, { waitMs = DEFAULT_RESULT_WAIT_MS, prefix = "cmd" } = {}) {
  if (!isBridgeOnline()) {
    return { ok: false, confirmed: false, status: "offline", httpStatus: 503, message: OFFLINE_MESSAGE, command: null };
  }
  const entry = queueCommand(prefix, { ...payload, action, timestamp: Date.now() });
  const record = await waitForCommand(entry.id, waitMs);
  const status = record ? record.status : "unknown";

  switch (status) {
    case "succeeded":
      return { ok: true, confirmed: true, status, httpStatus: 200, message: "FiveM sunucusu komutu uyguladı.", command: record };
    case "failed":
      return { ok: false, confirmed: false, status, httpStatus: 422, message: record.error || "FiveM sunucusu komutu reddetti.", command: record };
    case "expired":
      return { ok: false, confirmed: false, status, httpStatus: 504, message: "FiveM sunucusu komutu zamanında almadı; komut iptal edildi.", command: record };
    case "delivered":
      return {
        ok: true,
        confirmed: false,
        status,
        httpStatus: 202,
        message: fivem.bridgeVersion >= 2
          ? "Komut FiveM sunucusuna iletildi ancak sonuç henüz bildirilmedi."
          : "Komut FiveM sunucusuna iletildi. Bu köprü sürümü sonuç bildirmediği için uygulandığı doğrulanamadı.",
        command: record
      };
    default:
      return { ok: false, confirmed: false, status, httpStatus: 504, message: "Komut kuyrukta bekliyor; FiveM sunucusu henüz almadı.", command: record };
  }
}

// Express response for a dispatch result, with optional extra fields.
function sendDispatchResult(res, result, extra = {}) {
  return res.status(result.httpStatus).json({
    success: result.ok,
    confirmed: result.confirmed,
    status: result.status,
    message: result.message,
    commandId: result.command ? result.command.id : null,
    ...extra
  });
}

module.exports = { dispatchCommand, sendDispatchResult, DEFAULT_RESULT_WAIT_MS, OFFLINE_MESSAGE };
