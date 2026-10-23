const express = require("express");
const { Rank, UserRank, DiscordUser } = require("../../models/ServerInfo");
const { getUserPermissions, ALL_RANK_PERM_KEYS } = require("../../services/permissions");
const { actorFrom, logAction } = require("../../services/auditLog");
const { getAllGuildMembers, getGuildMembersWithRole, membersWithRole } = require("../../services/discordApi");
const { wantsJson } = require("../../utils/http");

const router = express.Router();

const RANKS_TAB = "/admin/dashboard#ranks";
// Bulk edits may only touch permission fields defined on the Rank schema.
const KNOWN_PERM_KEYS = new Set(Object.keys(Rank.schema.paths).filter(p => p.startsWith("permissions.")).map(p => p.slice("permissions.".length)));

function isChecked(value) {
  return value === "true" || value === "on";
}

function permissionsFromForm(body) {
  return Object.fromEntries(ALL_RANK_PERM_KEYS.map(key => [key, isChecked(body[key])]));
}

function allow(flags, { json = false } = {}) {
  return async (req, res, next) => {
    const perms = await getUserPermissions(req.session.user);
    if (!perms || (!perms.isSuperuser && !flags.some(flag => perms[flag]))) {
      if (json) return res.status(403).json({ error: "Forbidden" });
      if (wantsJson(req)) return res.status(403).json({ success: false, message: "Yetersiz yetki." });
      return res.status(403).send("Forbidden");
    }
    next();
  };
}

// Gives every listed guild member the rank in both UserRank and DiscordUser.
async function assignRankToMembers(rank, members) {
  if (!members || members.length === 0) return;
  await UserRank.bulkWrite(members.map(m => ({
    updateOne: { filter: { discordId: m.id }, update: { username: m.username, rankId: rank._id }, upsert: true }
  })));
  await DiscordUser.bulkWrite(members.map(m => ({
    updateOne: { filter: { discordId: m.id }, update: { username: m.username, avatarUrl: m.avatarUrl, rankId: rank._id }, upsert: true }
  })));
}

// Makes the rank's holders exactly the given members (everyone else loses it).
async function replaceRankHolders(rank, members) {
  const memberIds = (members || []).map(m => m.id);
  await UserRank.updateMany({ rankId: rank._id, discordId: { $nin: memberIds } }, { rankId: null });
  await DiscordUser.updateMany({ rankId: rank._id, discordId: { $nin: memberIds } }, { rankId: null });
  await assignRankToMembers(rank, members);
}

router.post("/admin/ranks/add", allow(["createRanks", "editRanks"]), async (req, res) => {
  try {
    const { name, color } = req.body;
    const discordRoleId = String(req.body.discordRoleId || "").trim();
    const rank = await new Rank({
      name,
      color,
      discordRoleId,
      order: await Rank.countDocuments(),
      permissions: permissionsFromForm(req.body)
    }).save();

    if (discordRoleId) {
      await assignRankToMembers(rank, await getGuildMembersWithRole(discordRoleId, true));
    }

    logAction("rankCreate", {
      executor: actorFrom(req),
      target: { id: rank._id.toString(), username: rank.name, data: rank },
      details: `Yeni rütbe oluşturuldu: ${rank.name} (Renk: ${rank.color})`,
      context: "Web Panel"
    });
    res.redirect(RANKS_TAB);
  } catch (error) {
    console.error("Rank create error:", error);
    res.status(500).send("Internal Server Error");
  }
});

