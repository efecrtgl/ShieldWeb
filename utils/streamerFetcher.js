const axios = require("axios");
const config = require("../config");
const ServerStats = require("../models/ServerStats");

/**
 * Sends Discord channel announcement when a streamer goes live.
 */
async function sendStreamerLiveAnnouncement(st, status) {
  try {
    let targetChannelId = config.discord.streamerAnnounceChannelId;

    try {
      const statsDoc = await ServerStats.findOne();
      if (statsDoc && statsDoc.streamerAnnounceChannelId && statsDoc.streamerAnnounceChannelId !== "none") {
        targetChannelId = statsDoc.streamerAnnounceChannelId;
      }
    } catch (e) {
      // fallback
    }

    if (!targetChannelId || targetChannelId === "none") return;

    if (!config.hasBotToken("moderation")) return;
    const botToken = config.bots.moderation.token;

    const platformName = status.livePlatform === "kick" ? "Kick" : (status.livePlatform === "twitch" ? "Twitch" : "Canlı Yayın");
    const streamUrl = status.livePlatform === "kick" ? (st.kickUrl || `https://kick.com/${st.name}`) : (st.twitchUrl || `https://twitch.tv/${st.name}`);
    const color = status.livePlatform === "kick" ? 0x53FC18 : (status.livePlatform === "twitch" ? 0x9146FF : 0xA855F7);

    const embed = {
      title: `🔴 ${st.name} Canlı Yayında!`,
      description: `**${st.name}** ${st.characterName ? '(IC: ' + st.characterName + ')' : ''} **${platformName}** platformunda canlı yayın başlattı!`,
      url: streamUrl,
      color: color,
      fields: [
        {
          name: "📺 Yayın Başlığı",
          value: status.streamTitle || "EmpireV Canlı Yayını",
          inline: false
        },
        {
          name: "🎥 Platform",
          value: platformName,
          inline: true
        },
        {
          name: "👥 İzleyici Sayısı",
          value: `${status.viewerCount || 0} kişi`,
          inline: true
        }
      ],
      thumbnail: st.avatarUrl ? { url: st.avatarUrl } : undefined,
      image: st.bannerUrl ? { url: st.bannerUrl } : undefined,
      footer: {
        text: `EmpireV • Yayıncı Bildirim Sistemi`
      },
      timestamp: new Date().toISOString()
    };

    const messagePayload = {
      content: `🎥 **${st.name}** canlı yayın başlattı! Katılmak için tıkla: ${streamUrl}`,
      embeds: [embed]
    };

    await axios.post(`https://discord.com/api/v10/channels/${targetChannelId}/messages`, messagePayload, {
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json"
      }
    });

    console.log(`[Streamer Sync] Live announcement sent to channel ${targetChannelId} for ${st.name}`);
  } catch (err) {
    console.error(`[Streamer Sync] Failed to send live announcement for ${st.name}:`, err.response ? err.response.data : err.message);
  }
}

/**
 * Extracts clean username / slug from URL or username string.
 */
function extractStreamerSlug(input, platform) {
  if (!input) return "";
  input = input.trim();
  try {
    if (input.startsWith("http://") || input.startsWith("https://")) {
      const u = new URL(input);
      const parts = u.pathname.split("/").filter(Boolean);
      return parts[0] || "";
    }
  } catch (e) {}
  return input.replace(/[@/]/g, "").trim();
}

/**
 * Fetch Kick channel details and live status.
 */
async function fetchKickInfo(query) {
  const slug = extractStreamerSlug(query, "kick");
  if (!slug) throw new Error("Geçersiz Kick kullanıcı adı.");

  const res = await fetch(`https://kick.com/api/v1/channels/${encodeURIComponent(slug)}`, {
    headers: {
      "User-Agent": "Mozilla/5.0"
    },
    signal: AbortSignal.timeout(6000)
  });

  if (!res.ok) {
    if (res.status === 404) throw new Error("Kick kanalı bulunamadı.");
    throw new Error(`Kick API hatası (${res.status})`);
  }

  const data = await res.json();
  const isLive = !!data.livestream;

  return {
    platform: "kick",
    name: data.user?.username || slug,
    slug: data.slug || slug,
    url: `https://kick.com/${data.slug || slug}`,
    avatarUrl: data.user?.profile_pic || "",
    bannerUrl: data.banner_image?.url || "",
    bio: data.user?.bio || "",
    isLive: isLive,
    streamTitle: isLive ? (data.livestream?.session_title || "") : "",
    viewerCount: isLive ? (data.livestream?.viewer_count || 0) : 0
  };
}

/**
 * Fetch Twitch channel details and live status using Twitch Public GQL.
 */
async function fetchTwitchInfo(query) {
  const slug = extractStreamerSlug(query, "twitch").toLowerCase();
  if (!slug) throw new Error("Geçersiz Twitch kullanıcı adı.");

  const res = await fetch("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: {
      "Client-ID": "kimne78kx3ncx6brgo4mv6wki5h1ko",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query: `query { user(login: "${slug}") { id displayName profileImageURL(width: 300) bannerImageURL stream { id type title viewersCount } } }`
    }),
    signal: AbortSignal.timeout(6000)
  });

  if (!res.ok) throw new Error(`Twitch API hatası (${res.status})`);
  const data = await res.json();
  const user = data?.data?.user;
  if (!user) throw new Error("Twitch kanalı bulunamadı.");

  const isLive = !!user.stream;

  return {
    platform: "twitch",
    name: user.displayName || slug,
    slug: slug,
    url: `https://twitch.tv/${slug}`,
    avatarUrl: user.profileImageURL || "",
    bannerUrl: user.bannerImageURL || "",
    bio: "",
    isLive: isLive,
    streamTitle: isLive ? (user.stream?.title || "") : "",
    viewerCount: isLive ? (user.stream?.viewersCount || 0) : 0
  };
}

