const express = require("express");
const {
  UpdateNote, ServerStats, GalleryImage, Rank, UserRank, DiscordUser, Streamer, FAQItem,
  DonateItem, DonatePurchase, FivemCharacter, SiteModule
} = require("../models/ServerInfo");
const { checkModule } = require("../middleware/siteContext");
const { getUserPermissions } = require("../services/permissions");
const { invalidateUserCredits } = require("../services/siteCache");
const { getAllGuildMembers, getGuildMembersWithRole, getDiscordAvatarUrl, fetchDiscordUserInfo } = require("../services/discordApi");
const streamerFetcher = require("../utils/streamerFetcher");
const { searchRegex } = require("../utils/http");
const { bridgeStatus } = require("../services/fivemState");
const { renderMarkdown } = require("../utils/markdown");
const { rateLimit } = require("../middleware/rateLimit");

const router = express.Router();

const CHARACTER_LIST_LIMIT = 36;
const STREAMER_RESYNC_AFTER_MS = 90000;

function renderStatic(view) {
  return (req, res) => res.render(view, { user: req.session.user || null });
}

router.get("/", async (req, res) => {
  try {
    const updates = (await UpdateNote.find().sort({ date: -1 })).map(upd => {
      const obj = upd.toObject();
      obj.description = renderMarkdown(obj.description);
      return obj;
    });
    res.render("index", { updates, user: req.session.user || null });
  } catch (error) {
    console.error("Home page error:", error);
    res.status(500).send("Internal Server Error");
  }
});

// Live numbers: players come from the FiveM bridge (null while the game server is offline or unknown),
// the whitelist count from the database (null when it has never been counted).
async function publicStats() {
  const bridge = bridgeStatus();
  const stored = await ServerStats.findOne({}, { totalWhitelist: 1 }).lean();
  return {
    serverOnline: bridge.online,
    activePlayers: bridge.playersCount,
    maxPlayers: bridge.maxPlayers,
    totalWhitelist: stored && typeof stored.totalWhitelist === "number" ? stored.totalWhitelist : null,
    lastPollAt: bridge.lastPollAt
  };
}

router.get("/stats", checkModule("stats"), async (req, res) => {
  try {
    const stats = await publicStats();
    res.render("stats", { stats, user: req.session.user || null });
  } catch (error) {
    console.error("Stats page error:", error);
    res.status(500).send("Internal Server Error");
  }
});

