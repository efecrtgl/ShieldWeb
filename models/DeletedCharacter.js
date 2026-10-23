const mongoose = require("mongoose");

const DeletedCharacterSchema = new mongoose.Schema({
  citizenid: { type: String, required: true, unique: true },
  discordId: { type: String, default: "" },
  charName: { type: String, default: "" },
  deletedBy: { type: String, default: "Web Panel" },
  deletedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("DeletedCharacter", DeletedCharacterSchema);
