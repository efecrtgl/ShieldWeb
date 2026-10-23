const mongoose = require("mongoose");
const { DiscordBot, DiscordUser, Team, Business, TeamWipe, PunishmentRecord, ServerStats } = require("../models/ServerInfo");
const { takePending, activeProcesses, isConnected } = require("./botRegistry");
const { actorFrom, logAction } = require("./auditLog");
const { fetchDiscordUserProfile } = require("./discordApi");
const { invalidateDiscordStats } = require("./discordStats");
const { wantsJson, isSnowflake } = require("../utils/http");

const MAX_TEAM_MEMBERS = 50;
const UNKNOWN_USER = "Bilinmeyen Kullanıcı";

function clampMaxMembers(value) {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 0 || parsed > MAX_TEAM_MEMBERS) return MAX_TEAM_MEMBERS;
  return parsed;
}

function isRealBossId(bossId) {
  return !!(bossId && bossId.trim() && bossId.trim() !== "none");
}

// Points a boss's DiscordUser record at a team/business, creating the record from the Discord profile if needed.
async function linkBossToGroup(bossDiscordId, field, groupId) {
  if (!isSnowflake(bossDiscordId)) return;
  const existing = await DiscordUser.findOne({ discordId: bossDiscordId });
  if (existing) {
    existing[field] = groupId;
    await existing.save();
    return;
  }
  const profile = await fetchDiscordUserProfile(bossDiscordId);
  await new DiscordUser({
    discordId: bossDiscordId,
    username: profile ? profile.username : UNKNOWN_USER,
    avatarUrl: profile ? profile.avatarUrl : "",
    [field]: groupId
  }).save();
}

function replyOnce(res, body) {
  if (!res.headersSent) res.json(body);
}

