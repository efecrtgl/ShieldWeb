const config = require("../config");
const { DiscordUser, UserRank, Rank } = require("../models/ServerInfo");
const { verifyDiscordGuildMember } = require("./discordApi");

const PERMISSION_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_RANK_ORDER = 999;

// Every permission flag a Rank document can grant (used by the rank editor forms).
const ALL_RANK_PERM_KEYS = [
  "viewOverview",
  "viewUsers", "editUsers", "deleteUsers", "syncUsers",
  "wlGive", "wlTake", "voiceSupportToggle", "discordBan", "discordUnban", "discordKick", "blacklistAdd", "blacklistRemove", "removeAllRoles", "dbDeleteUser",
  "viewTeams", "createTeams", "createDepartment", "editTeams", "deleteTeams",
  "teamAddMember", "teamRemoveMember", "teamDiscordBan", "teamDiscordKick", "teamSendDm", "teamWlGive", "teamWlTake", "teamGiveRole", "teamRevive", "teamBlacklistAdd", "teamBlacklistRemove", "teamWipe", "teamVoiceSupportToggle",
  "businessCreate", "businessDelete", "businessAddMember", "businessRemoveMember", "businessKick", "businessBan", "businessSendDm", "businessWlGive", "businessWlTake", "businessGiveRole", "businessRevive", "businessBlacklistAdd", "businessWipe",
  "charEditModal", "charEditName", "charEditBirthdate", "charEditMoney", "charEditJob", "charClearInventory", "charDeleteItem",
  "viewPunishments", "applyPunishments", "clearPunishments", "provideInitiative",
  "banUser", "unbanUser", "blacklistUserAdd", "blacklistUserRemove",
  "viewApplications", "editApplications", "deleteApplications", "reviewApplications",
  "viewUpdates", "createUpdates", "editUpdates", "deleteUpdates",
  "viewDonate", "editDonate", "deleteDonate", "giveCredits",
  "viewRanks", "createRanks", "editRanks", "deleteRanks",
  "viewBots", "manageBots", "viewWebsite", "editWebsite", "viewDeveloper", "editDeveloper", "fivemBridgeCommands"
];

const LEGACY_PERM_KEYS = [
  "manageUsers", "manageTeams", "managePunishments", "manageApplications", "manageUpdates",
  "manageDonate", "manageRanks", "manageBots", "manageWebsite", "manageDeveloper"
];

const SUPERUSER_PERMS = Object.freeze({
  isSuperuser: true,
  isProjectLeader: true,
  viewOverview: true,
  viewUsers: true, editUsers: true, deleteUsers: true, syncUsers: true,
  wlGive: true, wlTake: true, voiceSupportToggle: true, discordBan: true, discordUnban: true, discordKick: true,
  blacklistAdd: true, blacklistRemove: true, removeAllRoles: true, dbDeleteUser: true,
  viewTeams: true, createTeams: true, editTeams: true, deleteTeams: true,
  teamAddMember: true, teamRemoveMember: true, teamDiscordBan: true, teamDiscordKick: true,
  teamBlacklistAdd: true, teamBlacklistRemove: true, teamVoiceSupportToggle: true,
  viewPunishments: true, applyPunishments: true, clearPunishments: true, provideInitiative: true,
  unbanUser: true, banUser: true,
  blacklistUserAdd: true, blacklistUserRemove: true,
  viewApplications: true, editApplications: true, deleteApplications: true, reviewApplications: true,
  viewUpdates: true, createUpdates: true, editUpdates: true, deleteUpdates: true,
  viewDonate: true, editDonate: true, deleteDonate: true, giveCredits: true,
  viewRanks: true, createRanks: true, editRanks: true, deleteRanks: true,
  viewBots: true, manageBots: true,
  viewWebsite: true, editWebsite: true,
  viewDeveloper: true, editDeveloper: true,
  manageUsers: true, manageTeams: true, managePunishments: true, manageApplications: true, manageUpdates: true,
  manageDonate: true, manageRanks: true, manageWebsite: true, manageDeveloper: true,
  fivemBridgeCommands: true
});

