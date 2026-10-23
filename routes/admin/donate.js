const express = require("express");
const { UserRank, DonateItem } = require("../../models/ServerInfo");
const { getUserPermissions } = require("../../services/permissions");
const { actorFrom, logAction } = require("../../services/auditLog");
const { invalidateUserCredits } = require("../../services/siteCache");
const { imageFile } = require("../../middleware/upload");

const router = express.Router();

const DONATE_TAB = "/admin/dashboard#donate-mgmt";

function allow(flag) {
  return async (req, res, next) => {
    const perms = await getUserPermissions(req.session.user);
    if (!perms || (!perms.isSuperuser && !perms[flag])) {
      return res.status(403).send("Forbidden");
    }
    next();
  };
}

// Item fields from the form; an uploaded image wins over a pasted URL.
function itemFields(req) {
  const { name, description, category } = req.body;
  const imageUrl = req.file ? "/uploads/" + req.file.filename : req.body.imageUrl;
  return { name, description, category, imageUrl, price: parseInt(req.body.price, 10) };
}

router.post("/admin/donate/edit-credits", allow("giveCredits"), async (req, res) => {
  try {
    const { userId } = req.body;
    const parsedCredits = parseInt(req.body.credits, 10);
    if (isNaN(parsedCredits) || parsedCredits < 0) {
      return res.status(400).send("Geçersiz kredi miktarı");
    }
    const userRank = await UserRank.findById(userId);
    await UserRank.findByIdAndUpdate(userId, { credits: parsedCredits });
    if (userRank) invalidateUserCredits(userRank.discordId);

    logAction("giveCredits", {
      executor: actorFrom(req),
      target: { id: userRank ? userRank.discordId : "Bilinmiyor", username: userRank ? userRank.username : "Bilinmiyor", data: userRank },
      details: `Kullanıcı kredisi ${parsedCredits} olarak güncellendi.`,
      context: "Web Panel"
    });
    res.redirect(DONATE_TAB);
  } catch (error) {
    console.error("Admin edit credits error:", error);
    res.status(500).send("Internal Server Error");
  }
});

router.post("/admin/donate/items/add", allow("editDonate"), imageFile("imageFile"), async (req, res) => {
  try {
    const fields = itemFields(req);
    if (isNaN(fields.price) || fields.price <= 0) {
      return res.status(400).send("Geçersiz fiyat");
    }
    const item = await new DonateItem({ ...fields, order: await DonateItem.countDocuments() }).save();

    logAction("donateCreate", {
      executor: actorFrom(req),
      target: { id: item._id.toString(), username: item.name, data: item },
      details: `Yeni mağaza ürünü eklendi: ${item.name} (Fiyat: ${item.price} Kredi)`,
      context: "Web Panel"
    });
    res.redirect(DONATE_TAB);
  } catch (error) {
    console.error("Admin add item error:", error);
    res.status(500).send("Internal Server Error");
  }
});

router.post("/admin/donate/items/edit/:id", allow("editDonate"), imageFile("imageFile"), async (req, res) => {
  try {
    const { imageUrl, ...fields } = itemFields(req);
    if (isNaN(fields.price) || fields.price <= 0) {
      return res.status(400).send("Geçersiz fiyat");
    }
    if (imageUrl) fields.imageUrl = imageUrl;

    const oldItem = await DonateItem.findById(req.params.id);
    await DonateItem.findByIdAndUpdate(req.params.id, fields);

    logAction("donateEdit", {
      executor: actorFrom(req),
      target: { id: req.params.id, username: fields.name, data: oldItem },
      details: `Mağaza ürünü güncellendi: ${fields.name} (Yeni Fiyat: ${fields.price} Kredi)`,
      context: "Web Panel"
    });
    res.redirect(DONATE_TAB);
  } catch (error) {
    console.error("Admin edit item error:", error);
    res.status(500).send("Internal Server Error");
  }
});

router.post("/admin/donate/items/delete/:id", allow("deleteDonate"), async (req, res) => {
  try {
    const item = await DonateItem.findById(req.params.id);
    logAction("donateDelete", {
      executor: actorFrom(req),
      target: { id: req.params.id, username: item ? item.name : "Bilinmeyen Ürün", data: item },
      details: `Mağaza ürünü silindi: ${item ? item.name : req.params.id}`,
      context: "Web Panel"
    });
    await DonateItem.findByIdAndDelete(req.params.id);
    res.redirect(DONATE_TAB);
  } catch (error) {
    console.error("Admin delete item error:", error);
    res.status(500).send("Internal Server Error");
  }
});

module.exports = router;
