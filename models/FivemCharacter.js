const mongoose = require("mongoose");

const FivemCharacterSchema = new mongoose.Schema({
  discordId: { type: String, default: "" },
  license: { type: String, default: "" },
  citizenid: { type: String, required: true, unique: true },
  cid: { type: Number, default: 1 },
  firstname: { type: String, default: "" },
  lastname: { type: String, default: "" },
  birthdate: { type: String, default: "" },
  money: {
    cash: { type: Number, default: 0 },
    bank: { type: Number, default: 0 }
  },
  job: {
    name: { type: String, default: "unemployed" },
    label: { type: String, default: "Civilian" },
    grade: { type: String, default: "Freelancer" }
  },
  inventory: { type: Array, default: [] },
  playtime: { type: Number, default: 0 },
  lastUpdated: { type: Date, default: Date.now }
});

module.exports = mongoose.model("FivemCharacter", FivemCharacterSchema);
