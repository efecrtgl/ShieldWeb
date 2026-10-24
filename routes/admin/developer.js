const express = require("express");
const path = require("path");
const axios = require("axios");
const mongoose = require("mongoose");
const AdmZip = require("adm-zip");
const config = require("../../config");
const { SiteModule, ServerStats, DiscordBot } = require("../../models/ServerInfo");
const { getUserPermissions } = require("../../services/permissions");
const { actorFrom, logAction } = require("../../services/auditLog");
const { addLog, logUserAction } = require("../../services/systemLog");
const { activeProcesses, isConnected } = require("../../services/botRegistry");
const { botConfigMessage } = require("../../services/botSupervisor");
const { API, botHeaders, getAllGuildMembers } = require("../../services/discordApi");
const { jsonFile } = require("../../middleware/upload");

const router = express.Router();

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const ROLE_RESTORE_DELAY_MS = 250;
// Never shipped in a website-files backup: dependencies, VCS/tool folders, logs and secrets.
const BACKUP_EXCLUDED_DIRS = new Set(["node_modules", ".git", ".gemini", ".claude", ".taste-skill", "tmp", "logs"]);
const BACKUP_EXCLUDED_FILE = /^\.env(\..*)?$/;
// Files holding secrets, matched by their path from the project root.
const BACKUP_EXCLUDED_PATHS = new Set(["shield-software/config.json"]);

const DISCORD_SETTING_FIELDS = [
  "guildId", "loggerGuildId", "whitelistRoleId", "unregisteredRoleId", "staffRoleId", "voiceSupportRoleId",
  "illegalCategoryId", "legalCategoryId", "bossRoleId", "highCommandRoleId", "characterApprovalRoleId", "wlPunishedRoleId",
  "warning1RoleId", "warning2RoleId", "warning3RoleId", "warning4RoleId", "warning5RoleId", "warning6RoleId",
  "warning7RoleId", "warning8RoleId", "warning9RoleId"
];
// Only overwritten when a non-empty value is submitted.
const OPTIONAL_DISCORD_SETTING_FIELDS = ["businessCategoryId", "applicationLogChannelId", "punishmentLogChannelId", "streamerAnnounceChannelId"];

function allowDeveloper(flag) {
  return async (req, res, next) => {
    const perms = await getUserPermissions(req.session.user);
    if (!perms || (!perms.isSuperuser && !perms[flag])) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    next();
  };
}

function syncBotToken() {
  return config.hasBotToken("sync") ? config.bots.sync.token : null;
}

async function configuredGuildId() {
  const stats = await ServerStats.findOne();
  return (stats && stats.guildId) || config.discord.guildId;
}

router.post("/admin/developer/modules/toggle", allowDeveloper("editDeveloper"), async (req, res) => {
  try {
    const { key, isEnabled } = req.body;
    await SiteModule.findOneAndUpdate({ key }, { isEnabled: !!isEnabled });
    res.json({ success: true, message: "Modül durumu başarıyla güncellendi." });
  } catch (error) {
    console.error("Module toggle error:", error);
    res.status(500).json({ success: false, message: "Modül güncellenirken hata oluştu." });
  }
});

router.post("/admin/developer/modules/update-settings", allowDeveloper("editDeveloper"), async (req, res) => {
  try {
    const { key, behavior, customMessage } = req.body;
    await SiteModule.findOneAndUpdate({ key }, { behavior, customMessage });
    res.json({ success: true, message: "Modül ayarları başarıyla kaydedildi." });
  } catch (error) {
    console.error("Module settings update error:", error);
    res.status(500).json({ success: false, message: "Ayarlar güncellenirken hata oluştu." });
  }
});

router.post("/admin/developer/discord-roles", allowDeveloper("editDeveloper"), async (req, res) => {
  try {
    const stats = (await ServerStats.findOne()) || new ServerStats();
    for (const field of DISCORD_SETTING_FIELDS) {
      stats[field] = req.body[field];
    }
    for (const field of OPTIONAL_DISCORD_SETTING_FIELDS) {
      if (req.body[field]) stats[field] = req.body[field];
    }
    if (typeof req.body.errorMode !== "undefined") {
      stats.errorMode = req.body.errorMode;
    }
    await stats.save();
    logUserAction(req, "Geliştirici Ayarları Güncellendi", `Error Mode: ${stats.errorMode}`);

    // Push the (possibly changed) error mode to every running bot.
    for (const bot of await DiscordBot.find()) {
      const child = activeProcesses[bot.botId];
      if (isConnected(child)) {
        child.send(botConfigMessage("UPDATE_CONFIG", bot, stats.errorMode));
      }
    }
    res.json({ success: true, message: "Discord rol ve sistem ayarları başarıyla kaydedildi." });
  } catch (error) {
    console.error("Save Discord roles error:", error);
    res.status(500).json({ success: false, message: "Ayarlar kaydedilirken hata oluştu." });
  }
});

async function databaseBackup() {
  const zip = new AdmZip();
  for (const modelName of mongoose.modelNames()) {
    try {
      const documents = await mongoose.model(modelName).find({}).lean();
      zip.addFile(`${modelName.toLowerCase()}.json`, Buffer.from(JSON.stringify(documents, null, 2), "utf-8"));
    } catch (modelErr) {
      console.error(`Error backing up model ${modelName}:`, modelErr);
    }
  }
  return zip.toBuffer();
}

