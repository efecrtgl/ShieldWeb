const express = require("express");
const os = require("os");
const {
  UpdateNote, Rank, UserRank, FAQItem, GalleryImage, DiscordBot, Application, ApplicationSubmission, DonateItem,
  DonatePurchase, SiteModule, Team, DiscordUser, Business, PunishmentRecord, Streamer
} = require("../../models/ServerInfo");
const { getUserPermissions, hasAnyPermission } = require("../../services/permissions");
const { getCachedServerStats } = require("../../services/siteCache");
const { fetchDiscordLiveStats } = require("../../services/discordStats");
const { onlineDiscordIds } = require("../../services/fivemState");
const { systems } = require("../../services/systemLog");
const { isSnowflake } = require("../../utils/http");

const router = express.Router();

const DEFAULT_STATS = { activePlayers: 0, maxPlayers: 64, totalWhitelist: 0 };
const RECENT_LIST_LIMIT = 100;
const RECENT_PUNISHMENTS_LIMIT = 50;

function bossIdsOf(group) {
  if (!group.bossId || !group.bossId.trim() || group.bossId.trim() === "none") return [];
  return group.bossId.split(/[\s,]+/).map(s => s.trim()).filter(isSnowflake);
}

function hasBoss(group) {
  return !!(group.bossId && group.bossId.trim() && group.bossId.trim() !== "none");
}

// Adds memberCount/onlineCount to each team or business. Bosses count as members when they have a user record.
function withMemberCounts(groups, memberDocs, groupField, knownDiscordIds, onlineIds) {
  const membersByGroup = new Map(groups.map(g => [g._id.toString(), new Set()]));
  for (const doc of memberDocs) {
    const set = doc[groupField] && membersByGroup.get(doc[groupField].toString());
    if (set) set.add(doc.discordId);
  }
  return groups.map(group => {
    const members = membersByGroup.get(group._id.toString());
    bossIdsOf(group).filter(id => knownDiscordIds.has(id)).forEach(id => members.add(id));
    const onlineCount = [...members].filter(id => onlineIds.has(id)).length;
    return { ...group, memberCount: members.size, onlineCount };
  });
}

function countMembersOf(groups, memberDocs, groupField) {
  const ids = new Set(groups.map(g => g._id.toString()));
  return memberDocs.filter(u => u[groupField] && ids.has(u[groupField].toString())).length;
}

function systemMetrics() {
  const uptimeMin = Math.round(process.uptime() / 60);
  const uptimeHour = Math.round(uptimeMin / 60);
  return {
    cpuCount: os.cpus().length,
    osType: os.type(),
    memUsageMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    uptimeString: uptimeHour > 0 ? `${uptimeHour} saat ${uptimeMin % 60} d.` : `${uptimeMin} dakika`
  };
}

router.get("/admin", (req, res) => {
  res.redirect("/admin/dashboard");
});

router.get("/admin/dashboard", async (req, res) => {
  if (!req.session.user) {
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  const perms = await getUserPermissions(req.session.user);
  if (perms && perms.isSuperuser) {
    req.session.user.isSuperuser = true;
  }
  if (!hasAnyPermission(perms)) {
    return res.status(403).send("Forbidden");
  }
  try {
    const [
      statsRaw, updates, ranks, usersRaw, faqs, gallery, bots, applications, submissions, donateItems,
      donatePurchases, siteModules, teamsRaw, allTeamUsers, businessesRaw, allBusinessUsers, recentPunishments,
      userManagementStats, streamers
    ] = await Promise.all([
      getCachedServerStats(),
      UpdateNote.find().sort({ date: -1 }).lean(),
      Rank.find().sort({ order: 1 }).lean(),
      UserRank.find().populate("rankId").lean(),
      FAQItem.find().sort({ order: 1 }).lean(),
      GalleryImage.find().sort({ order: 1 }).lean(),
      DiscordBot.find().lean(),
      Application.find({ isDeleted: { $ne: true } }).sort({ order: 1, date: -1 }).lean(),
      ApplicationSubmission.find({ isDeleted: { $ne: true } }).populate("applicationId").sort({ date: -1 }).limit(RECENT_LIST_LIMIT).lean(),
      DonateItem.find().sort({ order: 1 }).lean(),
      DonatePurchase.find().populate("itemId").sort({ date: -1 }).limit(RECENT_LIST_LIMIT).lean(),
      SiteModule.find().sort({ key: 1 }).lean(),
      Team.find().sort({ createdAt: -1 }).lean(),
      DiscordUser.find({}, { discordId: 1, teamId: 1 }).lean(),
      Business.find().sort({ createdAt: -1 }).lean(),
      DiscordUser.find({ businessId: { $ne: null } }, { discordId: 1, businessId: 1 }).lean(),
      PunishmentRecord.find().sort({ date: -1 }).limit(RECENT_PUNISHMENTS_LIMIT).lean(),
      fetchDiscordLiveStats(),
      Streamer.find().sort({ order: 1, isLive: -1, createdAt: -1 }).lean()
    ]);

    let users = usersRaw;
    if (!users || users.length === 0) {
      users = await DiscordUser.find({ rankId: { $ne: null } }).populate("rankId").sort({ username: 1 }).lean();
    }

    const onlineIds = onlineDiscordIds();
    const knownDiscordIds = new Set(allTeamUsers.map(u => u.discordId));
    const teams = withMemberCounts(teamsRaw, allTeamUsers, "teamId", knownDiscordIds, onlineIds);
    const businesses = withMemberCounts(businessesRaw, allBusinessUsers, "businessId", knownDiscordIds, onlineIds);

    const illegalTeams = teams.filter(t => t.type === "illegal");
    const legalTeams = teams.filter(t => t.type === "legal");

    res.render("admin", {
      stats: statsRaw || DEFAULT_STATS,
      updates,
      systems,
      user: req.session.user,
      userPermissions: perms,
      ranks,
      users,
      faqs,
      gallery,
      bots,
      applications,
      submissions,
      donateItems,
      donatePurchases,
      siteModules,
      // Users are loaded client-side through the paginated /admin/api/users endpoint.
      discordUsers: [],
      userManagementStats,
      teams,
      businesses,
      streamers,
      teamStats: {
        illegal: {
          totalTeams: illegalTeams.length,
          totalMembers: countMembersOf(illegalTeams, allTeamUsers, "teamId"),
          totalOGs: illegalTeams.filter(hasBoss).length
        },
        legal: {
          totalTeams: legalTeams.length,
          totalMembers: countMembersOf(legalTeams, allTeamUsers, "teamId"),
          totalHCs: legalTeams.reduce((sum, t) => sum + bossIdsOf(t).length, 0)
        },
        business: {
          totalTeams: businesses.length,
          totalMembers: allBusinessUsers.length,
          totalBosses: businesses.filter(hasBoss).length
        }
      },
      recentPunishments,
      systemMetrics: systemMetrics()
    });
  } catch (error) {
    console.error("Admin dashboard render error:", error);
    res.status(500).send("Internal Server Error");
  }
});

module.exports = router;
