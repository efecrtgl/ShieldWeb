const express = require("express");
const { FivemCharacter } = require("../../models/ServerInfo");
const { getUserPermissions } = require("../../services/permissions");
const { actorFrom, logAction } = require("../../services/auditLog");
const { addLog, logUserAction } = require("../../services/systemLog");
const { findOnlinePlayer } = require("../../services/fivemState");
const { dispatchCommand, sendDispatchResult } = require("../../services/fivemCommands");
const { searchRegex } = require("../../utils/http");

const router = express.Router();

const MAX_PAGE_SIZE = 100;
const BRIDGE_SYNC_SETTLE_MS = 300;
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

const NAME_MAX_LENGTH = 50;
const MONEY_MAX = 1e12;
const JOB_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,50}$/;

// Fields an editor may change, with the permission flag each one needs.
const EDITABLE_FIELDS = {
  firstname: "charEditName",
  lastname: "charEditName",
  birthdate: "charEditBirthdate",
  cash: "charEditMoney",
  bank: "charEditMoney",
  jobName: "charEditJob",
  jobGrade: "charEditJob"
};

// Validates the submitted form and returns { changes, error }; changes only holds fields that differ from the stored copy,
// so an edit never pushes stale panel values (e.g. old money) back into the game.
function characterChanges(body, character) {
  const changes = {};
  const current = {
    firstname: character.firstname || "",
    lastname: character.lastname || "",
    birthdate: character.birthdate || "",
    cash: character.money ? character.money.cash : null,
    bank: character.money ? character.money.bank : null,
    jobName: character.job ? character.job.name : null,
    jobGrade: character.job && Number.isInteger(character.job.gradeLevel) ? character.job.gradeLevel : null
  };

  for (const key of ["firstname", "lastname", "birthdate"]) {
    if (body[key] === undefined) continue;
    const value = String(body[key]).trim();
    if (value.length > NAME_MAX_LENGTH) return { error: "Ad, soyad ve doğum tarihi en fazla 50 karakter olabilir." };
    if (key !== "birthdate" && !value) return { error: "Ad ve soyad boş bırakılamaz." };
    if (value !== current[key]) changes[key] = value;
  }
  for (const key of ["cash", "bank"]) {
    if (body[key] === undefined || body[key] === "" || body[key] === null) continue;
    const value = Number(body[key]);
    if (!Number.isFinite(value) || value < 0 || value > MONEY_MAX) return { error: "Para değerleri 0 veya daha büyük geçerli bir sayı olmalıdır." };
    const rounded = Math.floor(value);
    if (rounded !== current[key]) changes[key] = rounded;
  }

  const jobName = body.jobName !== undefined ? String(body.jobName).trim() : "";
  const gradeRaw = body.jobGrade !== undefined && body.jobGrade !== "" && body.jobGrade !== null ? Number(body.jobGrade) : undefined;
  if (jobName && !JOB_NAME_PATTERN.test(jobName)) return { error: "Meslek kodu yalnızca harf, rakam, '_' ve '-' içerebilir." };
  if (gradeRaw !== undefined && (!Number.isInteger(gradeRaw) || gradeRaw < 0 || gradeRaw > 100)) return { error: "Meslek kademesi 0-100 arasında bir tam sayı olmalıdır." };
  const jobChanged = (jobName && jobName !== current.jobName) || (gradeRaw !== undefined && gradeRaw !== current.jobGrade);
  if (jobChanged) {
    const name = jobName || current.jobName;
    if (!name) return { error: "Meslek kodu gereklidir." };
    if (gradeRaw === undefined && current.jobGrade === null) return { error: "Meslek kademesi (sayı) gereklidir." };
    changes.jobName = name;
    changes.jobGrade = gradeRaw !== undefined ? gradeRaw : current.jobGrade;
  }
  return { changes };
}

function panelUpdateFor(changes) {
  const update = { lastUpdated: new Date() };
  if (changes.firstname !== undefined) update.firstname = changes.firstname;
  if (changes.lastname !== undefined) update.lastname = changes.lastname;
  if (changes.birthdate !== undefined) update.birthdate = changes.birthdate;
  if (changes.cash !== undefined) update["money.cash"] = changes.cash;
  if (changes.bank !== undefined) update["money.bank"] = changes.bank;
  if (changes.jobName !== undefined) {
    update["job.name"] = changes.jobName;
    update["job.gradeLevel"] = changes.jobGrade;
  }
  return update;
}

