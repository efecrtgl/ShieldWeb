const mongoose = require("mongoose");

const SiteModuleSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, // e.g. "donate", "applications"
  name: { type: String, required: true },
  isEnabled: { type: Boolean, default: true },
  description: { type: String },
  behavior: { type: String, enum: ["redirect", "preloader"], default: "redirect" },
  customMessage: { type: String, default: "" }
});

module.exports = mongoose.model("SiteModule", SiteModuleSchema);
