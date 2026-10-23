const mongoose = require("mongoose");

const StreamerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  characterName: { type: String, default: "" },
  avatarUrl: { type: String, default: "https://cdn.discordapp.com/embed/avatars/0.png" },
  bannerUrl: { type: String, default: "" },
  bio: { type: String, default: "" },
  kickUrl: { type: String, default: "" },
  twitchUrl: { type: String, default: "" },
  youtubeUrl: { type: String, default: "" },
  tiktokUrl: { type: String, default: "" },
  discordUrl: { type: String, default: "" },
  isLive: { type: Boolean, default: false },
  livePlatform: { type: String, default: "" }, // 'kick' | 'twitch'
  streamTitle: { type: String, default: "" },
  viewerCount: { type: Number, default: 0 },
  lastLiveCheckedAt: { type: Date, default: null },
  tags: [{ type: String }],
  order: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Streamer", StreamerSchema);

