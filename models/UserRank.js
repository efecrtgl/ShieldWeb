const mongoose = require("mongoose");

const UserRankSchema = new mongoose.Schema({
  discordId: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  rankId: { type: mongoose.Schema.Types.ObjectId, ref: "Rank", default: null },
  credits: { type: Number, default: 0 },
  lastLuckyWheelSpin: { type: Date }
});

module.exports = mongoose.model("UserRank", UserRankSchema);
