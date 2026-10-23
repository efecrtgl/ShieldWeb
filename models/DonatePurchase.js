const mongoose = require("mongoose");

const DonatePurchaseSchema = new mongoose.Schema({
  discordId: { type: String, required: true },
  username: { type: String, required: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: "DonateItem", required: true },
  pricePaid: { type: Number, required: true },
  date: { type: Date, default: Date.now }
});

module.exports = mongoose.model("DonatePurchase", DonatePurchaseSchema);
