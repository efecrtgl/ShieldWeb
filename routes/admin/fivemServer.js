const express = require("express");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const config = require("../../config");
const { ServerStats } = require("../../models/ServerInfo");
const { getUserPermissions } = require("../../services/permissions");
const { logUserAction } = require("../../services/systemLog");
const { fivem, appendConsoleLogs, bridgeStatus } = require("../../services/fivemState");
const { dispatchCommand, sendDispatchResult } = require("../../services/fivemCommands");
const scriptFiles = require("../../services/scriptFiles");
const { timeTr } = require("../../utils/format");

const router = express.Router();

const RECENT_ACTIONS_LIMIT = 15;
const CONSOLE_LOG_RESPONSE_LIMIT = 200;
const RESTART_GRACE_MS = 2000;
const MAX_RESTART_COUNTDOWN_S = 3600;
const MAX_EDITABLE_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SAVED_FILE_BYTES = 10 * 1024 * 1024;
const KILL_FXSERVER_COMMAND = "taskkill /F /IM FXServer.exe";
const SERVER_CFG_TEMPLATE = path.join(__dirname, "..", "..", "templates", "server.cfg.template");

router.use("/admin/server", async (req, res, next) => {
  const perms = await getUserPermissions(req.session.user);
  if (!perms || (!perms.isSuperuser && !perms.manageFivemServer)) {
    const message = req.path.startsWith("/scripts") ? "Erişim yetkiniz bulunmamaktadır." : "Forbidden";
    return res.status(403).json({ success: false, message });
  }
  next();
});

function adminName(req, fallback = "Yönetici") {
  return req.session.user ? req.session.user.username : fallback;
}

function recordServerAction(action, admin, status) {
  fivem.serverActionLogs.push({ action, admin, timestamp: timeTr(), status });
}

function fivemStartCommand(stats) {
  return stats && stats.fivemStartCommand ? stats.fivemStartCommand : "";
}

// Runs the configured FXServer start command and streams its output into the panel console.
function launchFxServer(command) {
  try {
    const child = exec(command, err => {
      if (err) appendConsoleLogs({ type: "danger", text: `[FXServer Execution Error] ${err.message}` });
    });
    fivem.childProc = child;
    const pipe = type => data => {
      const lines = data.toString().split("\n").filter(Boolean);
      appendConsoleLogs(...lines.map(line => ({ type, text: line.trim() })));
    };
    if (child.stdout) child.stdout.on("data", pipe("info"));
    if (child.stderr) child.stderr.on("data", pipe("warning"));
  } catch (err) {
    console.error("FXServer launch error:", err);
  }
}

function defaultServerCfg() {
  try {
    const template = fs.readFileSync(SERVER_CFG_TEMPLATE, "utf8");
    return template.replace("{{ADMIN_DISCORD_ID}}", config.superusers[0] || "YOUR_DISCORD_ID");
  } catch (err) {
    return "";
  }
}

router.get("/admin/server/status", async (req, res) => {
  const bridge = bridgeStatus();
  const stats = await ServerStats.findOne().lean();
  res.json({
    success: true,
    status: bridge.online ? "online" : "offline",
    fivemOnline: bridge.online,
    bridge,
    // Gateway (this Node process) metrics, not the game server.
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    activePlayers: bridge.playersCount,
    maxPlayers: bridge.maxPlayers,
    actions: fivem.serverActionLogs.slice(-RECENT_ACTIONS_LIMIT).reverse(),
    fivemStartCommand: fivemStartCommand(stats)
  });
});

router.post("/admin/server/config", async (req, res) => {
  const { fivemStartCommand: command } = req.body;
  await ServerStats.updateOne({}, { $set: { fivemStartCommand: command || "" } }, { upsert: true });
  logUserAction(req, "FiveM Başlatma Komutu Güncellendi", command || "Boş");
  res.json({ success: true, message: "FiveM başlatma ayarları kaydedildi." });
});

