const express = require("express");
const { UpdateNote, FAQItem, GalleryImage, ServerStats } = require("../../models/ServerInfo");
const { getUserPermissions } = require("../../services/permissions");

const router = express.Router();

// Form-post guard: 403 "Forbidden" unless superuser or one of the given permission flags.
function allow(...flags) {
  return async (req, res, next) => {
    const perms = await getUserPermissions(req.session.user);
    if (!perms || (!perms.isSuperuser && !flags.some(flag => perms[flag]))) {
      return res.status(403).send("Forbidden");
    }
    next();
  };
}

function handle(redirectTo, action) {
  return async (req, res) => {
    try {
      await action(req);
      res.redirect(redirectTo);
    } catch (error) {
      console.error(`Admin content error (${req.originalUrl}):`, error);
      res.status(500).send("Internal Server Error");
    }
  };
}

async function reorder(Model, ids) {
  if (!Array.isArray(ids)) return;
  await Model.bulkWrite(ids.map((id, index) => ({ updateOne: { filter: { _id: id }, update: { order: index } } })));
}

// Update notes (changelog shown on the home page)
router.post("/admin/add-update", allow("createUpdates"), handle("/admin/dashboard#updates", async req => {
  const { title, description } = req.body;
  await new UpdateNote({ title, description }).save();
}));

router.post("/admin/delete-update/:id", allow("deleteUpdates"), handle("/admin/dashboard#updates", async req => {
  await UpdateNote.findByIdAndDelete(req.params.id);
}));

router.post("/admin/updates/edit/:id", allow("editUpdates"), handle("/admin/dashboard#updates", async req => {
  const { title, description } = req.body;
  await UpdateNote.findByIdAndUpdate(req.params.id, { title, description });
}));

// FAQ
router.post("/admin/website/faq/add", allow("editWebsite"), handle("/admin/dashboard#faq-settings", async req => {
  const { question, answer, order } = req.body;
  await new FAQItem({ question, answer, order: parseInt(order, 10) || 0 }).save();
}));

router.post("/admin/website/faq/delete/:id", allow("editWebsite"), handle("/admin/dashboard#faq-settings", async req => {
  await FAQItem.findByIdAndDelete(req.params.id);
}));

// Gallery
router.post("/admin/website/gallery/add", allow("editWebsite"), handle("/admin/dashboard#gallery-settings", async req => {
  const { imageUrl, caption, order } = req.body;
  await new GalleryImage({ imageUrl, caption: caption || "", order: parseInt(order, 10) || 0 }).save();
}));

router.post("/admin/website/gallery/delete/:id", allow("editWebsite"), handle("/admin/dashboard#gallery-settings", async req => {
  await GalleryImage.findByIdAndDelete(req.params.id);
}));

router.post("/admin/website/gallery/reorder", allow("editWebsite"), async (req, res) => {
  try {
    await reorder(GalleryImage, req.body.ids);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Theme
router.post("/admin/settings/theme", allow("editWebsite"), async (req, res) => {
  try {
    const { themeColor } = req.body;
    if (!/^#[0-9A-F]{6}$/i.test(themeColor)) {
      return res.status(400).send("Geçersiz renk formatı.");
    }
    await ServerStats.updateOne({}, { $set: { themeColor } }, { upsert: true });
    res.redirect("/admin/dashboard#theme-settings");
  } catch (error) {
    console.error("Theme color update error:", error);
    res.status(500).send("Internal Server Error");
  }
});

module.exports = router;