router.get("/api/stats", checkModule("stats"), async (req, res) => {
  try {
    res.json({ success: true, ...(await publicStats()) });
  } catch (error) {
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

router.get("/gallery", checkModule("gallery"), async (req, res) => {
  try {
    const gallery = await GalleryImage.find().sort({ order: 1 });
    res.render("gallery", { gallery, user: req.session.user || null });
  } catch (error) {
    console.error("Gallery page error:", error);
    res.status(500).send("Internal Server Error");
  }
});

// Members of a rank, syncing them from the rank's Discord role when none are stored yet.
async function rankMembers(rank) {
  let members = await UserRank.find({ rankId: rank._id });
  const roleId = rank.discordRoleId && rank.discordRoleId.trim();
  if (members.length > 0 || !roleId) return members;

  const syncedMembers = await getGuildMembersWithRole(roleId, false).catch(() => []);
  if (!syncedMembers || syncedMembers.length === 0) return members;

  for (const sm of syncedMembers) {
    await UserRank.findOneAndUpdate({ discordId: sm.id }, { username: sm.username, rankId: rank._id }, { upsert: true, new: true });
    await DiscordUser.findOneAndUpdate(
      { discordId: sm.id },
      { username: sm.username, avatarUrl: sm.avatarUrl, rankId: rank._id },
      { upsert: true, new: true }
    );
  }
  return UserRank.find({ rankId: rank._id });
}

async function describeStaffMember(member, rank, discordUser, guildMember) {
  let avatarUrl = "";
  let username = member.username;

  if (guildMember) {
    avatarUrl = getDiscordAvatarUrl(guildMember);
    if (guildMember.user && guildMember.user.username) {
      username = guildMember.nick || guildMember.user.global_name || guildMember.user.username;
    }
  } else if (discordUser && discordUser.avatarUrl && discordUser.avatarUrl.trim()) {
    avatarUrl = discordUser.avatarUrl.trim();
  } else {
    const fetched = await fetchDiscordUserInfo(member.discordId);
    if (fetched && fetched.avatarUrl) {
      avatarUrl = fetched.avatarUrl;
      if (fetched.username && !fetched.username.startsWith("Kullanıcı (")) {
        username = fetched.username;
      }
    }
  }

  if (!avatarUrl || avatarUrl.includes("/embed/avatars/0.png")) {
    avatarUrl = getDiscordAvatarUrl({ discordId: member.discordId });
  }

  if (!discordUser || discordUser.avatarUrl !== avatarUrl || discordUser.username !== username) {
    DiscordUser.findOneAndUpdate(
      { discordId: member.discordId },
      { username, avatarUrl, rankId: rank._id },
      { upsert: true, new: true }
    ).catch(() => {});
  }

  return { username, discordId: member.discordId, avatarUrl, description: (discordUser && discordUser.description) || "" };
}

router.get("/team", checkModule("team"), async (req, res) => {
  try {
    const ranks = await Rank.find().sort({ order: 1 });
    const allGuildMembers = await getAllGuildMembers().catch(() => []);
    const guildMembersById = new Map((allGuildMembers || []).filter(m => m && m.user && m.user.id).map(m => [m.user.id, m]));

    const groupedStaff = [];
    for (const rank of ranks) {
      const members = await rankMembers(rank);
      if (members.length === 0) continue;

      const discordUsers = await DiscordUser.find({ discordId: { $in: members.map(m => m.discordId) } });
      const discordUsersById = new Map(discordUsers.map(du => [du.discordId, du]));

      const staff = await Promise.all(members.map(member =>
        describeStaffMember(member, rank, discordUsersById.get(member.discordId), guildMembersById.get(member.discordId))
      ));
      staff.sort((a, b) => a.username.localeCompare(b.username));
      groupedStaff.push({ rankName: rank.name, rankColor: rank.color, members: staff });
    }

    res.render("team", {
      groupedStaff,
      user: req.session.user || null,
      userPermissions: await getUserPermissions(req.session.user)
    });
  } catch (error) {
    console.error("Team page error:", error);
    res.status(500).send("Internal Server Error");
  }
});

router.post("/team/update-description", async (req, res) => {
  const perms = await getUserPermissions(req.session.user);
  if (!perms || (!perms.isSuperuser && !perms.isProjectLeader && !perms.editUsers)) {
    return res.status(403).json({ error: "Yetkiniz yok." });
  }
  try {
    const { discordId, description } = req.body;
    if (!discordId) {
      return res.status(400).json({ error: "Kullanıcı ID'si eksik." });
    }
    await DiscordUser.findOneAndUpdate({ discordId: String(discordId).trim() }, { description: String(description || "").trim() });
    res.json({ success: true });
  } catch (error) {
    console.error("Update team description error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/streamers", async (req, res) => {
  try {
    const streamers = await Streamer.find().sort({ isLive: -1, order: 1, createdAt: -1 });
    res.render("streamers", {
      streamers,
      user: req.session.user || null,
      userPermissions: await getUserPermissions(req.session.user)
    });

    // Refresh live statuses in the background when any streamer was checked too long ago.
    const isStale = streamers.some(s => !s.lastLiveCheckedAt || Date.now() - new Date(s.lastLiveCheckedAt).getTime() > STREAMER_RESYNC_AFTER_MS);
    if (streamers.length === 0 || isStale) {
      streamerFetcher.syncAllStreamers(Streamer).catch(() => {});
    }
  } catch (error) {
    console.error("Streamers page error:", error);
    res.status(500).send("Internal Server Error");
  }
});

router.get("/rules", checkModule("rules"), renderStatic("rules"));
router.get("/legal-rules", checkModule("rules"), renderStatic("legal-rules"));
router.get("/penalties", checkModule("penalties"), renderStatic("penalties"));
router.get("/terms", renderStatic("terms"));
router.get("/privacy-and-policy", renderStatic("privacy"));
router.get("/uikit", renderStatic("uikit"));

router.get("/faq", checkModule("faq"), async (req, res) => {
  try {
    const faqs = await FAQItem.find().sort({ order: 1 });
    res.render("faq", { faqs, user: req.session.user || null });
  } catch (error) {
    console.error("FAQ page error:", error);
    res.status(500).send("Internal Server Error");
  }
});

router.get("/donate", checkModule("donate"), async (req, res) => {
  try {
    const items = await DonateItem.find().sort({ order: 1 });
    let userCredits = 0;
    let purchases = [];

    if (req.session.user) {
      const userRank = await UserRank.findOne({ discordId: req.session.user.id });
      userCredits = userRank ? userRank.credits || 0 : 0;
      purchases = await DonatePurchase.find({ discordId: req.session.user.id }).populate("itemId").sort({ date: -1 });
    }

    res.render("donate", { items, user: req.session.user || null, userCredits, purchases });
  } catch (error) {
    console.error("Donate page error:", error);
    res.status(500).send("Internal Server Error");
  }
});

router.post("/donate/buy/:id", checkModule("donate"), rateLimit({ name: "donate", windowMs: 60 * 1000, max: 10 }), async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ success: false, message: "Lütfen önce giriş yapın." });
  }
  try {
    const item = await DonateItem.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: "Ürün bulunamadı." });
    }

    // Atomic check-and-debit so concurrent purchases cannot overspend the balance.
    const userRank = await UserRank.findOneAndUpdate(
      { discordId: req.session.user.id, credits: { $gte: item.price } },
      { $inc: { credits: -item.price } },
      { new: true }
    );
    if (!userRank) {
      return res.status(400).json({ success: false, message: "Yetersiz bakiye. Lütfen kredi yükleyin." });
    }
    invalidateUserCredits(req.session.user.id);

    await new DonatePurchase({
      discordId: req.session.user.id,
      username: req.session.user.username,
      itemId: item._id,
      pricePaid: item.price
    }).save();

    res.json({ success: true, newBalance: userRank.credits, message: `${item.name} başarıyla satın alındı! İyi günlerde kullanın.` });
  } catch (error) {
    console.error("Buy item error:", error);
    res.status(500).json({ success: false, message: "Satın alma işlemi sırasında bir hata oluştu." });
  }
});

