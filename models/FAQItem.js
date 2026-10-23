const mongoose = require("mongoose");

const FAQItemSchema = new mongoose.Schema({
  question: { type: String, required: true },
  answer: { type: String, required: true },
  order: { type: Number, default: 0 }
});

module.exports = mongoose.model("FAQItem", FAQItemSchema);