// Kills every FXServer process on this machine (the panel and the game server run on the same Windows host).
function killFxServer() {
  return new Promise(resolve => {
    exec(KILL_FXSERVER_COMMAND, (err, stdout, stderr) => {
      // taskkill exits with 128 when no matching process exists.
      if (!err) return resolve({ ok: true, text: String(stdout).trim() });
      resolve({ ok: false, notRunning: err.code === 128, text: String(stderr || err.message).trim() });
    });
  });
}

router.post("/admin/server/start", async (req, res) => {
  const adminUser = adminName(req);
  const command = fivemStartCommand(await ServerStats.findOne());
  if (!command) {
    return res.status(400).json({ success: false, message: "FiveM başlatma komutu ayarlanmamış. Önce başlatma komutunu kaydedin." });
  }
  if (bridgeStatus().online) {
    return res.status(409).json({ success: false, message: "FiveM sunucusu zaten çevrimiçi görünüyor (köprü aktif)." });
  }
  appendConsoleLogs({ type: "system", text: `[Panel] FXServer başlatma komutu çalıştırılıyor (${adminUser}).` });
  launchFxServer(command);
  recordServerAction("FiveM Sunucusu Başlatma Komutu Çalıştırıldı", adminUser, "success");
  logUserAction(req, "FiveM Sunucu Başlatma", "Başlatma komutu çalıştırıldı.");
  res.status(202).json({ success: true, message: "Başlatma komutu çalıştırıldı. Sunucu, köprü bağlandığında çevrimiçi görünecek." });
});

router.post("/admin/server/stop", async (req, res) => {
  const adminUser = adminName(req);
  const result = await killFxServer();
  if (!result.ok) {
    const message = result.notRunning ? "Bu makinede çalışan bir FXServer süreci bulunamadı." : `FXServer durdurulamadı: ${result.text}`;
    appendConsoleLogs({ type: "danger", text: `[Panel] ${message}` });
    recordServerAction("FiveM Sunucusu Kapatma Başarısız", adminUser, "danger");
    return res.status(result.notRunning ? 409 : 500).json({ success: false, message });
  }
  appendConsoleLogs({ type: "warning", text: `[Panel] FXServer süreci ${adminUser} tarafından durduruldu.` });
  recordServerAction("FiveM Sunucusu Kapatıldı", adminUser, "danger");
  logUserAction(req, "FiveM Sunucu Kapatma", "FXServer süreci durduruldu.");
  res.json({ success: true, message: "FXServer süreci durduruldu." });
});

router.post("/admin/server/restart", async (req, res) => {
  const parsedCountdown = parseInt(req.body.countdown, 10);
  const countdown = Number.isFinite(parsedCountdown) ? Math.min(Math.max(parsedCountdown, 0), MAX_RESTART_COUNTDOWN_S) : 0;
  const adminUser = adminName(req);
  const command = fivemStartCommand(await ServerStats.findOne());
  if (!command) {
    return res.status(400).json({ success: false, message: "Yeniden başlatma için FiveM başlatma komutu ayarlanmalıdır." });
  }

  let announced = false;
  if (countdown && bridgeStatus().online) {
    const announce = await dispatchCommand("execute_command", { command: `say DIKKAT: Sunucu ${countdown} saniye sonra yeniden baslatilacaktir!`, admin: adminUser });
    announced = announce.ok;
  }
  appendConsoleLogs({ type: "warning", text: `[Panel] Restart planlandı: ${countdown}s sonra (${adminUser}).` });
  recordServerAction(countdown ? `FiveM Restart (${countdown}s Geri Sayım)` : "FiveM Anlık Restart", adminUser, "warning");

  setTimeout(async () => {
    const killed = await killFxServer();
    appendConsoleLogs({
      type: killed.ok ? "warning" : "danger",
      text: killed.ok ? "[Panel] FXServer durduruldu, yeniden başlatılıyor..." : `[Panel] FXServer durdurulamadı (${killed.text}); yine de başlatılıyor.`
    });
    setTimeout(() => launchFxServer(command), RESTART_GRACE_MS);
  }, countdown * 1000 + RESTART_GRACE_MS);

  logUserAction(req, "FiveM Sunucu Restart", `Geri sayım: ${countdown}s`);
  res.status(202).json({
    success: true,
    message: countdown
      ? `Restart ${countdown} saniye sonra yapılacak.${announced ? "" : " Oyuncu duyurusu gönderilemedi (köprü çevrimdışı veya reddetti)."}`
      : "Restart başlatıldı."
  });
});