/**
 * Auto-detect and fetch information from Kick or Twitch.
 */
async function fetchStreamerAuto(query, platform = "auto") {
  query = (query || "").trim();
  if (!query) throw new Error("Arama metni girilmedi.");

  if (platform === "kick" || query.toLowerCase().includes("kick.com")) {
    return await fetchKickInfo(query);
  }

  if (platform === "twitch" || query.toLowerCase().includes("twitch.tv")) {
    return await fetchTwitchInfo(query);
  }

  // Try Kick first, then Twitch
  try {
    return await fetchKickInfo(query);
  } catch (errKick) {
    try {
      return await fetchTwitchInfo(query);
    } catch (errTwitch) {
      throw new Error(`Yayıncı bulunamadı (Kick: ${errKick.message} | Twitch: ${errTwitch.message})`);
    }
  }
}

/**
 * Checks live status for a single streamer DB doc.
 */
async function checkStreamerLiveStatus(streamer) {
  let isLive = false;
  let livePlatform = "";
  let streamTitle = "";
  let viewerCount = 0;
  let updatedAvatar = streamer.avatarUrl;
  let updatedBanner = streamer.bannerUrl;

  // 1. Check Kick if kickUrl exists
  if (streamer.kickUrl) {
    try {
      const kickInfo = await fetchKickInfo(streamer.kickUrl);
      if (kickInfo.avatarUrl && (!updatedAvatar || updatedAvatar.includes("discordapp.com/embed/avatars"))) {
        updatedAvatar = kickInfo.avatarUrl;
      }
      if (kickInfo.bannerUrl && !updatedBanner) {
        updatedBanner = kickInfo.bannerUrl;
      }
      if (kickInfo.isLive) {
        isLive = true;
        livePlatform = "kick";
        streamTitle = kickInfo.streamTitle;
        viewerCount = kickInfo.viewerCount;
      }
    } catch (e) {
      // ignore individual check errors
    }
  }

  // 2. Check Twitch if not already marked live or if twitchUrl exists
  if (streamer.twitchUrl && !isLive) {
    try {
      const twitchInfo = await fetchTwitchInfo(streamer.twitchUrl);
      if (twitchInfo.avatarUrl && (!updatedAvatar || updatedAvatar.includes("discordapp.com/embed/avatars"))) {
        updatedAvatar = twitchInfo.avatarUrl;
      }
      if (twitchInfo.bannerUrl && !updatedBanner) {
        updatedBanner = twitchInfo.bannerUrl;
      }
      if (twitchInfo.isLive) {
        isLive = true;
        livePlatform = "twitch";
        streamTitle = twitchInfo.streamTitle;
        viewerCount = twitchInfo.viewerCount;
      }
    } catch (e) {
      // ignore
    }
  }

  return {
    isLive,
    livePlatform,
    streamTitle,
    viewerCount,
    avatarUrl: updatedAvatar,
    bannerUrl: updatedBanner
  };
}

/**
 * Iterates through all streamers in DB and updates their live statuses.
 */
async function syncAllStreamers(StreamerModel, io = null) {
  try {
    const streamers = await StreamerModel.find();
    if (!streamers || streamers.length === 0) return { total: 0, liveCount: 0 };

    let liveCount = 0;
    const updates = streamers.map(async (st) => {
      try {
        const wasLive = !!st.isLive;
        const status = await checkStreamerLiveStatus(st);
        const newLive = !!status.isLive;

        st.isLive = status.isLive;
        st.livePlatform = status.livePlatform;
        st.streamTitle = status.streamTitle;
        st.viewerCount = status.viewerCount;
        if (status.avatarUrl) st.avatarUrl = status.avatarUrl;
        if (status.bannerUrl) st.bannerUrl = status.bannerUrl;
        st.lastLiveCheckedAt = new Date();
        await st.save();

        if (st.isLive) liveCount++;

        // Send Discord announcement if streamer just went live
        if (!wasLive && newLive) {
          sendStreamerLiveAnnouncement(st, status).catch(e => console.error("Announcement trigger error:", e.message));
        }
      } catch (err) {
        console.error(`Streamer live sync error for ${st.name}:`, err.message);
      }
    });

    await Promise.allSettled(updates);

    if (io) {
      io.emit("streamersLiveUpdated", { timestamp: Date.now(), liveCount });
    }

    return { total: streamers.length, liveCount };
  } catch (err) {
    console.error("syncAllStreamers error:", err);
    return { error: err.message };
  }
}

module.exports = {
  extractStreamerSlug,
  fetchKickInfo,
  fetchTwitchInfo,
  fetchStreamerAuto,
  checkStreamerLiveStatus,
  syncAllStreamers
};
