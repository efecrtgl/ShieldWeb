const express = require("express");
const config = require("../../config");
const { Application, ApplicationSubmission, DiscordUser, ServerStats } = require("../../models/ServerInfo");
const { getUserPermissions } = require("../../services/permissions");
const { actorFrom, logAction } = require("../../services/auditLog");
const { activeProcesses, getConnectedBot } = require("../../services/botRegistry");

const router = express.Router();

const APPLICATIONS_TAB = "/admin/dashboard#applications-mgmt";
const REVIEW_STATUSES = new Set(["approved", "rejected"]);

function allow(flags, { json = false } = {}) {
  return async (req, res, next) => {
    const perms = await getUserPermissions(req.session.user);
    if (!perms || (!perms.isSuperuser && !flags.some(flag => perms[flag]))) {
      return json ? res.status(403).json({ success: false, message: "Forbidden" }) : res.status(403).send("Forbidden");
    }
    next();
  };
}

function parseQuestions(questionsJson) {
  const questions = JSON.parse(questionsJson || "[]");
  if (!Array.isArray(questions)) throw new Error("questions must be an array");
  return questions;
}

function templateFields(body) {
  const { title, shortDescription, description, imageUrl } = body;
  return { title, shortDescription, description, imageUrl, questions: parseQuestions(body.questionsJson) };
}

function sendInvalidQuestions(res) {
  res.status(400).send("Geçersiz Soru Formatı: Sorular geçerli bir JSON dizisi olmalıdır.");
}

router.post("/admin/applications/add", allow(["editApplications"]), async (req, res) => {
  let fields;
  try {
    fields = templateFields(req.body);
  } catch (jsonErr) {
    return sendInvalidQuestions(res);
  }
  try {
    await new Application({ ...fields, status: "open" }).save();
    res.redirect(APPLICATIONS_TAB);
  } catch (error) {
    console.error("Application create error:", error);
    res.status(500).send("Internal Server Error");
  }
});

router.post("/admin/applications/update/:id", allow(["editApplications"]), async (req, res) => {
  let fields;
  try {
    fields = templateFields(req.body);
  } catch (jsonErr) {
    return sendInvalidQuestions(res);
  }
  try {
    await Application.findByIdAndUpdate(req.params.id, fields);
    res.redirect(APPLICATIONS_TAB);
  } catch (error) {
    console.error("Application update error:", error);
    res.status(500).send("Internal Server Error");
  }
});

router.post("/admin/applications/toggle/:id", allow(["editApplications"]), async (req, res) => {
  try {
    const appItem = await Application.findById(req.params.id);
    if (appItem) {
      appItem.status = appItem.status === "open" ? "closed" : "open";
      await appItem.save();
    }
    res.redirect(APPLICATIONS_TAB);
  } catch (error) {
    console.error("Application toggle error:", error);
    res.status(500).send("Internal Server Error");
  }
});

// Soft delete: the template and its submissions are archived, not removed.
router.post("/admin/applications/delete/:id", allow(["deleteApplications"]), async (req, res) => {
  try {
    const archived = { isDeleted: true, deletedAt: new Date() };
    await Application.findByIdAndUpdate(req.params.id, archived);
    await ApplicationSubmission.updateMany({ applicationId: req.params.id }, archived);
    res.redirect(APPLICATIONS_TAB);
  } catch (error) {
    console.error("Application delete error:", error);
    res.status(500).send("Internal Server Error");
  }
});

async function saveOrder(applications) {
  await Application.bulkWrite(applications.map((id, index) => ({ updateOne: { filter: { _id: id }, update: { order: index } } })));
}

