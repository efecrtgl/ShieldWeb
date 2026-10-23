const mongoose = require("mongoose");

const ApplicationSubmissionSchema = new mongoose.Schema({
  applicationId: { type: mongoose.Schema.Types.ObjectId, ref: "Application", required: true },
  discordId: { type: String, required: true },
  username: { type: String, required: true },
  answers: [
    {
      questionId: { type: String, required: true },
      label: { type: String, required: true },
      value: { type: mongoose.Schema.Types.Mixed, required: true } // String or Array of Strings
    }
  ],
  status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
  reviewerNotes: { type: String, default: "" },
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
  date: { type: Date, default: Date.now }
});

module.exports = mongoose.model("ApplicationSubmission", ApplicationSubmissionSchema);
