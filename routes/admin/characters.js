const express = require("express");
const { FivemCharacter } = require("../../models/ServerInfo");
const { getUserPermissions } = require("../../services/permissions");
const { actorFrom, logAction } = require("../../services/auditLog");
const { addLog, logUserAction } = require("../../services/systemLog");
const { queueCommand, findOnlinePlayer } = require("../../services/fivemState");
const { searchRegex } = require("../../utils/http");

const router = express.Router();

const MAX_PAGE_SIZE = 100;
const BRIDGE_SYNC_WAIT_MS = 1500;
const SORT_OPTIONS = {
  lastUpdated_desc: { lastUpdated: -1 },
  lastUpdated_asc: { lastUpdated: 1 },
  firstname_asc: { firstname: 1 },
  firstname_desc: { firstname: -1 },
  money_desc: { "money.cash": -1 },
  playtime_desc: { playtime: -1 }
};

// Requires a session and at least one of the given permission flags (superusers always pass).
function requirePerms(flags, forbiddenMessage = "Forbidden") {
  return async (req, res, next) => {
    if (!req.session.user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    const perms = await getUserPermissions(req.session.user);
    if (!perms || (!perms.isSuperuser && !flags.some(flag => perms[flag]))) {
      return res.status(403).json({ success: false, message: forbiddenMessage });
    }
    next();
  };
}

function characterName(character, fallback) {
  return `${character.firstname || ""} ${character.lastname || ""}`.trim() || fallback;
}

function adminName(req) {
  return req.session.user ? req.session.user.username : "Web Panel";
}

router.get("/admin/api/characters", requirePerms(["viewUsers"]), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, MAX_PAGE_SIZE);
    const search = String(req.query.search || "").trim();
    const query = search
      ? { $or: ["firstname", "lastname", "citizenid", "discordId"].map(field => ({ [field]: searchRegex(search) })) }
      : {};

    const total = await FivemCharacter.countDocuments(query);
    const characters = await FivemCharacter.find(query)
      .sort(SORT_OPTIONS[req.query.sort] || SORT_OPTIONS.lastUpdated_desc)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    for (const char of characters) {
      char.isOnline = !!findOnlinePlayer({ discordId: char.discordId });
    }

    res.json({ success: true, characters, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("GET /admin/api/characters error:", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

router.get("/admin/api/characters/:citizenid", requirePerms(["viewUsers"]), async (req, res) => {
  try {
    const character = await FivemCharacter.findOne({ citizenid: req.params.citizenid.trim() }).lean();
    if (!character) {
      return res.status(404).json({ success: false, message: "Karakter bulunamadı." });
    }
    res.json({ success: true, character });
  } catch (err) {
    console.error("GET /admin/api/characters/:citizenid error:", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

router.post("/admin/api/characters/:citizenid/update", requirePerms(["charEditModal", "editUsers"], "Bu işlemi yapmak için yetkiniz bulunmamaktadır."), async (req, res) => {
  try {
    const citizenid = req.params.citizenid.trim();
    const { firstname, lastname, birthdate, cash, bank, jobName, jobLabel, jobGrade } = req.body;
    const toMoney = value => parseFloat(value) || 0;

    const updateData = { lastUpdated: new Date() };
    if (firstname !== undefined) updateData.firstname = firstname;
    if (lastname !== undefined) updateData.lastname = lastname;
    if (birthdate !== undefined) updateData.birthdate = birthdate;
    if (cash !== undefined) updateData["money.cash"] = toMoney(cash);
    if (bank !== undefined) updateData["money.bank"] = toMoney(bank);
    if (jobName !== undefined) updateData["job.name"] = jobName;
    if (jobLabel !== undefined) updateData["job.label"] = jobLabel;
    if (jobGrade !== undefined) updateData["job.grade"] = jobGrade;

    const updated = await FivemCharacter.findOneAndUpdate({ citizenid }, { $set: updateData }, { new: true });
    if (!updated) {
      return res.status(404).json({ success: false, message: "Karakter bulunamadı." });
    }

    const charName = characterName(updated, citizenid);
    queueCommand("cmd_updatechar", {
      action: "update_character",
      citizenid,
      firstname: firstname !== undefined ? firstname : updated.firstname,
      lastname: lastname !== undefined ? lastname : updated.lastname,
      birthdate: birthdate !== undefined ? birthdate : updated.birthdate,
      cash: cash !== undefined ? toMoney(cash) : (updated.money ? updated.money.cash : 0),
      bank: bank !== undefined ? toMoney(bank) : (updated.money ? updated.money.bank : 0),
      jobName: jobName !== undefined ? jobName : (updated.job ? updated.job.name : ""),
      jobLabel: jobLabel !== undefined ? jobLabel : (updated.job ? updated.job.label : ""),
      jobGrade: jobGrade !== undefined ? jobGrade : (updated.job ? updated.job.grade : ""),
      admin: adminName(req),
      timestamp: Date.now()
    });

    addLog("sync", `FiveM Köprüsü: Karakter bilgileri anında FiveM SQL kuyruğuna aktarıldı (CitizenID: ${citizenid}, İsim: ${charName})`, "info");
    logUserAction(req, "Karakter Güncellendi", `CitizenID: ${citizenid} (${charName})`);
    logAction("fivemCharacterUpdate", {
      executor: actorFrom(req),
      target: { id: citizenid, username: charName },
      details: `FiveM Karakteri güncellendi: ${charName} (citizenid: ${citizenid}) (15 saniye sonra SQL'e işlenecek)`,
      context: "Web Panel"
    });

    res.json({ success: true, message: `"${charName}" isimli karakter başarıyla güncellendi. (15 saniye sonra FiveM SQL'e yansıtılacaktır.)` });
  } catch (err) {
    console.error("POST /admin/api/characters/update error:", err);
    res.status(500).json({ success: false, message: "Güncelleme sırasında bir hata oluştu." });
  }
});

router.post("/admin/api/characters/:citizenid/delete-item", requirePerms(["charDeleteItem", "deleteUsers", "editUsers"], "Eşya silmek için yetkiniz bulunmamaktadır."), async (req, res) => {
  try {
    const citizenid = req.params.citizenid.trim();
    const { itemName, slot, amount } = req.body;
    const hasSlot = slot !== undefined && slot !== null;

    if (!itemName && !hasSlot) {
      return res.status(400).json({ success: false, message: "Silinecek eşya kodu veya slot gereklidir." });
    }

    const character = await FivemCharacter.findOne({ citizenid });
    if (!character) {
      return res.status(404).json({ success: false, message: "Karakter bulunamadı." });
    }

    let removedItemLabel = itemName || "Eşya";
    const removeAmount = Number(amount) || 1;
    const inventory = (Array.isArray(character.inventory) ? character.inventory : []).filter(item => {
      if (!item) return false;
      if (hasSlot && Number(item.slot) === Number(slot)) {
        if (item.label) removedItemLabel = item.label;
        return false;
      }
      if (itemName && (item.name === itemName || item.item === itemName)) {
        if (item.label) removedItemLabel = item.label;
        const currentCount = item.count || item.amount || 1;
        if (currentCount > removeAmount) {
          item.count = currentCount - removeAmount;
          item.amount = currentCount - removeAmount;
          return true;
        }
        return false;
      }
      return true;
    });

    character.inventory = inventory;
    character.lastUpdated = new Date();
    await character.save();

    const onlinePlayer = findOnlinePlayer({ discordId: character.discordId, citizenid });
    const itemCommand = {
      citizenid,
      identifier: citizenid,
      targetPlayer: onlinePlayer ? onlinePlayer.id : null,
      item: itemName || "",
      itemName: itemName || "",
      name: itemName || "",
      slot: hasSlot ? Number(slot) : null,
      amount: amount ? Number(amount) : 1,
      count: amount ? Number(amount) : 1,
      admin: adminName(req),
      timestamp: Date.now()
    };
    // Both action names are sent so either bridge variant handles the removal.
    queueCommand("cmd_delitem", { action: "delete_item", type: "delete_item", ...itemCommand });
    queueCommand("cmd_remitem", { action: "removeitem", type: "removeitem", ...itemCommand });

    logUserAction(req, "Karakter Eşya Silindi", `CitizenID: ${citizenid}, Eşya: ${removedItemLabel}`);
    logAction("fivemCharacterItemDelete", {
      executor: actorFrom(req),
      target: { id: citizenid, username: characterName(character, citizenid) },
      details: `Envanterden eşya silindi: ${removedItemLabel} (${itemName || "Slot " + slot}) (CitizenID: ${citizenid})`,
      context: "Web Panel"
    });

    res.json({ success: true, message: `"${removedItemLabel}" eşyası envanterden başarıyla silindi.`, inventory });
  } catch (err) {
    console.error("POST /admin/api/characters/delete-item error:", err);
    res.status(500).json({ success: false, message: "Eşya silinirken hata oluştu." });
  }
});

router.post("/admin/api/characters/:citizenid/clear-inventory", requirePerms(["charClearInventory", "deleteUsers"], "Envanter sıfırlamak için yetkiniz bulunmamaktadır."), async (req, res) => {
  try {
    const citizenid = req.params.citizenid.trim();
    const character = await FivemCharacter.findOne({ citizenid });
    if (!character) {
      return res.status(404).json({ success: false, message: "Karakter bulunamadı." });
    }

    character.inventory = [];
    character.lastUpdated = new Date();
    await character.save();

    const onlinePlayer = findOnlinePlayer({ discordId: character.discordId, citizenid });
    const clearCommand = {
      citizenid,
      identifier: citizenid,
      targetPlayer: onlinePlayer ? onlinePlayer.id : null,
      admin: adminName(req),
      timestamp: Date.now()
    };
    queueCommand("cmd_clearinv", { action: "clear_inventory", type: "clear_inventory", ...clearCommand });
    queueCommand("cmd_clearinventory", { action: "clearinventory", type: "clearinventory", ...clearCommand });

    const charName = characterName(character, citizenid);
    logUserAction(req, "Karakter Envanter Sıfırlandı", `CitizenID: ${citizenid}`);
    logAction("fivemCharacterInventoryClear", {
      executor: actorFrom(req),
      target: { id: citizenid, username: charName },
      details: `Tüm envanter sıfırlandı (CitizenID: ${citizenid})`,
      context: "Web Panel"
    });

    res.json({ success: true, message: `"${charName}" isimli karakterin tüm envanteri sıfırlandı.`, inventory: [] });
  } catch (err) {
    console.error("POST /admin/api/characters/clear-inventory error:", err);
    res.status(500).json({ success: false, message: "Envanter sıfırlanırken hata oluştu." });
  }
});

router.post("/admin/api/characters/:citizenid/sync-inventory", requirePerms(["charEditModal", "editUsers", "viewUsers"]), async (req, res) => {
  try {
    const citizenid = req.params.citizenid.trim();
    queueCommand("cmd_syncinv", { action: "sync_characters", type: "sync_characters", citizenid, timestamp: Date.now() });

    // Give an online bridge time to push the fresh character data.
    await new Promise(resolve => setTimeout(resolve, BRIDGE_SYNC_WAIT_MS));

    const character = await FivemCharacter.findOne({ citizenid }).lean();
    if (!character) {
      return res.status(404).json({ success: false, message: "Karakter bulunamadı." });
    }
    res.json({ success: true, message: "Envanter FiveM sunucusundan anlık olarak çekildi.", inventory: character.inventory || [], character });
  } catch (err) {
    console.error("POST /admin/api/characters/:citizenid/sync-inventory error:", err);
    res.status(500).json({ success: false, message: "Envanter yenilenirken hata oluştu." });
  }
});

module.exports = router;
