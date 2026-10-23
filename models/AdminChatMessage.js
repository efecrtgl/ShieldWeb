const mongoose = require("mongoose");

const adminChatMessageSchema = new mongoose.Schema({
  senderId: { type: String, required: true },
  senderUsername: { type: String, required: true },
  senderAvatar: { type: String },
  senderRankName: { type: String },
  senderRankColor: { type: String },
  message: { type: String, required: true },
  edited: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("AdminChatMessage", adminChatMessageSchema);