const NO_PERMS = Object.freeze({
  isSuperuser: false,
  isProjectLeader: false,
  ...Object.fromEntries([...ALL_RANK_PERM_KEYS, ...LEGACY_PERM_KEYS].map(key => [key, false]))
});

const PROJECT_LEADER_KEYWORDS = ["project leader", "project", "leader", "kurucu", "owner", "yonetim", "yönetim"];
const ADMIN_KEYWORDS = ["admin", "administrator", "yönetici", "yonetici", "head", "lead", "chief", "senior"];

const permissionsCache = new Map();

function rankNameMatches(rank, keywords) {
  const name = (rank.name || "").toLowerCase();
  return keywords.some(k => name.includes(k));
}

function hasAnyPermission(perms) {
  return !!perms && (perms.isSuperuser || Object.values(perms).some(v => v === true));
}

// Ranks granted via DiscordUser/UserRank records plus ranks mapped to the member's live Discord roles.
async function collectApplicableRanks(userSession) {
  const [discordUserObj, userRankObj] = await Promise.all([
    DiscordUser.findOne({ discordId: userSession.id }).populate("rankId"),
    UserRank.findOne({ discordId: userSession.id }).populate("rankId")
  ]);

  const ranks = [];
  const addRank = rank => {
    if (rank && !ranks.some(r => r._id.toString() === rank._id.toString())) ranks.push(rank);
  };
  if (discordUserObj) addRank(discordUserObj.rankId);
  if (userRankObj) addRank(userRankObj.rankId);

  let liveUsername = userSession.username || "";
  let liveAvatarUrl = userSession.avatarUrl || "";

  try {
    const memberCheck = await verifyDiscordGuildMember(userSession.id);
    if (memberCheck && memberCheck.inGuild && Array.isArray(memberCheck.roles) && memberCheck.roles.length > 0) {
      if (memberCheck.username) liveUsername = memberCheck.username;
      if (memberCheck.avatarUrl) liveAvatarUrl = memberCheck.avatarUrl;

      const roleRanks = await Rank.find({ discordRoleId: { $exists: true, $ne: "" } }).sort({ order: 1 });
      roleRanks.filter(r => memberCheck.roles.includes(r.discordRoleId.trim())).forEach(addRank);
    }
  } catch (err) {
    console.error("[getUserPermissions] Live Discord role check error:", err.message);
  }

  return { ranks, liveUsername, liveAvatarUrl };
}

