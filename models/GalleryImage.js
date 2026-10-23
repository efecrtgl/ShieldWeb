const mongoose = require("mongoose");

const GalleryImageSchema = new mongoose.Schema({
  imageUrl: { type: String, required: true },
  caption: { type: String, default: "" },
  order: { type: Number, default: 0 }
});

module.exports = mongoose.model("GalleryImage", GalleryImageSchema);
