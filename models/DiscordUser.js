const mongoose = require("mongoose");

const DiscordUserSchema = new mongoose.Schema({
  discordId: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  avatarUrl: { type: String, default: "" },
  description: { type: String, default: "" },
  rankId: { type: mongoose.Schema.Types.ObjectId, ref: "Rank", default: null },
  isWhitelist: { type: Boolean, default: false },
  whitelistAt: { type: Date, default: null },
  warnings: { type: Number, default: 0 },
  wlCezaBitis: { type: Date, default: null },
  isPermaBanned: { type: Boolean, default: false },
  hasTT: { type: Boolean, default: false },
  teamId: { type: mongoose.Schema.Types.ObjectId, ref: "Team", default: null },
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", default: null },
  addedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("DiscordUser", DiscordUserSchema);