router.post("/admin/applications/reorder", allow(["editApplications", "manageApplications"], { json: true }), async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids)) {
      return res.status(400).json({ success: false, message: "Geçersiz ID listesi." });
    }
    await saveOrder(ids);
    res.json({ success: true });
  } catch (error) {
    console.error("Error reordering applications:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/admin/applications/move/:id/:direction", allow(["editApplications", "manageApplications"]), async (req, res) => {
  try {
    const { id, direction } = req.params;
    const ids = (await Application.find({ isDeleted: { $ne: true } }).sort({ order: 1, date: -1 })).map(a => a._id.toString());
    const currentIndex = ids.indexOf(id);
    const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
    if (currentIndex !== -1 && targetIndex >= 0 && targetIndex < ids.length) {
      [ids[currentIndex], ids[targetIndex]] = [ids[targetIndex], ids[currentIndex]];
      await saveOrder(ids);
    }
    res.redirect(APPLICATIONS_TAB);
  } catch (error) {
    console.error("Application move error:", error);
    res.status(500).send("Internal Server Error");
  }
});

router.post("/admin/submissions/review/:id", allow(["reviewApplications", "manageApplications"]), async (req, res) => {
  try {
    const { status, reviewerNotes } = req.body;
    const submission = await ApplicationSubmission.findById(req.params.id).populate("applicationId");
    if (!submission) {
      return res.status(404).send("Submission not found");
    }
    if (submission.status !== "pending") {
      return res.status(400).send("Bu başvuru daha önce sonuçlandırılmıştır ve tekrar incelenemez.");
    }
    if (!REVIEW_STATUSES.has(status)) {
      return res.status(400).send("Geçersiz başvuru kararı.");
    }

    submission.status = status;
    submission.reviewerNotes = reviewerNotes;
    await submission.save();

    const actor = actorFrom(req);
    const isApproved = status === "approved";
    logAction("reviewApplications", {
      executor: actor,
      target: { id: submission.discordId, username: submission.username, data: submission },
      details: `Başvuru incelendi. Karar: ${isApproved ? "Onaylandı (Whitelist Verildi)" : "Reddedildi"}. Not: ${reviewerNotes || "Yok"}`,
      context: "Web Panel"
    });

    const whitelistUpdate = { isWhitelist: isApproved, whitelistAt: isApproved ? new Date() : null };
    const user = await DiscordUser.findOne({ discordId: submission.discordId });
    if (user) {
      Object.assign(user, whitelistUpdate);
      await user.save();
    } else {
      await new DiscordUser({ discordId: submission.discordId, username: submission.username, ...whitelistUpdate }).save();
    }

    if (activeProcesses.verification) {
      activeProcesses.verification.send({
        type: "SYNC_WHITELIST",
        discordId: submission.discordId,
        isWhitelist: isApproved,
        executorId: actor.id,
        executorUsername: actor.username
      });
    }

    const botProcess = getConnectedBot("moderation", "verification", "logger");
    if (botProcess) {
      const stats = await ServerStats.findOne();
      const channelId = stats && stats.applicationLogChannelId && stats.applicationLogChannelId !== "none"
        ? stats.applicationLogChannelId
        : config.discord.applicationLogChannelId;
      botProcess.send({
        type: "APPLICATION_REVIEW_NOTIFY",
        discordId: submission.discordId,
        applicantUsername: submission.username,
        applicationTitle: submission.applicationId ? submission.applicationId.title : "Başvuru",
        status,
        reviewerNotes: reviewerNotes || "",
        executorUsername: req.session.user ? req.session.user.username : "Yönetim",
        channelId
      });
    }

    res.redirect(APPLICATIONS_TAB);
  } catch (error) {
    console.error("Review submission error:", error);
    res.status(500).send("Internal Server Error");
  }
});

router.post("/admin/submissions/delete/:id", allow(["deleteApplications", "manageApplications", "reviewApplications", "editApplications"]), async (req, res) => {
  try {
    const submission = await ApplicationSubmission.findByIdAndDelete(req.params.id);
    if (submission) {
      logAction("deleteSubmission", {
        executor: actorFrom(req),
        target: { id: submission.discordId, username: submission.username },
        details: `Kullanıcı başvurusu kalıcı olarak silindi (ID: ${req.params.id}).`,
        context: "Web Panel"
      });
    }
    res.redirect(APPLICATIONS_TAB);
  } catch (error) {
    console.error("Delete submission error:", error);
    res.status(500).send("Internal Server Error");
  }
});

module.exports = router;