const handlers = {
  async GET_DISCORD_LIVE_STATS_RESPONSE(msg) {
    const p = takePending("liveStats", msg.requestId);
    if (!p) return;
    if (msg.success && msg.stats) {
      p.resolve(msg.stats);
    } else {
      p.reject(new Error(msg.error || "Bot stats error"));
    }
  },

  async TOGGLE_VOICE_SUPPORT_RESPONSE(msg) {
    const p = takePending("voiceSupport", msg.requestId);
    if (!p) return;
    const isJson = wantsJson(p.req);
    if (!msg.success) {
      if (isJson) return p.res.json({ success: false, message: msg.error || "Rol değiştirilirken hata oluştu." });
      return p.res.redirect("/admin/dashboard#users-mgmt");
    }
    const userObj = await DiscordUser.findOne({ discordId: msg.discordId });
    const added = msg.action === "added";
    logAction("voiceSupportToggle", {
      executor: actorFrom(p.req),
      target: { id: msg.discordId, username: userObj ? userObj.username : UNKNOWN_USER, data: userObj },
      details: added ? "Kullanıcıya sesli destek rolü verildi." : "Kullanıcının sesli destek rolü kaldırıldı.",
      context: "Web Panel"
    });
    if (isJson) {
      return p.res.json({
        success: true,
        action: msg.action,
        message: added ? "Sesli destek rolü başarıyla verildi!" : "Sesli destek rolü başarıyla kaldırıldı!"
      });
    }
    p.res.redirect("/admin/dashboard#users-mgmt");
  },

  async CREATE_DISCORD_TEAM_RESPONSE(msg) {
    const p = takePending("teams", msg.requestId);
    if (!p) return;
    if (!msg.success) {
      return p.res.json({ success: false, message: msg.error || "Discord üzerinde ekip oluşturulurken hata oluştu." });
    }
    const data = p.data;
    try {
      const maxMembers = clampMaxMembers(data.maxMembers);
      const common = {
        name: data.name,
        color: data.color,
        bossId: data.bossId,
        maxMembers,
        roleId: msg.roleId,
        channelId: msg.channelId,
        createdById: data.createdById,
        createdByUsername: data.createdByUsername
      };

      if (data.isBusinessModel || data.type === "business") {
        const business = await new Business(common).save();
        if (isRealBossId(data.bossId)) {
          await linkBossToGroup(data.bossId.trim(), "businessId", business._id);
        }
        logAction("businessCreate", {
          executor: { id: data.createdById, username: data.createdByUsername, ip: p.req.ip },
          target: { id: business._id.toString(), username: business.name, data: business },
          details: `Yeni işletme ekibi oluşturuldu: ${business.name}`,
          context: "Web Panel"
        });
        return replyOnce(p.res, { success: true, message: "İşletme ekibi başarıyla oluşturuldu.", business });
      }

      const team = await new Team({ ...common, type: data.type }).save();
      if (isRealBossId(data.bossId)) {
        await linkBossToGroup(data.bossId.trim(), "teamId", team._id);
      }
      logAction("teamCreate", {
        executor: { id: data.createdById, username: data.createdByUsername, ip: p.req.ip },
        target: { id: team._id.toString(), username: team.name, data: team },
        details: `Yeni ekip oluşturuldu: ${team.name} (Türü: ${team.type})`,
        context: "Web Panel"
      });
      p.res.json({ success: true, message: "Ekip başarıyla oluşturuldu!" });
    } catch (err) {
      console.error("[Orchestrator] Team create DB error:", err.message);
      replyOnce(p.res, { success: false, message: "Ekip veritabanına kaydedilirken hata oluştu." });
    }
  },

  async DELETE_DISCORD_TEAM_RESPONSE(msg) {
    const p = takePending("teams", msg.requestId);
    if (!p) return;
    if (!msg.success) {
      return p.res.json({ success: false, message: msg.error || "Discord üzerinde ekip silinirken hata oluştu." });
    }
    try {
      const team = await Team.findById(p.data.id);
      logAction("teamDelete", {
        executor: actorFrom(p.req),
        target: { id: p.data.id, username: team ? team.name : "Bilinmeyen Ekip", data: team },
        details: `Ekip silindi: ${team ? team.name : p.data.id}`,
        context: "Web Panel"
      });
      await Team.findByIdAndDelete(p.data.id);
      p.res.json({ success: true, message: "Ekip başarıyla silindi!" });
    } catch (err) {
      console.error("[Orchestrator] Team delete DB error:", err.message);
      p.res.json({ success: false, message: "Ekip veritabanından silinirken hata oluştu." });
    }
  },

  async EDIT_DISCORD_TEAM_RESPONSE(msg) {
    const p = takePending("teams", msg.requestId);
    if (!p) return;
    if (!msg.success) {
      return p.res.json({ success: false, message: msg.error || "Discord üzerinde ekip güncellenirken hata oluştu." });
    }
    const data = p.data;
    try {
      await Team.findByIdAndUpdate(data.id, {
        name: data.name,
        color: data.color,
        bossId: data.bossId,
        maxMembers: clampMaxMembers(data.maxMembers)
      });
      if (isRealBossId(data.bossId)) {
        const bossIds = data.bossId.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
        for (const bossDiscordId of bossIds) {
          await linkBossToGroup(bossDiscordId, "teamId", data.id);
        }
      }
      p.res.json({ success: true, message: "Ekip başarıyla güncellendi!" });
    } catch (err) {
      console.error("[Orchestrator] Team edit DB error:", err.message);
      p.res.json({ success: false, message: "Ekip veritabanında güncellenirken hata oluştu." });
    }
  },

  async TOGGLE_TEAM_VOICE_SUPPORT_RESPONSE(msg) {
    const p = takePending("teams", msg.requestId);
    if (!p) return;
    if (!msg.success) {
      return p.res.json({ success: false, message: msg.error || "Ekip sesli destek rolü değiştirilemedi." });
    }
    try {
      const team = await Team.findById(p.data.id);
      logAction("teamVoiceSupport", {
        executor: actorFrom(p.req),
        target: { id: p.data.id, username: team ? team.name : "Bilinmeyen Ekip", data: team },
        details: "Ekipe ait tüm üyelerin sesli destek durumu güncellendi.",
        context: "Web Panel"
      });
    } catch (err) {
      console.error("[Orchestrator] Team voice support log error:", err.message);
    }
    p.res.json({ success: true, message: msg.message || "Ekip sesli destek rolü başarıyla güncellendi!" });
  },

  async ADD_USER_TO_TEAM_RESPONSE(msg) {
    const p = takePending("teams", msg.requestId);
    if (!p) return;
    if (!msg.success) {
      return p.res.json({ success: false, message: msg.error || "Kullanıcı ekibe eklenirken hata oluştu." });
    }
    const actor = actorFrom(p.req);
    if (p.data.discordId) {
      await DiscordUser.findOneAndUpdate(
        { discordId: p.data.discordId },
        { isWhitelist: true, whitelistAt: new Date() },
        { upsert: true }
      );
      const verificationBot = activeProcesses.verification;
      if (isConnected(verificationBot)) {
        verificationBot.send({
          type: "SYNC_WHITELIST",
          discordId: p.data.discordId,
          isWhitelist: true,
          executorId: actor.id,
          executorUsername: actor.username
        });
      }
    }
    logAction("teamAddMember", {
      executor: actor,
      target: { id: p.data.discordId, username: UNKNOWN_USER },
      details: `Kullanıcı ekibe eklendi ve Whitelist tanımlandı. Ekip: ${p.data.teamName}`,
      context: "Web Panel"
    });
    p.res.json({ success: true, message: "Kullanıcı ekibe eklendi ve Whitelist verildi!" });
  },

  async REMOVE_USER_FROM_TEAM_RESPONSE(msg) {
    const p = takePending("teams", msg.requestId);
    if (!p) return;
    if (!msg.success) {
      return p.res.json({ success: false, message: msg.error || "Kullanıcı ekipten çıkarılırken hata oluştu." });
    }
    logAction("teamRemoveMember", {
      executor: actorFrom(p.req),
      target: { id: p.data.discordId, username: p.data.username, data: p.data.userObj },
      details: `Kullanıcı ekipten çıkarıldı. Ekip: ${p.data.teamName}`,
      context: "Web Panel"
    });
    p.res.json({ success: true, message: "Kullanıcı başarıyla ekipten çıkarıldı!" });
  },

  async BAN_DISCORD_TEAM_RESPONSE(msg) {
    const p = takePending("teams", msg.requestId);
    if (!p) return;
    if (!msg.success) {
      return p.res.json({ success: false, message: msg.error || "Ekip banlanırken hata oluştu." });
    }
    logAction("teamBlacklistAdd", {
      executor: actorFrom(p.req),
      target: { id: p.data.teamId, username: p.data.teamName },
      details: `Ekip kara listeye (blacklist) eklendi ve tüm ${p.data.membersCount} üyenin whitelist yetkileri kaldırıldı.`,
      context: "Web Panel"
    });
    p.res.json({ success: true, message: "Ekip başarıyla banlandı ve tüm üyelerinin whitelist yetkileri kaldırıldı!" });
  },

  async WIPE_TEAM_MEMBERS_RESPONSE(msg) {
    const p = takePending("teams", msg.requestId);
    if (!p) return;
    if (!msg.success) {
      return p.res.json({ success: false, message: msg.error || "Ekip wipe edilirken hata oluştu." });
    }
    const actor = actorFrom(p.req);
    try {
      const snapshot = p.data.membersSnapshot || [];
      const fullMembersData = (msg.savedMemberRoles || []).map(m => {
        const s = snapshot.find(entry => entry.discordId === m.discordId);
        return {
          discordId: m.discordId,
          username: m.username || (s ? s.username : "Bilinmeyen"),
          isWhitelist: s ? s.isWhitelist : true,
          whitelistAt: s && s.whitelistAt ? s.whitelistAt : new Date(),
          addedAt: s && s.addedAt ? s.addedAt : new Date(),
          roles: m.roles || []
        };
      });

      await TeamWipe.updateMany({ teamId: p.data.teamId, restored: false }, { restored: true });
      await TeamWipe.create({ teamId: p.data.teamId, executorUsername: actor.username, members: fullMembersData, restored: false });

      const wipedDiscordIds = fullMembersData.map(m => m.discordId);
      const cleared = { isWhitelist: false, whitelistAt: null, teamId: null };
      if (wipedDiscordIds.length > 0) {
        await DiscordUser.updateMany({ discordId: { $in: wipedDiscordIds } }, cleared);
      }
      await DiscordUser.updateMany({ teamId: p.data.teamId }, cleared);
    } catch (dbErr) {
      console.error("Error saving TeamWipe snapshot or updating members:", dbErr);
    }

    logAction("teamMembersWipe", {
      executor: actor,
      target: { id: p.data.teamId, username: p.data.teamName },
      details: `Ekip üyelerine wipe atıldı. Tüm ${p.data.membersCount} üyenin bütün rolleri kaldırıldı ve kayıtsız rolü tanımlandı.`,
      context: "Web Panel"
    });
    p.res.json({ success: true, message: `Ekip wipe işlemi tamamlandı! Toplam ${p.data.membersCount} üyenin bütün rolleri çekildi ve kayıtsız yapıldı.` });
  },

  async UNWIPE_TEAM_MEMBERS_RESPONSE(msg) {
    const p = takePending("teams", msg.requestId);
    if (!p) return;
    if (!msg.success) {
      return replyOnce(p.res, { success: false, message: msg.error || "Ekip wipe geri alınırken bot hatası oluştu." });
    }
    try {
      const teamIdObj = mongoose.Types.ObjectId.isValid(p.data.teamId)
        ? new mongoose.Types.ObjectId(p.data.teamId.toString())
        : p.data.teamId;

      let wipeRecord = await TeamWipe.findById(p.data.lastWipeId);
      if (!wipeRecord) {
        wipeRecord = await TeamWipe.findOne({ teamId: teamIdObj }).sort({ wipedAt: -1 });
      }

      if (wipeRecord && wipeRecord.members) {
        for (const mData of wipeRecord.members) {
          let user = await DiscordUser.findOne({ discordId: mData.discordId });
          if (!user) {
            user = new DiscordUser({ discordId: mData.discordId, username: mData.username || "Bilinmeyen" });
          }
          user.teamId = teamIdObj;
          user.isWhitelist = mData.isWhitelist !== undefined ? mData.isWhitelist : true;
          user.whitelistAt = mData.whitelistAt || new Date();
          if (mData.addedAt) user.addedAt = mData.addedAt;
          await user.save();
        }
        wipeRecord.restored = true;
        wipeRecord.restoredAt = new Date();
        await wipeRecord.save();
      }

      logAction("teamMembersUnwipe", {
        executor: actorFrom(p.req),
        target: { id: p.data.teamId, username: p.data.teamName },
        details: "Ekip wipe işlemi geri alındı. Tüm üyelerin eski rolleri ve yetkileri geri yüklendi.",
        context: "Web Panel"
      });
      replyOnce(p.res, { success: true, message: "Ekip wipe geriye alma işlemi tamamlandı! Tüm üyelerin eski rolleri ve yetkileri geri yüklendi." });
    } catch (restoreErr) {
      console.error("Unwipe DB restore error:", restoreErr);
      replyOnce(p.res, { success: false, message: "Ekip rolleri geri verilirken veritabanı güncelleme hatası oluştu." });
    }
  },

  async SYNC_ALL_WHITELISTS_RESPONSE(msg) {
    const p = takePending("syncWhitelist", msg.requestId);
    if (!p) return;
    if (!msg.success || !Array.isArray(msg.users)) {
      return p.res.json({ success: false, message: msg.error || "Discord'dan whitelist çekilirken hata oluştu." });
    }
    try {
      let addedCount = 0;
      let updatedCount = 0;
      for (const u of msg.users) {
        const existing = await DiscordUser.findOne({ discordId: u.discordId });
        if (existing) {
          if (!existing.isWhitelist) {
            existing.isWhitelist = true;
            existing.whitelistAt = new Date();
            updatedCount++;
          }
          existing.username = u.username;
          if (u.avatarUrl) existing.avatarUrl = u.avatarUrl;
          await existing.save();
        } else {
          await new DiscordUser({
            discordId: u.discordId,
            username: u.username,
            avatarUrl: u.avatarUrl || "",
            isWhitelist: true,
            whitelistAt: new Date()
          }).save();
          addedCount++;
        }
      }

      // Anyone whitelisted in the DB but missing the Discord whitelist role loses the whitelist.
      const activeDiscordIds = msg.users.map(u => u.discordId);
      const unWlResult = await DiscordUser.updateMany(
        { discordId: { $nin: activeDiscordIds }, isWhitelist: true },
        { $set: { isWhitelist: false, whitelistAt: null } }
      );

      await ServerStats.updateOne({}, { $set: { totalWhitelist: msg.users.length } }, { upsert: true });
      invalidateDiscordStats();

      p.res.json({
        success: true,
        whitelistCount: msg.users.length,
        message: `Whitelist eşitlemesi tamamlandı! Toplam ${msg.users.length} aktif whitelist senkronize edildi (${addedCount} yeni eklendi, ${updatedCount} güncellendi, ${unWlResult.modifiedCount || 0} geçersiz whitelist kaldırıldı).`
      });
    } catch (err) {
      console.error("[Orchestrator] Whitelist sync database save error:", err);
      p.res.json({ success: false, message: "Kullanıcılar veritabanına kaydedilirken hata oluştu." });
    }
  },

  async EXECUTE_BULK_PUNISHMENT_RESPONSE(msg) {
    const p = takePending("punish", msg.requestId);
    if (!p) return;
    if (!msg.success || !Array.isArray(msg.results)) {
      return p.res.json({ success: false, message: msg.error || "Discord üzerinde cezalandırma uygulanırken hata oluştu." });
    }
    const data = p.data;
    try {
      const hasInitiative = data.punishmentNames.some(name => name.includes("İnisiyatif"));
      let updatedCount = 0;

      for (const r of msg.results) {
        if (!r.success) continue;
        const punishmentState = {
          warnings: r.warnings,
          wlCezaBitis: r.wlCezaBitis ? new Date(r.wlCezaBitis) : null,
          isPermaBanned: r.isPermaBanned || false,
          hasTT: r.hasTT || false
        };

        const existing = await DiscordUser.findOne({ discordId: r.discordId });
        if (existing) {
          Object.assign(existing, punishmentState);
          await existing.save();
        } else {
          await new DiscordUser({
            discordId: r.discordId,
            username: r.username || UNKNOWN_USER,
            ...punishmentState,
            isWhitelist: false
          }).save();
        }

        await new PunishmentRecord({
          discordId: r.discordId,
          username: r.username || UNKNOWN_USER,
          punishments: data.punishmentNames,
          warningsAdded: data.warningsAdded,
          wlDaysAdded: data.wlDaysAdded,
          isPerma: data.isPerma,
          executorId: data.executorId,
          executorUsername: data.executorUsername
        }).save();

        logAction(hasInitiative ? "provideInitiative" : "punishmentGive", {
          executor: { id: data.executorId, username: data.executorUsername, ip: p.req.ip },
          target: { id: r.discordId, username: r.username || UNKNOWN_USER },
          details: hasInitiative
            ? `Kullanıcıya inisiyatif sağlanarak ceza uygulandı. Cezalar: ${data.punishmentNames.join(", ")}`
            : `Kullanıcıya ceza uygulandı. Uygulanan cezalar: ${data.punishmentNames.join(", ")}`,
          context: "Web Panel"
        });
        updatedCount++;
      }

      p.res.json({ success: true, message: `Cezalandırma işlemi tamamlandı. İşlem yapılan kullanıcı sayısı: ${updatedCount}` });
    } catch (err) {
      console.error("[Orchestrator] Punishment save to DB error:", err);
      p.res.json({ success: false, message: "Kullanıcılar veritabanına kaydedilirken hata oluştu." });
    }
  },

  async CLEAR_USER_PUNISHMENTS_RESPONSE(msg) {
    const p = takePending("clearPunish", msg.requestId);
    if (!p) return;
    if (!msg.success) {
      return p.res.json({ success: false, message: msg.error || "Discord üzerinde roller temizlenirken hata oluştu." });
    }
    const data = p.data;
    try {
      const existing = await DiscordUser.findOne({ discordId: data.discordId });
      if (existing) {
        Object.assign(existing, { warnings: 0, wlCezaBitis: null, isPermaBanned: false, hasTT: false });
        await existing.save();
      }
      const username = existing ? existing.username : "Affedilen Kullanıcı";
      await new PunishmentRecord({
        discordId: data.discordId,
        username,
        punishments: ["Tüm Cezalar Kaldırıldı / Affedildi"],
        warningsAdded: 0,
        wlDaysAdded: 0,
        isPerma: false,
        executorId: data.executorId,
        executorUsername: data.executorUsername
      }).save();

      logAction("punishmentRemove", {
        executor: { id: data.executorId, username: data.executorUsername, ip: p.req.ip },
        target: { id: data.discordId, username, data: existing },
        details: "Kullanıcının tüm cezaları ve kısıtlamaları kaldırıldı.",
        context: "Web Panel"
      });
      p.res.json({ success: true, message: "Kullanıcının aktif cezaları başarıyla temizlendi, roller güncellendi ve sicile işlendi." });
    } catch (err) {
      console.error("[Orchestrator] Clear punishments DB error:", err.message);
      p.res.json({ success: false, message: "Cezalar temizlenirken veritabanı hatası oluştu." });
    }
  },

  async GET_DISCORD_BANS_RESPONSE(msg) {
    const p = takePending("bans", msg.requestId);
    if (!p) return;
    p.res.json({ success: msg.success, bans: msg.bans || [], error: msg.error });
  }
};

// Entry point for every IPC message coming from a bot process.
async function handleBotMessage(botId, msg) {
  if (!msg || !msg.type) return;
  try {
    if (msg.type === "BOT_READY") {
      await DiscordBot.findOneAndUpdate({ botId }, { clientId: msg.clientId });
      return;
    }
    const handler = handlers[msg.type];
    if (handler) await handler(msg);
  } catch (err) {
    console.error(`[Orchestrator] Failed to handle ${msg.type} from ${botId}:`, err);
  }
}

module.exports = { handleBotMessage };
