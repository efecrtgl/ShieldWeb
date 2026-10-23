const express = require("express");
const { UserRank, AdminChatMessage } = require("../models/ServerInfo");
const { getUserPermissions, hasAnyPermission } = require("../services/permissions");
const { actorFrom, logAction } = require("../services/auditLog");
const { userAvatarUrl } = require("../utils/discordAvatar");

const router = express.Router();

const PING_INTERVAL_MS = 25000;
const HISTORY_LIMIT = 100;
const SUPERUSER_RANK = { name: "Süper Yönetici", color: "#ef4444" };
const DEFAULT_RANK = { name: "Yetkili", color: "#9ca3af" };

const chatClients = new Set();

function broadcast(type, data) {
  const payload = `data: ${JSON.stringify({ type, data })}\n\n`;
  for (const client of chatClients) {
    try {
      client.write(payload);
    } catch (err) {}
  }
}

setInterval(() => {
  for (const client of chatClients) {
    try {
      client.write('data: {"type":"ping"}\n\n');
    } catch (err) {}
  }
}, PING_INTERVAL_MS).unref();

// Any staff member (at least one permission) may use the admin chat.
async function requireStaff(req, res, next) {
  if (!req.session.user) {
    return req.path === "/admin/chat/stream"
      ? res.status(401).send("Unauthorized")
      : res.status(401).json({ success: false, message: "Oturum kapalı." });
  }
  const perms = await getUserPermissions(req.session.user);
  if (!hasAnyPermission(perms)) {
    return req.path === "/admin/chat/stream"
      ? res.status(403).send("Forbidden")
      : res.status(403).json({ success: false, message: "Yetki yok." });
  }
  req.perms = perms;
  next();
}

function messageText(req, res) {
  const message = typeof req.body.message === "string" ? req.body.message.trim() : "";
  if (!message) res.status(400).json({ success: false, message: "Mesaj boş olamaz." });
  return message;
}

// Loads a chat message and checks the session user wrote it.
async function ownMessage(req, res, forbiddenMessage) {
  const chatMsg = await AdminChatMessage.findById(req.params.id);
  if (!chatMsg) {
    res.status(404).json({ success: false, message: "Mesaj bulunamadı." });
    return null;
  }
  if (chatMsg.senderId !== req.session.user.id) {
    res.status(403).json({ success: false, message: forbiddenMessage });
    return null;
  }
  return chatMsg;
}

router.get("/admin/chat/stream", requireStaff, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  chatClients.add(res);
  req.on("close", () => chatClients.delete(res));
});

router.post("/admin/chat/send", requireStaff, async (req, res) => {
  const message = messageText(req, res);
  if (!message) return;

  try {
    const userRank = await UserRank.findOne({ discordId: req.session.user.id }).populate("rankId");
    let rank = DEFAULT_RANK;
    if (userRank && userRank.rankId) {
      rank = { name: userRank.rankId.name, color: userRank.rankId.color || "#0071e3" };
    } else if (req.perms.isSuperuser) {
      rank = SUPERUSER_RANK;
    }

    const chatMessage = await new AdminChatMessage({
      senderId: req.session.user.id,
      senderUsername: req.session.user.username,
      senderAvatar: userAvatarUrl({ id: req.session.user.id, avatar: req.session.user.avatar }),
      senderRankName: rank.name,
      senderRankColor: rank.color,
      message
    }).save();

    broadcast("message", chatMessage);
    logAction("chatSend", { executor: actorFrom(req), details: `Gonderilen Mesaj: ${message}`, context: "Admin Sohbeti" });
    res.json({ success: true, message: chatMessage });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/admin/chat/messages", requireStaff, async (req, res) => {
  try {
    const messages = await AdminChatMessage.find().sort({ createdAt: -1 }).limit(HISTORY_LIMIT);
    res.json({ success: true, messages: messages.reverse() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/admin/chat/edit/:id", requireStaff, async (req, res) => {
  const message = messageText(req, res);
  if (!message) return;

  try {
    const chatMsg = await ownMessage(req, res, "Sadece kendi mesajlarınızı düzenleyebilirsiniz.");
    if (!chatMsg) return;

    chatMsg.message = message;
    chatMsg.edited = true;
    await chatMsg.save();

    broadcast("edit", chatMsg);
    logAction("chatEdit", { executor: actorFrom(req), details: `Duzenlenen Mesaj: ${message}`, context: "Admin Sohbeti" });
    res.json({ success: true, message: chatMsg });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/admin/chat/delete/:id", requireStaff, async (req, res) => {
  try {
    const chatMsg = await ownMessage(req, res, "Sadece kendi mesajlarınızı silebilirsiniz.");
    if (!chatMsg) return;

    await AdminChatMessage.findByIdAndDelete(req.params.id);
    broadcast("delete", { id: req.params.id });
    logAction("chatDelete", {
      executor: actorFrom(req),
      details: `Silinen Mesaj Sahibi: ${chatMsg.senderUsername} (ID: ${chatMsg.senderId}). Icerik: ${chatMsg.message}`,
      context: "Admin Sohbeti"
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