async function discordRolesBackup(guildId, token) {
  const { data: roles } = await axios.get(`${API}/guilds/${guildId}/roles`, { headers: botHeaders(token) });
  let members = [];
  try {
    members = (await getAllGuildMembers()).map(m => ({ userId: m.user.id, username: m.user.username, roles: m.roles || [] }));
  } catch (memErr) {
    console.error("Failed to backup guild members for roles backup:", memErr.message);
  }
  return Buffer.from(JSON.stringify({ roles, members }, null, 2), "utf-8");
}

// Whether a project-relative path may go into the downloadable website-files backup.
function includeInBackup(relativePath) {
  const parts = relativePath.split(/[\\/]/);
  if (parts.some(part => BACKUP_EXCLUDED_DIRS.has(part))) return false;
  if (BACKUP_EXCLUDED_PATHS.has(parts.join("/"))) return false;
  return !BACKUP_EXCLUDED_FILE.test(parts[parts.length - 1]);
}

function websiteFilesBackup() {
  const zip = new AdmZip();
  zip.addLocalFolder(PROJECT_ROOT, "", filepath => includeInBackup(path.relative(PROJECT_ROOT, filepath)));
  return zip.toBuffer();
}

function sendDownload(res, contentType, filename, buffer) {
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
  res.send(buffer);
}

router.get("/admin/developer/backup/:type", async (req, res) => {
  if (!req.session.user) {
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  const perms = await getUserPermissions(req.session.user);
  if (!perms || (!perms.isSuperuser && !perms.manageDeveloper)) {
    return res.status(403).send("Forbidden");
  }

  const { type } = req.params;
  const stamp = Date.now();
  try {
    if (type === "database") {
      return sendDownload(res, "application/zip", `database-backup-${stamp}.zip`, await databaseBackup());
    }
    if (type === "discord-roles") {
      const guildId = await configuredGuildId();
      if (!guildId) return res.status(400).send("Guild ID is not configured.");
      const token = syncBotToken();
      if (!token) return res.status(400).send("Sync bot token (BOT4_TOKEN) is not configured.");
      return sendDownload(res, "application/json", `discord-roles-backup-${stamp}.json`, await discordRolesBackup(guildId, token));
    }
    if (type === "website-files") {
      return sendDownload(res, "application/zip", `website-files-backup-${stamp}.zip`, websiteFilesBackup());
    }
    res.status(400).send("Invalid backup type.");
  } catch (error) {
    console.error(`Backup error for type ${type}:`, error);
    res.status(500).send("Internal Server Error");
  }
});

async function restoreMemberRoles(req, guildId, token, members, currentRoleIds) {
  let successCount = 0;
  let failureCount = 0;
  addLog("Orchestrator", `[Backup Restore] Discord Rol Geri Yükleme işlemi başlatıldı. Toplam üye: ${members.length}`);

  for (const member of members) {
    const validRoles = (member.roles || []).filter(roleId => currentRoleIds.has(roleId));
    try {
      await axios.patch(`${API}/guilds/${guildId}/members/${member.userId}`, { roles: validRoles }, {
        headers: { ...botHeaders(token), "Content-Type": "application/json" }
      });
      successCount++;
    } catch (err) {
      failureCount++;
      console.error(`[Backup Restore] Failed to restore roles for ${member.username} (${member.userId}):`, err.response ? err.response.data : err.message);
    }
    await new Promise(resolve => setTimeout(resolve, ROLE_RESTORE_DELAY_MS));
  }

  addLog("Orchestrator", `[Backup Restore] Discord Rol Geri Yükleme işlemi tamamlandı. Başarılı: ${successCount}, Başarısız: ${failureCount}`);
  logAction("discordRolesRestore", {
    executor: actorFrom(req),
    details: `Discord Rol Geri Yükleme tamamlandı. Başarılı: ${successCount}, Başarısız: ${failureCount} (Toplam: ${members.length})`,
    context: "Web Panel"
  });
}

router.post("/admin/developer/backup/restore-roles", allowDeveloper("manageDeveloper"), jsonFile("backupFile"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "Yedek dosyası yüklenmedi." });
  }
  try {
    const guildId = await configuredGuildId();
    if (!guildId) {
      return res.status(400).json({ success: false, message: "Guild ID is not configured." });
    }
    const token = syncBotToken();
    if (!token) {
      return res.status(400).json({ success: false, message: "Sync bot token (BOT4_TOKEN) is not configured." });
    }

    let backupData;
    try {
      backupData = JSON.parse(req.file.buffer.toString("utf-8"));
    } catch (parseErr) {
      return res.status(400).json({ success: false, message: "Yedek dosyası geçerli bir JSON değil." });
    }
    if (!backupData || !Array.isArray(backupData.members)) {
      return res.status(400).json({ success: false, message: "Geçersiz yedek dosyası formatı. 'members' dizisi bulunamadı." });
    }

    const { data: roles } = await axios.get(`${API}/guilds/${guildId}/roles`, { headers: botHeaders(token) });
    const currentRoleIds = new Set(roles.map(r => r.id));

    // Restoration is rate-limited and slow, so it runs after the response is sent.
    res.json({ success: true, message: `Rolleri geri yükleme işlemi arka planda başlatıldı. Toplam ${backupData.members.length} üye işleniyor.` });
    restoreMemberRoles(req, guildId, token, backupData.members, currentRoleIds)
      .catch(err => console.error("[Backup Restore] Background worker crash:", err));
  } catch (error) {
    console.error("Restore roles error:", error);
    res.status(500).json({ success: false, message: `Dahili Hata: ${error.message}` });
  }
});

module.exports = router;
module.exports.includeInBackup = includeInBackup;