router.post("/admin/ranks/update/:id", allow(["editRanks", "createRanks"]), async (req, res) => {
  try {
    const rank = await Rank.findById(req.params.id);
    if (!rank) {
      return res.status(404).send("Rütbe bulunamadı.");
    }
    const discordRoleId = String(req.body.discordRoleId || "").trim();
    rank.name = req.body.name;
    rank.color = req.body.color;
    rank.discordRoleId = discordRoleId;
    rank.order = parseInt(req.body.order, 10) || 0;
    rank.permissions = permissionsFromForm(req.body);
    rank.markModified("permissions");
    await rank.save();

    if (discordRoleId) {
      await replaceRankHolders(rank, await getGuildMembersWithRole(discordRoleId, true));
    }

    logAction("rankEdit", {
      executor: actorFrom(req),
      target: { id: req.params.id, username: rank.name, data: rank },
      details: `Rütbe güncellendi: ${rank.name}`,
      context: "Web Panel"
    });

    if (wantsJson(req)) {
      return res.json({ success: true, message: "Rütbe izinleri başarıyla güncellendi." });
    }
    res.redirect(RANKS_TAB);
  } catch (error) {
    console.error("Rank update error:", error);
    if (wantsJson(req)) {
      return res.status(500).json({ success: false, message: "Sunucu hatası oluştu." });
    }
    res.status(500).send("Internal Server Error");
  }
});

