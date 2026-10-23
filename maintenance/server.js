const express = require("express");
const path = require("path");
const chalk = require("chalk");
const maintenanceConfig = require("./config");

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Public statik klasörünü bağla (CSS, resimler vb. için)
app.use(express.static(path.join(__dirname, "..", "public")));

// API Uç Noktası (Bakım Durumu JSON)
app.get("/api/maintenance/status", (req, res) => {
  res.json({
    status: "MAINTENANCE",
    version: maintenanceConfig.version,
    title: maintenanceConfig.title,
    reason: maintenanceConfig.reason,
    endTime: maintenanceConfig.endTime,
    progressPercent: maintenanceConfig.progressPercent
  });
});

// Tüm HTTP İsteklerini Bakım Sayfasına Yönlendir
app.use((req, res) => {
  res.status(503).render("index", { config: maintenanceConfig });
});

const PORT = maintenanceConfig.port || 3000;

const server = app.listen(PORT, () => {
  console.log(chalk.bold.yellow("\n=================================================="));
  console.log(chalk.bold.cyan(" 🛠️  SHIELD SOFTWARE STANDALONE BAKIM MODU SUNUCUSU AKTİF"));
  console.log(chalk.bold.yellow("=================================================="));
  console.log(chalk.green(` 🚀 Sunucu Dinleniyor: `) + chalk.bold.white(`http://localhost:${PORT}`));
  console.log(chalk.green(` 📌 Modül Sürümü: `) + chalk.bold.white(maintenanceConfig.version));
  console.log(chalk.green(` ⏳ Tahmini Bitiş: `) + chalk.bold.white(maintenanceConfig.endTime || "Belirtilmedi"));
  console.log(chalk.bold.yellow("==================================================\n"));
});

process.on("SIGINT", () => {
  console.log(chalk.red("\n[Bakım Sunucusu] Kapatılıyor..."));
  server.close(() => {
    process.exit(0);
  });
});
