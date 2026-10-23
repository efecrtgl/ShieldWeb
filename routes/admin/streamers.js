const express = require("express");
const { Streamer } = require("../../models/ServerInfo");
const { getUserPermissions } = require("../../services/permissions");
const { actorFrom, logAction } = require("../../services/auditLog");
const streamerFetcher = require("../../utils/streamerFetcher");
const { FALLBACK_AVATAR } = require("../../utils/discordAvatar");

const router = express.Router();

router.use("/admin/streamers", async (req, res, next) => {
  const perms = await getUserPermissions(req.session.user);
  if (!perms || (!perms.isSuperuser && !perms.isProjectLeader && !perms.manageWebsite && !perms.editWebsite)) {
    return res.status(403).json({ success: false, message: "Yetkiniz yok." });
  }
  next();
});

function streamerFields(body) {
  const text = value => String(value || "").trim();
  return {
    name: text(body.name),
    characterName: text(body.characterName),
    avatarUrl: text(body.avatarUrl),
    bannerUrl: text(body.bannerUrl),
    bio: text(body.bio),
    kickUrl: text(body.kickUrl),
    twitchUrl: text(body.twitchUrl),
    isLive: !!body.isLive,
    tags: Array.isArray(body.tags) ? body.tags : []
  };
}

router.post("/admin/streamers/fetch-info", async (req, res) => {
  try {
    const query = String(req.body.query || "").trim();
    if (!query) {
      return res.status(400).json({ success: false, message: "Lütfen bir kullanıcı adı veya profil linki girin." });
    }
    const data = await streamerFetcher.fetchStreamerAuto(query, req.body.platform || "auto");
    res.json({ success: true, data });
  } catch (error) {
    console.error("Fetch streamer info error:", error);
    res.status(400).json({ success: false, message: error.message || "Yayıncı bilgileri çekilemedi." });
  }
});

router.post("/admin/streamers/sync-live", async (req, res) => {
  try {
    const result = await streamerFetcher.syncAllStreamers(Streamer);
    res.json({
      success: true,
      message: `Canlı yayın durumları güncellendi. (${result.liveCount || 0} yayıncı şu an canlıda)`,
      data: result
    });
  } catch (error) {
    console.error("Sync streamers live error:", error);
    res.status(500).json({ success: false, message: "Güncelleme hatası: " + error.message });
  }
});

router.post("/admin/streamers/add", async (req, res) => {
  try {
    const fields = streamerFields(req.body);
    if (!fields.name) {
      return res.status(400).json({ success: false, message: "Yayıncı adı zorunludur." });
    }
    const streamer = new Streamer({ ...fields, avatarUrl: fields.avatarUrl || FALLBACK_AVATAR });

    try {
      const liveInfo = await streamerFetcher.checkStreamerLiveStatus(streamer);
      Object.assign(streamer, {
        isLive: liveInfo.isLive,
        livePlatform: liveInfo.livePlatform,
        streamTitle: liveInfo.streamTitle,
        viewerCount: liveInfo.viewerCount,
        lastLiveCheckedAt: new Date()
      });
    } catch (err) {
      console.warn("Initial streamer live check failed:", err.message);
    }

    await streamer.save();
    logAction("streamerAdd", {
      executor: actorFrom(req),
      target: { id: streamer._id.toString(), username: streamer.name },
      details: `Yeni yayıncı eklendi: ${streamer.name}`,
      context: "Web Panel"
    });
    res.json({ success: true, message: "Yayıncı başarıyla eklendi." });
  } catch (error) {
    console.error("Add streamer error:", error);
    res.status(500).json({ success: false, message: "Yayıncı eklenirken hata oluştu: " + error.message });
  }
});

router.post("/admin/streamers/update/:id", async (req, res) => {
  try {
    await Streamer.findByIdAndUpdate(req.params.id, streamerFields(req.body));
    res.json({ success: true, message: "Yayıncı güncellendi." });
  } catch (error) {
    console.error("Update streamer error:", error);
    res.status(500).json({ success: false, message: "Güncellenirken hata oluştu: " + error.message });
  }
});

router.post("/admin/streamers/delete/:id", async (req, res) => {
  try {
    await Streamer.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Yayıncı silindi." });
  } catch (error) {
    console.error("Delete streamer error:", error);
    res.status(500).json({ success: false, message: "Silinirken hata oluştu: " + error.message });
  }
});

router.post("/admin/streamers/toggle-live/:id", async (req, res) => {
  try {
    const streamer = await Streamer.findById(req.params.id);
    if (!streamer) return res.status(404).json({ success: false, message: "Yayıncı bulunamadı." });
    streamer.isLive = typeof req.body.isLive !== "undefined" ? req.body.isLive : !streamer.isLive;
    await streamer.save();
    res.json({ success: true, isLive: streamer.isLive });
  } catch (error) {
    console.error("Toggle streamer live error:", error);
    res.status(500).json({ success: false, message: "Hata oluştu: " + error.message });
  }
});

module.exports = router;
