const express = require("express");
const { DiscordUser, ActionLog } = require("../../models/ServerInfo");
const { getUserPermissions } = require("../../services/permissions");
const { userAvatarUrl, FALLBACK_AVATAR } = require("../../utils/discordAvatar");
const { escapeRegex } = require("../../utils/http");

const router = express.Router();

const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const SSE_PING_INTERVAL_MS = 15000;
const DEFAULT_RANK = { name: "Yetkili", color: "#3B82F6" };
const SUPERUSER_RANK = { name: "Kurucu", color: "#ef4444" };
const MAX_LOG_PAGE_SIZE = 100;

// Staff members currently using the panel, keyed by Discord id.
const activeAdmins = {};
const sseClients = [];

const LOG_CATEGORIES = {
  fivem: ["fivemCharacterUpdate", "fivemCharacterItemDelete", "fivemCharacterInventoryClear", "fivemCharacterDelete", "giveitem", "givemoney", "setjob", "setgang", "pedver", "pedal", "kill", "revive"],
  user_auth: ["userLogin", "userLogout", "userRegister", "userPasswordChange"],
  team: ["teamCreate", "teamDelete", "teamVoiceSupport", "teamAddMember", "teamRemoveMember", "teamBlacklistAdd", "teamMembersWipe", "teamMembersUnwipe"],
  punishment: ["punishmentGive", "provideInitiative", "punishmentRemove", "userBan", "userUnban", "userBlacklistAdd", "userBlacklistRemove"],
  bot: ["botEdit", "massVoiceJoin", "massPresenceUpdate", "massProfileUpdate"],
  gambling: ["sweetBonanzaSpin", "sweetBonanzaBuyBonus", "fruitSlotSpin", "fruitSlotBuyBonus", "rouletteBet", "rouletteResult", "luckyWheelSpin", "blackjackSit", "blackjackLeave", "blackjackBet", "blackjackAction", "blackjackResult", "blackjackFaucet"],
  admin_actions: ["rankCreate", "rankDelete", "rankUpdate", "bulkPermissionsUpdate", "giveCredits", "donateCreate", "donateEdit", "entertainmentSettingsUpdate"]
};

function activeStaffList() {
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  return Object.entries(activeAdmins)
    .filter(([, u]) => u.lastSeen > cutoff)
    .map(([discordId, u]) => ({ discordId, ...u }));
}

function broadcastActiveStaff() {
  const data = JSON.stringify({ success: true, activeStaff: activeStaffList() });
  for (const client of sseClients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch (err) {}
  }
}

// Marks the session user as active, using their rank for the badge shown to other staff.
async function markActive(sessionUser, perms) {
  const userDoc = await DiscordUser.findOne({ discordId: sessionUser.id }).populate("rankId");
  let rank = DEFAULT_RANK;
  if (userDoc && userDoc.rankId) {
    rank = { name: userDoc.rankId.name || DEFAULT_RANK.name, color: userDoc.rankId.color || DEFAULT_RANK.color };
  } else if (perms.isSuperuser) {
    rank = SUPERUSER_RANK;
  }
  activeAdmins[sessionUser.id] = {
    username: sessionUser.username,
    avatarUrl: (userDoc && userDoc.avatarUrl) || (sessionUser.avatar ? userAvatarUrl({ id: sessionUser.id, avatar: sessionUser.avatar }) : FALLBACK_AVATAR),
    rankName: rank.name,
    rankColor: rank.color,
    lastSeen: Date.now()
  };
}

async function staffPerms(req) {
  const perms = await getUserPermissions(req.session.user);
  return perms && (perms.isSuperuser || perms.viewOverview) ? perms : null;
}

router.get("/admin/api/active-staff", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ success: false, message: "Oturum kapalı." });
  }
  const perms = await staffPerms(req);
  if (!perms) {
    return res.status(403).json({ success: false, message: "Yetersiz yetki." });
  }
  try {
    await markActive(req.session.user, perms);
    res.json({ success: true, activeStaff: activeStaffList() });
  } catch (err) {
    console.error("Active staff API error:", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

router.get("/admin/api/active-staff/sse", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).send("Unauthorized");
  }
  const perms = await staffPerms(req);
  if (!perms) {
    return res.status(403).send("Forbidden");
  }

  const userId = req.session.user.id;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  res.userId = userId;
  sseClients.push(res);

  try {
    await markActive(req.session.user, perms);
  } catch (err) {
    console.error("SSE registration error:", err);
  }
  broadcastActiveStaff();

  const pingInterval = setInterval(() => {
    if (activeAdmins[userId]) activeAdmins[userId].lastSeen = Date.now();
    try {
      res.write(":\n\n");
    } catch (err) {}
  }, SSE_PING_INTERVAL_MS);

  req.on("close", () => {
    clearInterval(pingInterval);
    const index = sseClients.indexOf(res);
    if (index !== -1) sseClients.splice(index, 1);
    if (!sseClients.some(c => c.userId === userId)) delete activeAdmins[userId];
    broadcastActiveStaff();
  });
});

function dateRangeStart(dateRange) {
  const start = new Date();
  if (dateRange === "today") {
    start.setHours(0, 0, 0, 0);
  } else if (dateRange === "7days") {
    start.setDate(start.getDate() - 7);
  } else if (dateRange === "30days") {
    start.setDate(start.getDate() - 30);
  }
  return start;
}

router.get("/admin/api/system-logs", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ success: false, message: "Oturum kapalı." });
  }
  const perms = await getUserPermissions(req.session.user);
  if (!perms || !perms.isSuperuser) {
    return res.status(403).json({ success: false, message: "Bu sayfayı sadece Kurucular (isSuperuser) görüntüleyebilir." });
  }

  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(MAX_LOG_PAGE_SIZE, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const search = String(req.query.search || "").trim();
    const actionType = String(req.query.actionType || "all").trim();
    const category = String(req.query.category || "all").trim();
    const dateRange = String(req.query.dateRange || "all").trim();

    const query = {};
    if (actionType !== "all") {
      query.actionType = actionType;
    } else if (LOG_CATEGORIES[category]) {
      query.actionType = { $in: LOG_CATEGORIES[category] };
    }
    if (dateRange !== "all") {
      query.timestamp = { $gte: dateRangeStart(dateRange) };
    }
    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      query.$or = ["executorUsername", "executorId", "targetUsername", "targetId", "actionType", "details", "executorIp", "context"]
        .map(field => ({ [field]: regex }));
    }

    const totalCount = await ActionLog.countDocuments(query);
    const logs = await ActionLog.find(query).sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit).lean();

    res.json({ success: true, page, limit, totalCount, totalPages: Math.ceil(totalCount / limit) || 1, logs });
  } catch (err) {
    console.error("GET /admin/api/system-logs error:", err);
    res.status(500).json({ success: false, message: "Loglar çekilirken hata oluştu." });
  }
});

router.get("/admin/api/system-logs/action-types", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ success: false, message: "Oturum kapalı." });
  }
  const perms = await getUserPermissions(req.session.user);
  if (!perms || !perms.isSuperuser) {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }
  try {
    res.json({ success: true, actionTypes: await ActionLog.distinct("actionType") });
  } catch (err) {
    res.status(500).json({ success: false, actionTypes: [] });
  }
});

module.exports = router;
