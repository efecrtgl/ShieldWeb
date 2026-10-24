const mongoose = require("mongoose");

// Mirror of a game-server character row. Fields the bridge did not report stay null (unknown), never a guessed value.
const FivemCharacterSchema = new mongoose.Schema({
  discordId: { type: String, default: "" },
  license: { type: String, default: "" },
  citizenid: { type: String, required: true, unique: true },
  cid: { type: Number, default: null },
  firstname: { type: String, default: "" },
  lastname: { type: String, default: "" },
  birthdate: { type: String, default: "" },
  money: {
    cash: { type: Number, default: null },
    bank: { type: Number, default: null }
  },
  job: {
    name: { type: String, default: null },
    label: { type: String, default: null },
    grade: { type: String, default: null },
    gradeLevel: { type: Number, default: null }
  },
  inventory: { type: Array, default: [] },
  playtime: { type: Number, default: 0 },
  lastUpdated: { type: Date, default: Date.now }
});

FivemCharacterSchema.index({ discordId: 1 });
FivemCharacterSchema.index({ lastUpdated: -1 });

module.exports = mongoose.model("FivemCharacter", FivemCharacterSchema);
