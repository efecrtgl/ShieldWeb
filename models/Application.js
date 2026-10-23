const mongoose = require("mongoose");

const QuestionSchema = new mongoose.Schema({
  id: { type: String, required: true }, // e.g., "q_1719700000000"
  type: { type: String, enum: ["short", "long", "radio", "checkbox", "select"], required: true },
  label: { type: String, required: true },
  required: { type: Boolean, default: false },
  options: [String] // used for radio, checkbox, select
});

const ApplicationSchema = new mongoose.Schema({
  title: { type: String, required: true },
  shortDescription: { type: String, required: true },
  description: { type: String, required: true }, // Markdown description
  imageUrl: { type: String, default: "" },
  status: { type: String, enum: ["open", "closed"], default: "open" },
  questions: [QuestionSchema],
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
  order: { type: Number, default: 0 },
  date: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Application", ApplicationSchema);