router.get("/admin/server/console-logs", (req, res) => {
  res.json({ success: true, logs: fivem.consoleLogs.slice(-CONSOLE_LOG_RESPONSE_LIMIT) });
});

// Sends a console command through the bridge. The resource only runs start/ensure/stop/restart <resource> and
// say/announce <text>; anything else is rejected there and reported back here.
router.post("/admin/server/console-command", async (req, res) => {
  const cleanCmd = String(req.body.command || "").trim().slice(0, 500);
  if (!cleanCmd) {
    return res.status(400).json({ success: false, message: "Komut belirtilmedi." });
  }
  appendConsoleLogs({ type: "cmd", text: `> ${cleanCmd}` });
  const result = await dispatchCommand("execute_command", { command: cleanCmd, admin: adminName(req) });
  appendConsoleLogs({ type: result.ok ? (result.confirmed ? "success" : "info") : "danger", text: `[Köprü] ${result.message}` });
  logUserAction(req, "FiveM Konsol Komutu Gönderildi", `${cleanCmd} -> ${result.status}`);
  sendDispatchResult(res, result);
});

router.get("/admin/server/config-file", async (req, res) => {
  const stats = await ServerStats.findOne();
  const serverCfgPath = stats ? stats.serverCfgPath || "" : "";
  let content;
  if (serverCfgPath && fs.existsSync(serverCfgPath)) {
    try {
      content = fs.readFileSync(serverCfgPath, "utf8");
    } catch (err) {
      content = stats.serverCfgContent || "";
    }
  } else if (stats && stats.serverCfgContent) {
    content = stats.serverCfgContent;
  } else {
    content = defaultServerCfg();
  }
  res.json({ success: true, serverCfgPath, serverCfgContent: content });
});

router.post("/admin/server/config-file", async (req, res) => {
  const { serverCfgPath, serverCfgContent } = req.body;
  await ServerStats.updateOne({}, { $set: { serverCfgPath: serverCfgPath || "", serverCfgContent: serverCfgContent || "" } }, { upsert: true });

  if (serverCfgPath && fs.existsSync(path.dirname(serverCfgPath))) {
    try {
      fs.writeFileSync(serverCfgPath, serverCfgContent || "", "utf8");
    } catch (err) {
      console.error("Config disk write error:", err);
    }
  }

  appendConsoleLogs({ type: "success", text: `[server.cfg] Yapılandırma dosyası ${adminName(req, "Yetkili")} tarafından güncellendi.` });
  logUserAction(req, "FiveM server.cfg Güncellendi", serverCfgPath || "Panel içi kayıt");
  res.json({ success: true, message: "server.cfg yapılandırması başarıyla kaydedildi." });
});

// ---- Script & resource file manager -------------------------------------------------------

function scriptRoute(errorPrefix, handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`scripts ${req.path} error:`, err);
      res.status(500).json({ success: false, message: `${errorPrefix}: ${err.message}` });
    }
  };
}

router.get("/admin/server/scripts/settings", scriptRoute("Ayar bilgileri alınırken hata", async (req, res) => {
  const stats = await ServerStats.findOne();
  const effectivePath = await scriptFiles.getEffectiveScriptsBaseDir();

  const suggested = [];
  if (stats && stats.serverCfgPath && stats.serverCfgPath.trim()) {
    const cfgParent = path.dirname(path.resolve(stats.serverCfgPath.trim()));
    suggested.push(path.join(cfgParent, "resources"), cfgParent);
  }
  suggested.push(scriptFiles.BUNDLED_RESOURCE_DIR, scriptFiles.PROJECT_ROOT);

  res.json({
    success: true,
    configuredPath: stats ? stats.serverResourcesPath || "" : "",
    effectivePath,
    exists: fs.existsSync(effectivePath),
    serverCfgPath: stats ? stats.serverCfgPath || "" : "",
    suggestions: [...new Set(suggested)].filter(p => fs.existsSync(p))
  });
}));