router.post("/admin/api/characters/:citizenid/update", requirePerms(["charEditModal"], "Bu işlemi yapmak için yetkiniz bulunmamaktadır."), async (req, res) => {
  try {
    const citizenid = req.params.citizenid.trim();
    const character = await FivemCharacter.findOne({ citizenid }).lean();
    if (!character) {
      return res.status(404).json({ success: false, message: "Karakter bulunamadı." });
    }

    const { changes, error } = characterChanges(req.body || {}, character);
    if (error) return res.status(400).json({ success: false, message: error });
    const changedKeys = Object.keys(changes);
    if (changedKeys.length === 0) {
      return res.json({ success: true, confirmed: true, status: "unchanged", message: "Değişiklik yapılmadı." });
    }

    const perms = await getUserPermissions(req.session.user);
    const denied = changedKeys.filter(key => !perms.isSuperuser && !perms[EDITABLE_FIELDS[key]]);
    if (denied.length > 0) {
      return res.status(403).json({ success: false, message: `Bu alanları düzenleme yetkiniz yok: ${denied.join(", ")}` });
    }

    const result = await dispatchCommand("update_character", { citizenid, ...changes, admin: adminName(req) });
    const charName = characterName({ ...character, ...changes }, citizenid);
    if (result.ok) {
      await FivemCharacter.updateOne({ citizenid }, { $set: panelUpdateFor(changes) });
      logUserAction(req, "Karakter Güncellendi", `CitizenID: ${citizenid} (${charName}) Alanlar: ${changedKeys.join(", ")}`);
      logAction("fivemCharacterUpdate", {
        executor: actorFrom(req),
        target: { id: citizenid, username: charName },
        details: `FiveM karakteri güncellendi (${changedKeys.join(", ")}). Durum: ${result.confirmed ? "oyun sunucusu onayladı" : "iletildi, doğrulanamadı"}.`,
        context: "Web Panel"
      });
    } else {
      addLog("sync", `FiveM Köprüsü: Karakter güncellenemedi (CitizenID: ${citizenid}): ${result.message}`, "error");
    }
    sendDispatchResult(res, result, { message: result.ok ? `"${charName}": ${result.message}` : result.message });
  } catch (err) {
    console.error("POST /admin/api/characters/update error:", err);
    res.status(500).json({ success: false, message: "Güncelleme sırasında bir hata oluştu." });
  }
});

function removeFromInventory(inventory, { itemName, slot, amount }) {
  let removedLabel = itemName || "Eşya";
  const next = (Array.isArray(inventory) ? inventory : []).filter(item => {
    if (!item) return false;
    if (slot !== null && Number(item.slot) === slot) {
      if (item.label) removedLabel = item.label;
      return false;
    }
    if (slot === null && itemName && (item.name === itemName || item.item === itemName)) {
      if (item.label) removedLabel = item.label;
      const currentCount = Number(item.count ?? item.amount ?? 1);
      if (currentCount > amount) {
        item.count = currentCount - amount;
        item.amount = item.count;
        return true;
      }
      return false;
    }
    return true;
  });
  return { inventory: next, removedLabel };
}

router.post("/admin/api/characters/:citizenid/delete-item", requirePerms(["charDeleteItem"], "Eşya silmek için yetkiniz bulunmamaktadır."), async (req, res) => {
  try {
    const citizenid = req.params.citizenid.trim();
    const itemName = typeof req.body.itemName === "string" ? req.body.itemName.trim() : "";
    const slot = req.body.slot !== undefined && req.body.slot !== null && req.body.slot !== "" ? Number(req.body.slot) : null;
    const amount = req.body.amount !== undefined && req.body.amount !== null && req.body.amount !== "" ? Number(req.body.amount) : 1;

    if (!itemName && slot === null) {
      return res.status(400).json({ success: false, message: "Silinecek eşya kodu veya slot gereklidir." });
    }
    if ((slot !== null && (!Number.isInteger(slot) || slot < 0)) || !Number.isInteger(amount) || amount < 1) {
      return res.status(400).json({ success: false, message: "Geçersiz slot veya miktar." });
    }

    const character = await FivemCharacter.findOne({ citizenid });
    if (!character) {
      return res.status(404).json({ success: false, message: "Karakter bulunamadı." });
    }

    const onlinePlayer = findOnlinePlayer({ discordId: character.discordId, citizenid });
    // Exactly one command: queueing two action aliases made the bridge remove the item twice.
    const result = await dispatchCommand("removeitem", {
      citizenid,
      targetPlayer: onlinePlayer ? onlinePlayer.id : null,
      item: itemName,
      slot,
      amount,
      admin: adminName(req)
    });
    if (!result.ok) return sendDispatchResult(res, result);

    const { inventory, removedLabel } = removeFromInventory(character.inventory, { itemName, slot, amount });
    character.inventory = inventory;
    character.lastUpdated = new Date();
    await character.save();

    logUserAction(req, "Karakter Eşya Silindi", `CitizenID: ${citizenid}, Eşya: ${removedLabel}`);
    logAction("fivemCharacterItemDelete", {
      executor: actorFrom(req),
      target: { id: citizenid, username: characterName(character, citizenid) },
      details: `Envanterden eşya silindi: ${removedLabel} (${itemName || "Slot " + slot}) x${amount} (CitizenID: ${citizenid})`,
      context: "Web Panel"
    });
    sendDispatchResult(res, result, { message: `"${removedLabel}": ${result.message}`, inventory });
  } catch (err) {
    console.error("POST /admin/api/characters/delete-item error:", err);
    res.status(500).json({ success: false, message: "Eşya silinirken hata oluştu." });
  }
});

