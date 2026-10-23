const mongoose = require("mongoose");

const PunishmentRecordSchema = new mongoose.Schema({
  discordId: { type: String, required: true },
  username: { type: String, default: "Bilinmeyen Kullanıcı" },
  punishments: [{ type: String }],
  warningsAdded: { type: Number, default: 0 },
  wlDaysAdded: { type: Number, default: 0 },
  isPerma: { type: Boolean, default: false },
  executorId: { type: String, required: true },
  executorUsername: { type: String, default: "System" },
  action: { type: String, default: "" },
  reason: { type: String, default: "" },
  duration: { type: String, default: "" },
  date: { type: Date, default: Date.now }
});

module.exports = mongoose.model("PunishmentRecord", PunishmentRecordSchema);
