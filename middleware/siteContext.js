const { getCachedSiteModules, getCachedServerStats, getCachedUserCredits } = require("../services/siteCache");
const { getUserPermissions } = require("../services/permissions");
const { hexToRgb } = require("../utils/format");
const { wantsJson } = require("../utils/http");

const DEFAULT_THEME_COLOR = "#0071e3";
const MAINTENANCE_EXEMPT_PREFIXES = ["/css", "/images", "/js", "/favicon", "/auth", "/login"];

// Populates template locals shared by every page (modules, theme, user, permissions)
// and enforces maintenance mode for non-admins.
async function siteContext(req, res, next) {
  try {
    const { modules, moduleDetails } = await getCachedSiteModules();
    res.locals.currentPath = req.originalUrl;
    res.locals.modules = modules;
    res.locals.moduleDetails = moduleDetails;

    const stats = await getCachedServerStats();
    const themeColor = (stats && stats.themeColor) || DEFAULT_THEME_COLOR;
    res.locals.themeColor = themeColor;
    res.locals.themeColorRgb = hexToRgb(themeColor);

    if (req.session.user) {
      const perms = await getUserPermissions(req.session.user);
      res.locals.user = req.session.user;
      res.locals.userPermissions = perms;
      if (perms && perms.isSuperuser) {
        req.session.user.isSuperuser = true;
      }
      res.locals.userCredits = await getCachedUserCredits(req.session.user.id);
    } else {
      res.locals.user = null;
      res.locals.userPermissions = null;
      res.locals.userCredits = 0;
    }

    if (modules.maintenance && req.path !== "/maintenance" && !MAINTENANCE_EXEMPT_PREFIXES.some(p => req.path.startsWith(p))) {
      const perms = res.locals.userPermissions;
      const isAdmin = req.session.user && (req.session.user.isSuperuser || (perms && perms.manageWebsite));
      if (!isAdmin) return res.redirect("/maintenance");
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Public page guard: a disabled module shows its preloader page, a JSON 403 or redirects home.
function checkModule(moduleKey) {
  return (req, res, next) => {
    if (!res.locals.modules || res.locals.modules[moduleKey]) return next();

    const details = res.locals.moduleDetails ? res.locals.moduleDetails[moduleKey] : null;
    if (details && details.behavior === "preloader") {
      return res.render("module_preloader", { moduleName: details.name, moduleKey, customMessage: details.customMessage });
    }
    if (wantsJson(req)) {
      return res.status(403).json({ success: false, message: "Bu modül geçici olarak devre dışı bırakılmıştır." });
    }
    res.redirect("/");
  };
}

// Admin URL prefix -> SiteModule key that must be enabled for it (first match wins).
const ADMIN_MODULE_RULES = [
  [["/users/discord-unban"], "admin_banned"],
  [["/users/punish"], "admin_punishments"],
  [["/users/blacklist"], "admin_blacklist"],
  [[
    "/api/users", "/users/assign", "/users/update-description", "/users/add", "/users/whitelist",
    "/users/delete", "/users/tum-rolleri-kaldir", "/users/voice-support", "/users/sync-whitelist",
    "/users/sensitive-toggle", "/users/discord-kick", "/users/discord-ban"
  ], "admin_users"],
  [["/teams"], "admin_teams"],
  [["/applications", "/submissions"], "admin_applications"],
  [["/add-update", "/delete-update", "/updates"], "admin_updates"],
  [["/donate"], "admin_donate"],
  [["/ranks"], "admin_ranks"],
  [["/bots"], "admin_bots"],
  [["/website/faq"], "admin_faq"],
  [["/website/gallery"], "admin_gallery"],
  [["/logos-banners"], "admin_logos"],
  [["/settings/theme"], "admin_theme"]
];

function requiredAdminModule(subPath) {
  const rule = ADMIN_MODULE_RULES.find(([prefixes]) => prefixes.some(p => subPath.startsWith(p)));
  return rule ? rule[1] : null;
}

// Mounted on /admin: blocks admin features whose module was switched off in developer settings.
function adminModuleGuard(req, res, next) {
  if (req.path === "/dashboard" && req.method === "GET") return next();
  if (req.path.startsWith("/developer")) return next();

  const requiredModule = requiredAdminModule(req.path);
  if (requiredModule && res.locals.modules && res.locals.modules[requiredModule] === false) {
    if (wantsJson(req)) {
      return res.status(403).json({ success: false, message: "Bu yönetim modülü geliştirici ayarlarından kapatılmıştır." });
    }
    return res.status(403).send("Forbidden: Bu bölüm devre dışı bırakılmıştır.");
  }
  next();
}

module.exports = { siteContext, checkModule, adminModuleGuard, requiredAdminModule };
