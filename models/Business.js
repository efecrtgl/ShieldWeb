const mongoose = require("mongoose");

const BusinessSchema = new mongoose.Schema({
  name: { type: String, required: true },
  color: { type: String, required: true },
  bossId: { type: String, default: "none" },
  maxMembers: { type: Number, default: 50, min: 0, max: 50 },
  roleId: { type: String },
  channelId: { type: String },
  notes: { type: String, default: "" },
  createdById: { type: String },
  createdByUsername: { type: String },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Business", BusinessSchema);
