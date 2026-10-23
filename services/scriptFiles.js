const fs = require("fs");
const path = require("path");
const { ServerStats } = require("../models/ServerInfo");

const PROJECT_ROOT = path.join(__dirname, "..");
const BUNDLED_RESOURCE_DIR = path.join(PROJECT_ROOT, "shield-software");

const EDITABLE_EXTENSIONS = new Set([
  ".lua", ".js", ".mjs", ".cjs", ".json", ".cfg", ".txt", ".html", ".htm",
  ".css", ".scss", ".xml", ".meta", ".sql", ".md", ".yml", ".yaml", ".ini",
  ".env", ".bat", ".cmd", ".sh", ".ps1", ".log"
]);

const BINARY_EXTENSIONS = new Set([
  ".ytd", ".ydr", ".yft", ".ybn", ".ymap", ".ytyp", ".rpf", ".exe", ".dll",
  ".zip", ".rar", ".7z", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
  ".ogg", ".wav", ".mp3", ".mp4", ".node", ".bin", ".dat"
]);

const IGNORED_ENTRIES = new Set([".git", "node_modules"]);
const INVALID_NAME = /[\\/:*?"<>|\0]/;

// Windows paths are case-insensitive; elsewhere a case-folded comparison would allow escaping into sibling folders.
function comparablePath(p) {
  const normalized = path.normalize(p);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isSamePath(a, b) {
  return comparablePath(path.resolve(a)) === comparablePath(path.resolve(b));
}

// Root folder of the script manager: configured resources path, the server.cfg folder, or the bundled resource.
async function getEffectiveScriptsBaseDir() {
  try {
    const stats = await ServerStats.findOne();
    if (stats && stats.serverResourcesPath && stats.serverResourcesPath.trim()) {
      const customPath = path.resolve(stats.serverResourcesPath.trim());
      if (fs.existsSync(customPath)) return customPath;
    }
    if (stats && stats.serverCfgPath && stats.serverCfgPath.trim()) {
      const cfgDir = path.dirname(path.resolve(stats.serverCfgPath.trim()));
      const resDir = path.join(cfgDir, "resources");
      if (fs.existsSync(resDir)) return resDir;
      if (fs.existsSync(cfgDir)) return cfgDir;
    }
  } catch (err) {
    console.error("[Scripts] Base directory lookup failed:", err.message);
  }
  return fs.existsSync(BUNDLED_RESOURCE_DIR) ? BUNDLED_RESOURCE_DIR : PROJECT_ROOT;
}

// Absolute path for a client-supplied relative path, or null if it would leave baseDir.
function resolveSafePath(baseDir, requestedSubPath = "") {
  if (!baseDir) return null;
  try {
    const safeBase = path.resolve(baseDir);
    const target = path.resolve(safeBase, String(requestedSubPath || "").replace(/\0/g, ""));
    const base = comparablePath(safeBase);
    const candidate = comparablePath(target);
    if (candidate !== base && !candidate.startsWith(base.endsWith(path.sep) ? base : base + path.sep)) {
      return null;
    }
    return target;
  } catch (err) {
    return null;
  }
}

function isResourceFolder(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory() &&
      (fs.existsSync(path.join(dirPath, "fxmanifest.lua")) || fs.existsSync(path.join(dirPath, "__resource.lua")));
  } catch (err) {
    return false;
  }
}

// Name of the FiveM resource (folder with a manifest) that contains the file, if any.
function detectResourceName(baseDir, absFilePath) {
  const safeBase = path.resolve(baseDir);
  let current = path.dirname(absFilePath);
  while (current && current.length >= safeBase.length) {
    if (isResourceFolder(current)) return path.basename(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function listDirectory(targetDir, subPath) {
  const items = [];
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    if (IGNORED_ENTRIES.has(entry.name)) continue;
    const fullPath = path.join(targetDir, entry.name);
    let entryStat;
    try {
      entryStat = fs.statSync(fullPath);
    } catch (err) {
      continue;
    }
    const isDir = entry.isDirectory();
    const ext = isDir ? "" : path.extname(entry.name).toLowerCase();
    items.push({
      name: entry.name,
      relPath: subPath ? path.posix.join(subPath.replace(/\\/g, "/"), entry.name) : entry.name,
      isDir,
      isResource: isDir && isResourceFolder(fullPath),
      isCategory: isDir && entry.name.startsWith("[") && entry.name.endsWith("]"),
      size: entryStat.size,
      modifiedAt: entryStat.mtime,
      ext,
      isEditable: !isDir && EDITABLE_EXTENSIONS.has(ext),
      isBinary: !isDir && BINARY_EXTENSIONS.has(ext)
    });
  }
  return items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

module.exports = {
  PROJECT_ROOT,
  BUNDLED_RESOURCE_DIR,
  BINARY_EXTENSIONS,
  INVALID_NAME,
  isSamePath,
  getEffectiveScriptsBaseDir,
  resolveSafePath,
  isResourceFolder,
  detectResourceName,
  listDirectory
};
