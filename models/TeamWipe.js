const mongoose = require("mongoose");

const TeamWipeSchema = new mongoose.Schema({
  teamId: { type: mongoose.Schema.Types.ObjectId, ref: "Team", required: true },
  executorUsername: { type: String, default: "System" },
  wipedAt: { type: Date, default: Date.now },
  restored: { type: Boolean, default: false },
  restoredAt: { type: Date, default: null },
  members: [
    {
      discordId: { type: String, required: true },
      username: { type: String, default: "" },
      isWhitelist: { type: Boolean, default: false },
      whitelistAt: { type: Date, default: null },
      addedAt: { type: Date, default: null },
      roles: [{ type: String }]
    }
  ]
});

module.exports = mongoose.model("TeamWipe", TeamWipeSchema);