router.post("/admin/server/scripts/settings", scriptRoute("Kayıt sırasında hata", async (req, res) => {
  const cleanPath = String(req.body.serverResourcesPath || "").trim();
  if (cleanPath && !fs.existsSync(cleanPath)) {
    return res.status(400).json({ success: false, message: "Belirtilen dizin sunucuda bulunamadı: " + cleanPath });
  }
  await ServerStats.updateOne({}, { $set: { serverResourcesPath: cleanPath } }, { upsert: true });
  logUserAction(req, "FiveM Script Dizin Yolu Güncellendi", cleanPath || "Varsayılan");
  res.json({
    success: true,
    message: "Script & kaynaklar dizin yolu başarıyla kaydedildi.",
    effectivePath: await scriptFiles.getEffectiveScriptsBaseDir()
  });
}));

router.get("/admin/server/scripts/tree", scriptRoute("Dizin listelenirken hata", async (req, res) => {
  const baseDir = await scriptFiles.getEffectiveScriptsBaseDir();
  if (!fs.existsSync(baseDir)) {
    return res.status(404).json({ success: false, message: "Kaynaklar ana dizini bulunamadı." });
  }
  const subPath = String(req.query.subPath || "").trim();
  const targetDir = scriptFiles.resolveSafePath(baseDir, subPath);
  if (!targetDir) {
    return res.status(403).json({ success: false, message: "Geçersiz dizin yolu veya güvenlik kısıtlaması." });
  }
  if (!fs.existsSync(targetDir)) {
    return res.status(404).json({ success: false, message: "İstenen dizin bulunamadı." });
  }
  if (!fs.statSync(targetDir).isDirectory()) {
    return res.status(400).json({ success: false, message: "Belirtilen yol bir dizin değil." });
  }

  const currentPath = subPath.replace(/\\/g, "/");
  const breadcrumbs = [{ name: "Kök (resources)", path: "" }];
  let accumulated = "";
  for (const part of currentPath.split("/").filter(Boolean)) {
    accumulated = accumulated ? `${accumulated}/${part}` : part;
    breadcrumbs.push({ name: part, path: accumulated });
  }

  res.json({
    success: true,
    baseDir,
    currentPath,
    breadcrumbs,
    isResourceDir: scriptFiles.isResourceFolder(targetDir),
    items: scriptFiles.listDirectory(targetDir, subPath)
  });
}));

router.get("/admin/server/scripts/file", scriptRoute("Dosya okunurken hata", async (req, res) => {
  const filePath = String(req.query.filePath || "").trim();
  if (!filePath) {
    return res.status(400).json({ success: false, message: "Dosya yolu parametresi eksik." });
  }
  const baseDir = await scriptFiles.getEffectiveScriptsBaseDir();
  const absFile = scriptFiles.resolveSafePath(baseDir, filePath);
  if (!absFile) {
    return res.status(403).json({ success: false, message: "Geçersiz dosya yolu (Erişim kısıtlandı)." });
  }
  if (!fs.existsSync(absFile)) {
    return res.status(404).json({ success: false, message: "Dosya bulunamadı." });
  }
  const stat = fs.statSync(absFile);
  if (!stat.isFile()) {
    return res.status(400).json({ success: false, message: "Belirtilen yol bir dosya değil." });
  }
  const ext = path.extname(absFile).toLowerCase();
  if (scriptFiles.BINARY_EXTENSIONS.has(ext)) {
    return res.status(400).json({
      success: false,
      isBinary: true,
      message: `Bu dosya ikili (${ext}) formattadır ve metin editöründe bozulmaması için düzenlenemez.`
    });
  }
  if (stat.size > MAX_EDITABLE_FILE_BYTES) {
    return res.status(400).json({ success: false, message: "Dosya boyutu çok büyük (> 5MB). Güvenlik ve performans için editörde açılamaz." });
  }

  res.json({
    success: true,
    filePath: filePath.replace(/\\/g, "/"),
    fileName: path.basename(absFile),
    content: fs.readFileSync(absFile, "utf8"),
    size: stat.size,
    modifiedAt: stat.mtime,
    ext,
    resourceName: scriptFiles.detectResourceName(baseDir, absFile)
  });
}));

