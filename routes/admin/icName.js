const express = require("express");
const config = require("../../config");
const { getUserPermissions } = require("../../services/permissions");
const { getAllGuildMembers } = require("../../services/discordApi");

const router = express.Router();

const GEMINI_MAX_ATTEMPTS = 3;
const GEMINI_RETRY_DELAY_MS = 3000;
const GEMINI_RATE_LIMIT_DELAY_MS = 10000;

router.use("/admin/ic-name", async (req, res, next) => {
  const perms = await getUserPermissions(req.session.user);
  if (!perms || (!perms.isSuperuser && !perms.viewUsers)) {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }
  next();
});

function titleCaseTr(name) {
  return name.split(" ").map(w => w.charAt(0).toLocaleUpperCase("tr-TR") + w.slice(1)).join(" ");
}

// Server nicknames follow "Name Surname | Age"; groups members by the case-insensitive IC name part.
function groupByIcName(members) {
  const groups = new Map();
  for (const m of members) {
    const displayName = m.nick;
    if (!displayName || displayName === "Bilinmeyen Kullanıcı") continue;
    const icName = displayName.split("|")[0].trim().toLocaleLowerCase("tr-TR");
    if (!icName) continue;
    if (!groups.has(icName)) groups.set(icName, []);
    groups.get(icName).push(`${displayName} (${m.user.id})`);
  }
  return groups;
}

router.post("/admin/ic-name/scan-discord", async (req, res) => {
  try {
    const groups = groupByIcName(await getAllGuildMembers(true));
    const searchQuery = req.body.query ? String(req.body.query).trim().toLocaleLowerCase("tr-TR") : null;

    if (searchQuery) {
      const users = groups.get(searchQuery) || [];
      const duplicates = users.length > 0 ? [{ name: titleCaseTr(searchQuery), count: users.length, users }] : [];
      return res.json({ success: true, duplicates });
    }

    const duplicates = [...groups.entries()]
      .filter(([, users]) => users.length > 1)
      .map(([name, users]) => ({ name: titleCaseTr(name), count: users.length, users }))
      .sort((a, b) => b.count - a.count);
    res.json({ success: true, duplicates });
  } catch (error) {
    console.error("IC name scan error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

async function generateWithRetry(ai, prompt) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ai.models.generateContent({ model: config.gemini.model, contents: prompt });
    } catch (err) {
      if (attempt >= GEMINI_MAX_ATTEMPTS) throw err;
      const isRateLimited = err.message && err.message.includes("429");
      await new Promise(resolve => setTimeout(resolve, isRateLimited ? GEMINI_RATE_LIMIT_DELAY_MS : GEMINI_RETRY_DELAY_MS));
    }
  }
}

router.post("/admin/ic-name/check-gemini", async (req, res) => {
  try {
    const name = req.body.name ? String(req.body.name).trim() : "";
    if (!name) return res.status(400).json({ success: false, message: "İsim gerekli" });

    if (!config.gemini.apiKey) {
      return res.json({ success: false, message: "Sistemde Gemini API Key (GEMINI_API_KEY) yapılandırılmamış. Lütfen .env dosyasına ekleyin." });
    }

    const { GoogleGenAI } = require("@google/genai");
    const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
    const prompt = `"${name}" ismi dünyaca veya yerel olarak ünlü, tanınmış bir kişiye ait mi? FiveM rol yapma (roleplay) kurallarına göre bir oyuncunun bu ismi IC (In-Character) olarak kullanması uygun mudur? Lütfen sadece şu JSON formatında yanıt ver: {"isFamous": true/false, "reason": "neden uygun veya uygun olmadığını açıklayan kısa bir metin (Türkçe)"}`;

    const response = await generateWithRetry(ai, prompt);
    const rawText = typeof response.text === "function" ? response.text() : response.text;
    const result = JSON.parse(String(rawText || "").replace(/```json/g, "").replace(/```/g, "").trim());

    res.json({ success: true, isFamous: result.isFamous, reason: result.reason });
  } catch (error) {
    console.error("IC name Gemini check error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
