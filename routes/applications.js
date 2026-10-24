const express = require("express");
const mongoose = require("mongoose");
const { Application, ApplicationSubmission } = require("../models/ServerInfo");
const { checkModule } = require("../middleware/siteContext");
const { renderRichText } = require("../utils/markdown");
const { rateLimit } = require("../middleware/rateLimit");

const router = express.Router();

// Open (not soft-deleted) application form by id, or null.
async function findActiveApplication(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return Application.findOne({ _id: id, isDeleted: { $ne: true } });
}

// User: Applications list page
router.get("/applications", checkModule("applications"), async (req, res) => {
  try {
    const applications = await Application.find({ isDeleted: { $ne: true } }).sort({ order: 1, date: -1 });
    let submissions = [];
    if (req.session.user) {
      submissions = await ApplicationSubmission.find({ discordId: req.session.user.id })
        .populate("applicationId")
        .sort({ date: -1 });
    }
    res.render("applications", {
      applications,
      submissions,
      user: req.session.user || null
    });
  } catch (error) {
    console.error("Applications page error:", error);
    res.status(500).send("Internal Server Error");
  }
});

// User: Application detail / apply page
router.get("/applications/:id", checkModule("applications"), async (req, res) => {
  if (!req.session.user) {
    return res.redirect(`/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  try {
    const appItem = await findActiveApplication(req.params.id);
    if (!appItem) {
      return res.status(404).send("Application not found");
    }
    // The description mixes markdown and the admin editor's HTML; only formatting tags survive.
    const parsedApp = appItem.toObject();
    parsedApp.description = renderRichText(parsedApp.description);

    res.render("apply", {
      application: parsedApp,
      user: req.session.user
    });
  } catch (error) {
    res.status(500).send("Internal Server Error");
  }
});

// User: Submit application
router.post("/applications/:id/apply", checkModule("applications"), rateLimit({ name: "apply", windowMs: 10 * 60 * 1000, max: 5 }), async (req, res) => {
  if (!req.session.user) {
    return res.status(403).send("Forbidden");
  }
  try {
    const appItem = await findActiveApplication(req.params.id);
    if (!appItem) {
      return res.status(404).send("Application not found");
    }
    if (appItem.status === "closed") {
      return res.status(400).send("This application is closed");
    }

    // Format answers
    const answers = [];
    const submittedAnswers = req.body.answers || {};
    const questionLabels = req.body.questionLabels || {};

    appItem.questions.forEach(q => {
      let val = submittedAnswers[q.id];
      if (val === undefined || val === null) {
        val = q.type === 'checkbox' ? [] : "";
      }
      // Express parses multiple checkboxes as array or string if single. Ensure array for checkboxes.
      if (q.type === 'checkbox' && !Array.isArray(val)) {
        val = val ? [val] : [];
      }
      answers.push({
        questionId: q.id,
        label: q.label || questionLabels[q.id],
        value: val
      });
    });

    const submission = new ApplicationSubmission({
      applicationId: appItem._id,
      discordId: req.session.user.id,
      username: req.session.user.username,
      answers,
      status: "pending"
    });

    await submission.save();
    res.redirect("/applications");
  } catch (error) {
    res.status(500).send("Internal Server Error");
  }
});

module.exports = router;
