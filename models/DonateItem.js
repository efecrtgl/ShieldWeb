const mongoose = require("mongoose");

const DonateItemSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, required: true },
  price: { type: Number, required: true }, // in credits
  category: { type: String, enum: ["araba", "motorsiklet", "isletme", "illegal"], required: true },
  imageUrl: { type: String, required: true },
  order: { type: Number, default: 0 }
});

module.exports = mongoose.model("DonateItem", DonateItemSchema);