router.post("/admin/server/scripts/file", scriptRoute("Dosya kaydedilirken hata", async (req, res) => {
  const { filePath, content } = req.body;
  if (!filePath || typeof content !== "string") {
    return res.status(400).json({ success: false, message: "Dosya yolu veya içerik eksik." });
  }
  const baseDir = await scriptFiles.getEffectiveScriptsBaseDir();
  const absFile = scriptFiles.resolveSafePath(baseDir, filePath);
  if (!absFile) {
    return res.status(403).json({ success: false, message: "Güvenlik uyarısı: Tanımlı ana dizin dışına erişilemez." });
  }
  if (scriptFiles.BINARY_EXTENSIONS.has(path.extname(absFile).toLowerCase())) {
    return res.status(400).json({ success: false, message: "İkili formatlardaki dosyalar üzerine yazılamaz." });
  }
  if (Buffer.byteLength(content, "utf8") > MAX_SAVED_FILE_BYTES) {
    return res.status(400).json({ success: false, message: "Kaydedilecek içerik 10MB boyut sınırını aşıyor." });
  }

  if (fs.existsSync(absFile)) {
    try {
      fs.copyFileSync(absFile, absFile + ".bak");
    } catch (bakErr) {
      console.warn("Script backup copy error:", bakErr.message);
    }
  } else {
    fs.mkdirSync(path.dirname(absFile), { recursive: true });
  }
  fs.writeFileSync(absFile, content, "utf8");

  const fileName = path.basename(absFile);
  appendConsoleLogs({ type: "success", text: `[Script Studio] ${fileName} dosyası ${adminName(req, "Yetkili")} tarafından güncellendi ve kaydedildi.` });
  logUserAction(req, "FiveM Script Dosyası Kaydedildi", filePath);

  const newStat = fs.statSync(absFile);
  res.json({
    success: true,
    message: `${fileName} başarıyla kaydedildi (Otomatik .bak yedeği oluşturuldu).`,
    modifiedAt: newStat.mtime,
    size: newStat.size
  });
}));

router.post("/admin/server/scripts/create", scriptRoute("Oluşturma hatası", async (req, res) => {
  const { parentPath, isFolder } = req.body;
  const cleanName = String(req.body.name || "").trim();
  if (!cleanName || scriptFiles.INVALID_NAME.test(cleanName) || cleanName === "." || cleanName === "..") {
    return res.status(400).json({ success: false, message: "Geçersiz dosya/klasör adı. Özel karakterler içeremez." });
  }
  const baseDir = await scriptFiles.getEffectiveScriptsBaseDir();
  const safeParent = scriptFiles.resolveSafePath(baseDir, parentPath || "");
  if (!safeParent) {
    return res.status(403).json({ success: false, message: "Geçersiz üst dizin yolu." });
  }
  if (!fs.existsSync(safeParent)) {
    return res.status(404).json({ success: false, message: "Üst dizin mevcut değil." });
  }
  const targetPath = path.join(safeParent, cleanName);
  if (fs.existsSync(targetPath)) {
    return res.status(400).json({ success: false, message: "Bu isimde bir öğe zaten mevcut." });
  }

  if (isFolder) {
    fs.mkdirSync(targetPath, { recursive: true });
  } else {
    fs.writeFileSync(targetPath, "", "utf8");
  }

  const relPath = path.relative(baseDir, targetPath).replace(/\\/g, "/");
  logUserAction(req, isFolder ? "FiveM Yeni Klasör Oluşturuldu" : "FiveM Yeni Script Dosyası Oluşturuldu", relPath);
  res.json({
    success: true,
    message: isFolder ? `"${cleanName}" klasörü oluşturuldu.` : `"${cleanName}" dosyası oluşturuldu.`,
    newPath: relPath
  });
}));