router.get("/characters", async (req, res) => {
  const viewData = { user: req.session.user || null, myCharacters: [], allCharacters: [], pageTitle: "Karakter Listesi" };
  try {
    if (req.session.user) {
      viewData.myCharacters = await FivemCharacter.find({ discordId: req.session.user.id }).sort({ cid: 1 }).lean();
    }
    viewData.allCharacters = await FivemCharacter.find({}).sort({ lastUpdated: -1 }).limit(CHARACTER_LIST_LIMIT).lean();
  } catch (error) {
    console.error("Characters page error:", error);
  }
  res.render("characters", viewData);
});

router.get("/api/characters/search", async (req, res) => {
  try {
    const search = String(req.query.q || "").trim();
    const query = search
      ? { $or: ["firstname", "lastname", "citizenid", "job.label", "job.name"].map(field => ({ [field]: searchRegex(search) })) }
      : {};
    const characters = await FivemCharacter.find(query).sort({ lastUpdated: -1 }).limit(CHARACTER_LIST_LIMIT).lean();
    res.json({ success: true, characters });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/maintenance", async (req, res) => {
  if (res.locals.modules && !res.locals.modules.maintenance) {
    return res.redirect("/");
  }
  try {
    const maintenanceModule = await SiteModule.findOne({ key: "maintenance" });
    res.render("maintenance", { customMessage: maintenanceModule ? maintenanceModule.customMessage : "" });
  } catch (error) {
    res.render("maintenance", { customMessage: "" });
  }
});

module.exports = router;