function computeRankPermissions(applicableRanks) {
  // A permission is granted when ANY applicable rank grants it (optionally via a legacy fallback flag).
  const hasPerm = (key, fallbackFn) => {
    if (applicableRanks.some(r => (r.permissions || {})[key] === true)) return true;
    if (typeof fallbackFn === "function") {
      return applicableRanks.some(r => fallbackFn(r.permissions || {}) === true);
    }
    return false;
  };

  // NOTE: several flags below default to `true` for any ranked staff member. This mirrors the
  // existing business rules of the panel and is intentionally preserved.
  const viewOverview = hasPerm("viewOverview") || true;

  const viewUsers = hasPerm("viewUsers", p => p.manageUsers || p.manageRoles);
  const editUsers = hasPerm("editUsers", p => p.manageUsers || p.manageRoles);
  const deleteUsers = hasPerm("deleteUsers", p => p.manageUsers || p.manageRoles);
  let syncUsers = hasPerm("syncUsers", p => p.manageUsers || p.manageRoles);

  const wlGive = hasPerm("wlGive") || true;
  const wlTake = hasPerm("wlTake") || true;
  const voiceSupportToggle = hasPerm("voiceSupportToggle") || editUsers;
  const discordBan = hasPerm("discordBan") || deleteUsers;
  const discordUnban = hasPerm("discordUnban") || editUsers;
  const discordKick = hasPerm("discordKick") || deleteUsers;
  const blacklistAdd = hasPerm("blacklistAdd") || deleteUsers;
  const blacklistRemove = hasPerm("blacklistRemove") || editUsers;
  const removeAllRoles = hasPerm("removeAllRoles") || deleteUsers;
  const dbDeleteUser = hasPerm("dbDeleteUser") || deleteUsers;

  let createDepartment = hasPerm("createDepartment");
  let createTeams = hasPerm("createTeams", p => p.createDepartment || p.manageTeams || p.manageRoles) || createDepartment;
  let editTeams = hasPerm("editTeams", p => p.manageTeams || p.manageRoles);
  let deleteTeams = hasPerm("deleteTeams", p => p.manageTeams || p.manageRoles);
  if (!createDepartment) createDepartment = createTeams;

  let teamAddMember = hasPerm("teamAddMember", p => p.manageTeams) || editTeams || true;
  let teamRemoveMember = hasPerm("teamRemoveMember", p => p.manageTeams) || editTeams || true;
  let teamDiscordBan = hasPerm("teamDiscordBan") || deleteTeams;
  let teamDiscordKick = hasPerm("teamDiscordKick") || deleteTeams;
  let teamBlacklistAdd = hasPerm("teamBlacklistAdd") || deleteTeams;
  const teamBlacklistRemove = hasPerm("teamBlacklistRemove") || editTeams;
  let teamVoiceSupportToggle = hasPerm("teamVoiceSupportToggle") || true;
  let teamSendDm = hasPerm("teamSendDm") || true;
  let teamWlGive = hasPerm("teamWlGive") || true;
  let teamWlTake = hasPerm("teamWlTake") || true;
  let teamGiveRole = hasPerm("teamGiveRole") || true;
  let teamRevive = hasPerm("teamRevive") || true;
  let teamWipe = hasPerm("teamWipe") || deleteTeams;

  let viewTeams = hasPerm("viewTeams", p => p.manageTeams || p.manageRoles) || true;

  const viewPunishments = hasPerm("viewPunishments", p => p.managePunishments || p.manageRoles);
  const applyPunishments = hasPerm("applyPunishments", p => p.managePunishments || p.manageRoles);
  const clearPunishments = hasPerm("clearPunishments", p => p.managePunishments || p.manageRoles);
  const provideInitiative = hasPerm("provideInitiative");

  const unbanUser = hasPerm("unbanUser");
  const banUser = hasPerm("banUser");

  const blacklistUserAdd = hasPerm("blacklistUserAdd");
  const blacklistUserRemove = hasPerm("blacklistUserRemove");

  const reviewApplications = hasPerm("reviewApplications", p => p.manageApplications || p.manageWebsite);
  const editApplications = hasPerm("editApplications", p => p.manageApplications || p.manageWebsite);
  const deleteApplications = hasPerm("deleteApplications", p => p.manageApplications || p.manageWebsite);
  const viewApplications = hasPerm("viewApplications", p => p.manageApplications || p.manageWebsite) || reviewApplications || editApplications || deleteApplications;

  const viewUpdates = hasPerm("viewUpdates", p => p.manageUpdates);
  const createUpdates = hasPerm("createUpdates", p => p.manageUpdates);
  const editUpdates = hasPerm("editUpdates", p => p.manageUpdates);
  const deleteUpdates = hasPerm("deleteUpdates", p => p.manageUpdates);

  const viewDonate = hasPerm("viewDonate", p => p.manageDonate || p.manageWebsite);
  const editDonate = hasPerm("editDonate", p => p.manageDonate || p.manageWebsite);
  const deleteDonate = hasPerm("deleteDonate", p => p.manageDonate || p.manageWebsite);
  const giveCredits = hasPerm("giveCredits", p => p.manageDonate || p.manageWebsite);

  const viewRanks = hasPerm("viewRanks", p => p.manageRanks || p.manageRoles);
  const createRanks = hasPerm("createRanks", p => p.manageRanks || p.manageRoles);
  const editRanks = hasPerm("editRanks", p => p.manageRanks || p.manageRoles);
  const deleteRanks = hasPerm("deleteRanks", p => p.manageRanks || p.manageRoles);

  const viewBots = hasPerm("viewBots", p => p.manageBots);
  const manageBots = hasPerm("manageBots");

  // Website settings are superuser-only.
  const viewWebsite = false;
  const editWebsite = false;

  const viewDeveloper = hasPerm("viewDeveloper", p => p.manageDeveloper || p.manageWebsite);
  const editDeveloper = hasPerm("editDeveloper", p => p.manageDeveloper || p.manageWebsite);
  const fivemBridgeCommands = hasPerm("fivemBridgeCommands");

  let businessCreate = hasPerm("businessCreate") || createTeams;
  let businessDelete = hasPerm("businessDelete") || deleteTeams;
  let businessAddMember = hasPerm("businessAddMember") || teamAddMember;
  let businessRemoveMember = hasPerm("businessRemoveMember") || teamRemoveMember;
  let businessKick = hasPerm("businessKick") || teamDiscordKick;
  let businessBan = hasPerm("businessBan") || teamDiscordBan;
  let businessSendDm = hasPerm("businessSendDm") || teamSendDm;
  let businessWlGive = hasPerm("businessWlGive") || teamWlGive;
  let businessWlTake = hasPerm("businessWlTake") || teamWlTake;
  let businessGiveRole = hasPerm("businessGiveRole") || teamGiveRole;
  let businessRevive = hasPerm("businessRevive") || teamRevive;
  let businessBlacklistAdd = hasPerm("businessBlacklistAdd") || teamBlacklistAdd;
  let businessWipe = hasPerm("businessWipe") || teamWipe;

  let charEditModal = hasPerm("charEditModal") || editUsers || true;
  let charEditName = hasPerm("charEditName") || editUsers || true;
  let charEditBirthdate = hasPerm("charEditBirthdate") || editUsers || true;
  let charEditMoney = hasPerm("charEditMoney") || editUsers || true;
  let charEditJob = hasPerm("charEditJob") || editUsers || true;
  let charClearInventory = hasPerm("charClearInventory") || deleteUsers;
  let charDeleteItem = hasPerm("charDeleteItem") || deleteUsers;

  // Hierarchy by rank name, across ALL applicable ranks.
  const isProjectLeader = applicableRanks.some(r => rankNameMatches(r, PROJECT_LEADER_KEYWORDS));
  const isAdminOrAbove = isProjectLeader || applicableRanks.some(r => rankNameMatches(r, ADMIN_KEYWORDS));

  if (isAdminOrAbove) {
    viewTeams = createTeams = createDepartment = editTeams = deleteTeams = true;
    teamAddMember = teamRemoveMember = teamVoiceSupportToggle = teamSendDm = true;
    teamWlGive = teamWlTake = teamGiveRole = teamRevive = true;
    businessCreate = businessDelete = businessAddMember = businessRemoveMember = businessSendDm = true;
    businessWlGive = businessWlTake = businessGiveRole = businessRevive = true;
    charEditModal = charEditName = charEditBirthdate = charEditMoney = charEditJob = true;
  }

  if (isProjectLeader) {
    syncUsers = true;
    teamWipe = teamDiscordBan = teamDiscordKick = teamBlacklistAdd = true;
    businessKick = businessBan = businessBlacklistAdd = businessWipe = true;
    charClearInventory = charDeleteItem = true;
  }

  const effectiveRank = applicableRanks[0];
  return {
    isSuperuser: false,
    isProjectLeader: !!isProjectLeader,
    rankName: effectiveRank.name,
    rankColor: effectiveRank.color,
    allRanks: applicableRanks.map(r => ({ id: r._id, name: r.name, color: r.color, discordRoleId: r.discordRoleId })),
    viewOverview,
    viewUsers, editUsers, deleteUsers, syncUsers,
    wlGive, wlTake, voiceSupportToggle, discordBan, discordUnban, discordKick, blacklistAdd, blacklistRemove, removeAllRoles, dbDeleteUser,
    viewTeams, createTeams, createDepartment, editTeams, deleteTeams,
    teamAddMember, teamRemoveMember, teamDiscordBan, teamDiscordKick, teamSendDm, teamWlGive, teamWlTake, teamGiveRole, teamRevive, teamBlacklistAdd, teamBlacklistRemove, teamWipe, teamVoiceSupportToggle,
    businessCreate, businessDelete, businessAddMember, businessRemoveMember, businessKick, businessBan, businessSendDm, businessWlGive, businessWlTake, businessGiveRole, businessRevive, businessBlacklistAdd, businessWipe,
    charEditModal, charEditName, charEditBirthdate, charEditMoney, charEditJob, charClearInventory, charDeleteItem,
    viewPunishments, applyPunishments, clearPunishments, provideInitiative,
    unbanUser, banUser,
    blacklistUserAdd, blacklistUserRemove,
    viewApplications, editApplications, deleteApplications, reviewApplications,
    viewUpdates, createUpdates, editUpdates, deleteUpdates,
    viewDonate, editDonate, deleteDonate, giveCredits,
    viewRanks, createRanks, editRanks, deleteRanks,
    viewBots, manageBots,
    viewWebsite, editWebsite,
    viewDeveloper, editDeveloper,
    fivemBridgeCommands,
    manageUsers: editUsers || deleteUsers || syncUsers,
    manageTeams: createTeams || editTeams || deleteTeams,
    managePunishments: applyPunishments || clearPunishments,
    manageApplications: editApplications || deleteApplications || reviewApplications,
    manageUpdates: createUpdates || editUpdates || deleteUpdates,
    manageDonate: editDonate || deleteDonate || giveCredits,
    manageRanks: createRanks || editRanks || deleteRanks,
    manageWebsite: editWebsite,
    manageDeveloper: editDeveloper
  };
}