router.post("/admin/ranks/sync-all", allow(["editRanks", "viewRanks"], { json: true }), async (req, res) => {
  try {
    const ranks = await Rank.find({ discordRoleId: { $ne: "" } });
    if (ranks.length === 0) {
      return res.status(400).json({ error: "Eşitlenebilecek Discord Rolü olan rütbe bulunamadı." });
    }
    const allMembers = await getAllGuildMembers();
    if (allMembers.length === 0) {
      return res.status(400).json({ error: "Discord sunucusundan üyeler çekilemedi. Lütfen bot yetkilerini ve intents ayarlarını kontrol edin." });
    }

    let totalSyncedMembers = 0;
    let syncedRanksCount = 0;
    for (const rank of ranks) {
      const roleId = (rank.discordRoleId || "").trim();
      if (!roleId) continue;
      const members = membersWithRole(allMembers, roleId);
      await replaceRankHolders(rank, members);
      totalSyncedMembers += members.length;
      syncedRanksCount++;
    }

    logAction("rankSyncAll", {
      executor: actorFrom(req),
      details: `Tüm rütbeler Discord ile senkronize edildi (Senkronize Edilen Rütbe: ${syncedRanksCount}, Toplam Üye: ${totalSyncedMembers})`,
      context: "Web Panel"
    });
    res.json({ success: true, ranksCount: syncedRanksCount, membersCount: totalSyncedMembers });
  } catch (error) {
    console.error("Sync all ranks error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/admin/ranks/sync/:id", allow(["editRanks", "viewRanks"], { json: true }), async (req, res) => {
  try {
    const rank = await Rank.findById(req.params.id);
    if (!rank) {
      return res.status(404).json({ error: "Rütbe bulunamadı." });
    }
    const roleId = (rank.discordRoleId || "").trim();
    if (!roleId) {
      return res.status(400).json({ error: "Bu rütbeye atanmış bir Discord Rol ID'si yok." });
    }

    const members = await getGuildMembersWithRole(roleId, true);
    await replaceRankHolders(rank, members);

    logAction("rankSync", {
      executor: actorFrom(req),
      target: { id: rank._id.toString(), username: rank.name, data: rank },
      details: `Rütbe üyeleri Discord ile manuel senkronize edildi: ${rank.name} (Üye Sayısı: ${members.length})`,
      context: "Web Panel"
    });
    res.json({ success: true, count: members.length });
  } catch (error) {
    console.error("Rank sync error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/admin/ranks/delete/:id", allow(["deleteRanks", "editRanks"]), async (req, res) => {
  try {
    const rank = await Rank.findById(req.params.id);
    logAction("rankDelete", {
      executor: actorFrom(req),
      target: { id: req.params.id, username: rank ? rank.name : "Bilinmeyen Rütbe", data: rank },
      details: `Rütbe silindi: ${rank ? rank.name : req.params.id}`,
      context: "Web Panel"
    });
    await Rank.findByIdAndDelete(req.params.id);
    await UserRank.updateMany({ rankId: req.params.id }, { rankId: null });
    await DiscordUser.updateMany({ rankId: req.params.id }, { rankId: null });
    res.redirect(RANKS_TAB);
  } catch (error) {
    console.error("Rank delete error:", error);
    res.status(500).send("Internal Server Error");
  }
});

router.post("/admin/ranks/copy", allow(["createRanks", "editRanks"]), async (req, res) => {
  try {
    const sourceRank = await Rank.findById(req.body.sourceRankId);
    if (!sourceRank) {
      return res.status(404).send("Source rank not found");
    }
    const newRank = await new Rank({
      name: req.body.name || `${sourceRank.name} (Kopya)`,
      color: sourceRank.color,
      discordRoleId: "",
      order: await Rank.countDocuments(),
      permissions: sourceRank.permissions
    }).save();

    logAction("rankCreate", {
      executor: actorFrom(req),
      target: { id: newRank._id, username: newRank.name, data: newRank },
      details: `Rütbe kopyalandı. Kaynak: ${sourceRank.name} -> Hedef: ${newRank.name}`,
      context: "Web Panel"
    });
    res.redirect(RANKS_TAB);
  } catch (error) {
    console.error("Copy rank error:", error);
    res.status(500).send("Internal Server Error");
  }
});

function asArray(value) {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

router.post("/admin/ranks/bulk-permissions", allow(["editRanks", "createRanks"]), async (req, res) => {
  const isJson = wantsJson(req);
  try {
    const { actionType } = req.body;
    const selectedPerms = asArray(req.body.permissions).filter(key => KNOWN_PERM_KEYS.has(key));
    const targetRanks = asArray(req.body.targetRanks);

    if (selectedPerms.length === 0) {
      if (isJson) return res.status(400).json({ success: false, message: "Lütfen en az bir izin seçiniz." });
      return res.redirect(RANKS_TAB);
    }
    if (targetRanks.length === 0) {
      if (isJson) return res.status(400).json({ success: false, message: "Lütfen en az bir rütbe seçiniz." });
      return res.redirect(RANKS_TAB);
    }

    const ranks = await Rank.find({ _id: { $in: targetRanks } });
    for (const rank of ranks) {
      const rankPermissions = rank.permissions || {};
      for (const permKey of selectedPerms) {
        if (actionType === "grant") rankPermissions[permKey] = true;
        else if (actionType === "revoke") rankPermissions[permKey] = false;
      }
      rank.permissions = rankPermissions;
      rank.markModified("permissions");
      await rank.save();
    }

    logAction("rankUpdate", {
      executor: actorFrom(req),
      target: { id: "bulk_ranks", username: `Seçili Rütbeler (${ranks.length} adet)`, data: selectedPerms },
      details: `Toplu İzin Güncellemesi. İşlem: ${actionType === "grant" ? "İzinleri Ekle" : "İzinleri Kaldır"}. Güncellenen Rütbe Sayısı: ${ranks.length}. Güncellenen Yetkiler: ${selectedPerms.join(", ")}`,
      context: "Web Panel"
    });

    if (isJson) {
      return res.json({ success: true, message: `Toplu izin güncellemesi başarıyla tamamlandı! ${ranks.length} rütbe güncellendi.` });
    }
    res.redirect(RANKS_TAB);
  } catch (error) {
    console.error("Bulk permissions update error:", error);
    if (isJson) return res.status(500).json({ success: false, message: "Sunucu hatası oluştu." });
    res.status(500).send("Internal Server Error");
  }
});

router.post("/admin/ranks/reorder", allow(["editRanks"]), async (req, res) => {
  try {
    const { ids } = req.body;
    if (Array.isArray(ids)) {
      await Rank.bulkWrite(ids.map((id, index) => ({ updateOne: { filter: { _id: id }, update: { order: index } } })));
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
