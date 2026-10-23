const mongoose = require("mongoose");

const DiscordBotSchema = new mongoose.Schema({
  botId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  isEnabled: { type: Boolean, default: true },
  description: { type: String, default: "" },
  statusText: { type: String, default: "Playing EmpireV" },
  statusType: { type: String, default: "online" },
  activityType: { type: String, default: "playing" },
  streamingUrl: { type: String, default: "" },
  avatarUrl: { type: String, default: "" },
  voiceChannelId: { type: String, default: "" },
  clientId: { type: String, default: "" }
});

module.exports = mongoose.model("DiscordBot", DiscordBotSchema);
