const mongoose = require("mongoose");

const TeamSchema = new mongoose.Schema({
  name: { type: String, required: true },
  color: { type: String, required: true },
  bossId: { type: String, required: true },
  type: { type: String, enum: ["legal", "illegal", "business"], required: true },
  maxMembers: { type: Number, default: 50, min: 0, max: 50 },
  roleId: { type: String },
  channelId: { type: String },
  notes: { type: String, default: "" },
  createdById: { type: String },
  createdByUsername: { type: String },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Team", TeamSchema);
