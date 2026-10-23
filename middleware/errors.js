const { addLog } = require("../services/systemLog");

function isApiRequest(req) {
  return !!(req.originalUrl && req.originalUrl.startsWith("/api/"));
}

function notFound(req, res) {
  if (isApiRequest(req)) {
    return res.status(404).json({ success: false, message: "API Uç Noktası Bulunamadı (404)" });
  }
  res.status(404).render("error", {
    status: 404,
    title: "Sayfa Bulunamadı",
    message: "Aradığınız sayfa silinmiş, adı değiştirilmiş veya geçici olarak kullanım dışı kalmış olabilir.",
    user: (req.session && req.session.user) || null
  });
}

// Express identifies error handlers by their 4-argument signature, so `next` must stay.
function errorHandler(err, req, res, next) {
  if (err && (err.type === "request.aborted" || err.code === "ECONNABORTED" || err.message === "request aborted")) {
    if (isApiRequest(req)) {
      return res.status(400).json({ success: false, message: "İstek istemci tarafından iptal edildi." });
    }
    return res.status(400).send("Bad Request: Request Aborted");
  }

  console.error("Express Error Handler:", err);
  addLog("Orchestrator", `HATA (${req.method} ${req.originalUrl}): ${err ? err.message : err}\n${err ? err.stack : ""}`, "error");

  if (res.headersSent) return;
  if (isApiRequest(req)) {
    return res.status(err.status || 500).json({ success: false, message: err.message || "Sunucu hatası oluştu." });
  }
  res.status(500).render("error", {
    status: 500,
    title: "Sunucu Hatası",
    message: "Sunucumuzda beklenmedik teknik bir sorun oluştu. Lütfen daha sonra tekrar deneyiniz.",
    user: (req.session && req.session.user) || null
  });
}

module.exports = { notFound, errorHandler };
