const mongoose = require("mongoose");

const ActionLogSchema = new mongoose.Schema({
  executorId: { type: String, required: true },
  executorUsername: { type: String, required: true },
  targetId: { type: String, default: "" },
  targetUsername: { type: String, default: "" },
  actionType: { type: String, required: true },
  details: { type: String, default: "" },
  timestamp: { type: Date, default: Date.now },
  executorIp: { type: String, default: "" },
  context: { type: String, default: "" },
  rawData: { type: mongoose.Schema.Types.Mixed, default: {} }
});

ActionLogSchema.index({ timestamp: -1 });
ActionLogSchema.index({ actionType: 1, timestamp: -1 });
ActionLogSchema.index({ executorUsername: 1 });
ActionLogSchema.index({ targetUsername: 1 });

module.exports = mongoose.model("ActionLog", ActionLogSchema);