router.post("/admin/server/scripts/rename", scriptRoute("Yeniden adlandırma hatası", async (req, res) => {
  const { targetPath } = req.body;
  const cleanName = String(req.body.newName || "").trim();
  if (!cleanName || scriptFiles.INVALID_NAME.test(cleanName) || cleanName === "." || cleanName === "..") {
    return res.status(400).json({ success: false, message: "Geçersiz yeni ad. Özel karakterler içeremez." });
  }
  const baseDir = await scriptFiles.getEffectiveScriptsBaseDir();
  const safeTarget = scriptFiles.resolveSafePath(baseDir, targetPath || "");
  if (!safeTarget || scriptFiles.isSamePath(safeTarget, baseDir)) {
    return res.status(403).json({ success: false, message: "Kök dizin yeniden adlandırılamaz." });
  }
  if (!fs.existsSync(safeTarget)) {
    return res.status(404).json({ success: false, message: "Hedef öğe bulunamadı." });
  }
  const destPath = path.join(path.dirname(safeTarget), cleanName);
  if (fs.existsSync(destPath)) {
    return res.status(400).json({ success: false, message: "Hedef dizinde bu isimde başka bir öğe mevcut." });
  }

  fs.renameSync(safeTarget, destPath);
  const newRel = path.relative(baseDir, destPath).replace(/\\/g, "/");
  logUserAction(req, "FiveM Script/Dosya Yeniden Adlandırıldı", `${targetPath} -> ${newRel}`);
  res.json({ success: true, message: "Başarıyla yeniden adlandırıldı.", newPath: newRel });
}));

router.post("/admin/server/scripts/delete", scriptRoute("Silme işlemi sırasında hata", async (req, res) => {
  const { targetPath } = req.body;
  if (!targetPath) {
    return res.status(400).json({ success: false, message: "Silinecek hedef yol belirtilmedi." });
  }
  const baseDir = await scriptFiles.getEffectiveScriptsBaseDir();
  const safeTarget = scriptFiles.resolveSafePath(baseDir, targetPath);
  if (!safeTarget || scriptFiles.isSamePath(safeTarget, baseDir)) {
    return res.status(403).json({ success: false, message: "Güvenlik kuralı: Kök dizin silinemez." });
  }
  if (!fs.existsSync(safeTarget)) {
    return res.status(404).json({ success: false, message: "Silinmek istenen öğe bulunamadı." });
  }

  if (fs.statSync(safeTarget).isDirectory()) {
    fs.rmSync(safeTarget, { recursive: true, force: true });
  } else {
    fs.unlinkSync(safeTarget);
  }
  logUserAction(req, "FiveM Script/Dosya Silindi", targetPath);
  res.json({ success: true, message: "Öğe başarıyla silindi." });
}));

router.post("/admin/server/scripts/restart-resource", scriptRoute("Komut gönderilirken hata", async (req, res) => {
  const cleanName = String(req.body.resourceName || "").trim();
  if (!cleanName || !/^[a-zA-Z0-9_\-[\]]+$/.test(cleanName)) {
    return res.status(400).json({ success: false, message: "Geçersiz resource adı." });
  }
  const adminUser = adminName(req, "Yetkili");
  const result = await dispatchCommand("execute_command", { command: `restart ${cleanName}`, admin: adminUser });
  appendConsoleLogs({ type: result.ok ? "info" : "danger", text: `[Resource Restart] restart ${cleanName} (${adminUser}): ${result.message}` });
  logUserAction(req, "FiveM Script Yeniden Başlatıldı (restart)", `${cleanName} -> ${result.status}`);
  sendDispatchResult(res, result, { message: `"${cleanName}": ${result.message}` });
}));

module.exports = router;