router.post("/admin/api/characters/:citizenid/clear-inventory", requirePerms(["charClearInventory"], "Envanter sıfırlamak için yetkiniz bulunmamaktadır."), async (req, res) => {
  try {
    const citizenid = req.params.citizenid.trim();
    const character = await FivemCharacter.findOne({ citizenid });
    if (!character) {
      return res.status(404).json({ success: false, message: "Karakter bulunamadı." });
    }

    const onlinePlayer = findOnlinePlayer({ discordId: character.discordId, citizenid });
    const result = await dispatchCommand("clearinventory", {
      citizenid,
      targetPlayer: onlinePlayer ? onlinePlayer.id : null,
      admin: adminName(req)
    });
    if (!result.ok) return sendDispatchResult(res, result);

    character.inventory = [];
    character.lastUpdated = new Date();
    await character.save();

    const charName = characterName(character, citizenid);
    logUserAction(req, "Karakter Envanter Sıfırlandı", `CitizenID: ${citizenid}`);
    logAction("fivemCharacterInventoryClear", {
      executor: actorFrom(req),
      target: { id: citizenid, username: charName },
      details: `Tüm envanter sıfırlandı (CitizenID: ${citizenid})`,
      context: "Web Panel"
    });
    sendDispatchResult(res, result, { message: `"${charName}": ${result.message}`, inventory: [] });
  } catch (err) {
    console.error("POST /admin/api/characters/clear-inventory error:", err);
    res.status(500).json({ success: false, message: "Envanter sıfırlanırken hata oluştu." });
  }
});

// Asks the game server to push this character again; falls back to the stored copy, clearly marked as not fresh.
router.post("/admin/api/characters/:citizenid/sync-inventory", requirePerms(["charEditModal", "editUsers", "viewUsers"]), async (req, res) => {
  try {
    const citizenid = req.params.citizenid.trim();
    const before = await FivemCharacter.findOne({ citizenid }, { lastUpdated: 1 }).lean();
    if (!before) {
      return res.status(404).json({ success: false, message: "Karakter bulunamadı." });
    }

    const result = await dispatchCommand("sync_characters", { citizenid });
    if (result.confirmed) {
      // The v2 bridge acknowledges after posting the character; give the write a moment to land.
      await new Promise(resolve => setTimeout(resolve, BRIDGE_SYNC_SETTLE_MS));
    }
    const character = await FivemCharacter.findOne({ citizenid }).lean();
    const fresh = !!(character && character.lastUpdated && (!before.lastUpdated || character.lastUpdated > before.lastUpdated));
    res.json({
      success: true,
      fresh,
      status: result.status,
      lastUpdated: character ? character.lastUpdated : null,
      message: fresh
        ? "Envanter FiveM sunucusundan yenilendi."
        : `Güncel veri alınamadı (${result.message}). Gösterilen veri son senkronizasyona aittir.`,
      inventory: character ? character.inventory || [] : [],
      character
    });
  } catch (err) {
    console.error("POST /admin/api/characters/:citizenid/sync-inventory error:", err);
    res.status(500).json({ success: false, message: "Envanter yenilenirken hata oluştu." });
  }
});

module.exports = router;