// Effective permission set for a logged-in session user (null when not logged in). Cached per user for 60s.
async function getUserPermissions(userSession) {
  if (!userSession) return null;

  const cacheKey = userSession.id;
  const cached = permissionsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < PERMISSION_CACHE_TTL_MS) {
    return cached.perms;
  }

  let perms;
  if (userSession.isSuperuser || config.isSuperuser(userSession.id)) {
    perms = SUPERUSER_PERMS;
  } else {
    const { ranks, liveUsername, liveAvatarUrl } = await collectApplicableRanks(userSession);
    if (ranks.length === 0) {
      perms = NO_PERMS;
    } else {
      // Lowest order number = highest rank (order 1 is typically the project leader).
      ranks.sort((a, b) => (a.order !== undefined ? a.order : DEFAULT_RANK_ORDER) - (b.order !== undefined ? b.order : DEFAULT_RANK_ORDER));
      const effectiveRank = ranks[0];

      // Keep stored records in line with the user's highest live rank.
      UserRank.findOneAndUpdate({ discordId: userSession.id }, { username: liveUsername, rankId: effectiveRank._id }, { upsert: true }).catch(() => {});
      DiscordUser.findOneAndUpdate(
        { discordId: userSession.id },
        { username: liveUsername, avatarUrl: liveAvatarUrl, rankId: effectiveRank._id },
        { upsert: true }
      ).catch(() => {});

      perms = computeRankPermissions(ranks);
    }
  }

  permissionsCache.set(cacheKey, { perms, ts: Date.now() });
  return perms;
}

module.exports = { ALL_RANK_PERM_KEYS, getUserPermissions, hasAnyPermission };
