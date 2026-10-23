const { Events } = require("discord.js");
const { createBot, connectDatabase } = require("../botHelper");
const config = require("../../config");
const Rank = require("../../models/Rank");
const UserRank = require("../../models/UserRank");
const DiscordUser = require("../../models/DiscordUser");
const ServerStats = require("../../models/ServerStats");

connectDatabase("Bot 4");

const client = createBot("sync", "Bot 4 (Sync)", config.bots.sync.token);

async function getWhitelistRoleId() {
  try {
    const stats = await ServerStats.findOne();
    if (stats && stats.whitelistRoleId && stats.whitelistRoleId !== "none") {
      return stats.whitelistRoleId.trim();
    }
  } catch (e) {}
  return (config.discord && config.discord.whitelistRoleId) ? config.discord.whitelistRoleId.trim() : null;
}

/**
 * Synchronizes all Discord members with Whitelist role to MongoDB,
 * and sets isWhitelist: false for any user without the role.
 */
async function syncAllWhitelistsNow(guild) {
  if (!guild) return;
  try {
    const wlRoleId = await getWhitelistRoleId();
    if (!wlRoleId) return;

    const wlRole = guild.roles.cache.get(wlRoleId);
    if (!wlRole) return;

    const wlMemberIds = Array.from(wlRole.members.keys());
    const totalWl = wlMemberIds.length;

    // 1. Mark all members with the Discord Whitelist role as isWhitelist: true
    if (wlMemberIds.length > 0) {
      await DiscordUser.updateMany(
        { discordId: { $in: wlMemberIds } },
        { $set: { isWhitelist: true } }
      );

      // Upsert any missing Discord members into the collection
      for (const m of wlRole.members.values()) {
        let avatarUrl = "https://cdn.discordapp.com/embed/avatars/0.png";
        if (m.user.avatar) {
          const isGif = m.user.avatar.startsWith("a_");
          avatarUrl = `https://cdn.discordapp.com/avatars/${m.id}/${m.user.avatar}.${isGif ? "gif" : "png"}`;
        } else {
          const defaultAvatarIndex = Number((BigInt(m.id) >> 22n) % 6n);
          avatarUrl = `https://cdn.discordapp.com/embed/avatars/${defaultAvatarIndex}.png`;
        }

        await DiscordUser.findOneAndUpdate(
          { discordId: m.id },
          {
            $set: {
              username: m.user.username,
              avatarUrl,
              isWhitelist: true
            },
            $setOnInsert: { whitelistAt: new Date() }
          },
          { upsert: true }
        );
      }
    }

    // 2. Mark all users in MongoDB who DO NOT have the Discord Whitelist role as isWhitelist: false
    await DiscordUser.updateMany(
      { discordId: { $nin: wlMemberIds }, isWhitelist: true },
      { $set: { isWhitelist: false, whitelistAt: null } }
    );

    // 3. Update ServerStats
    await ServerStats.updateOne({}, { $set: { totalWhitelist: totalWl } }, { upsert: true });
    console.log(`[Bot 4 - Sync] Whitelist senkronize edildi. Gerçek Whitelist Sayısı: ${totalWl}`);
  } catch (err) {
    console.error("[Bot 4 - Sync] Whitelist sync error:", err.message);
  }
}

// Real-time Event Listener for role updates on Discord
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  try {
    const wlRoleId = await getWhitelistRoleId();
    if (wlRoleId) {
      const hasWl = newMember.roles.cache.has(wlRoleId);
      if (hasWl) {
        await DiscordUser.updateOne(
          { discordId: newMember.id },
          { $set: { isWhitelist: true } }
        );
      } else {
        await DiscordUser.updateOne(
          { discordId: newMember.id },
          { $set: { isWhitelist: false, whitelistAt: null } }
        );
      }
    }

    const ranks = await Rank.find({ discordRoleId: { $ne: "" } });
    if (ranks.length === 0) return;

    // Filter ranks to find which ones are assigned to this member on Discord
    const matchingRanks = ranks.filter(r => newMember.roles.cache.has(r.discordRoleId));

    if (matchingRanks.length > 0) {
      matchingRanks.sort((a, b) => a.order - b.order);
      const targetRank = matchingRanks[0];

      await UserRank.findOneAndUpdate(
        { discordId: newMember.id },
        { username: newMember.user.username, rankId: targetRank._id },
        { upsert: true, new: true }
      );

      let avatarUrl = "https://cdn.discordapp.com/embed/avatars/0.png";
      if (newMember.user.avatar) {
        const isGif = newMember.user.avatar.startsWith("a_");
        avatarUrl = `https://cdn.discordapp.com/avatars/${newMember.id}/${newMember.user.avatar}.${isGif ? "gif" : "png"}`;
      } else {
        const defaultAvatarIndex = Number((BigInt(newMember.id) >> 22n) % 6n);
        avatarUrl = `https://cdn.discordapp.com/embed/avatars/${defaultAvatarIndex}.png`;
      }

      await DiscordUser.findOneAndUpdate(
        { discordId: newMember.id },
        {
          username: newMember.user.username,
          avatarUrl,
          rankId: targetRank._id
        },
        { upsert: true, new: true }
      );
    } else {
      const rankIds = ranks.map(r => r._id);
      await UserRank.updateMany(
        { discordId: newMember.id, rankId: { $in: rankIds } },
        { rankId: null }
      );
      await DiscordUser.updateMany(
        { discordId: newMember.id, rankId: { $in: rankIds } },
        { rankId: null }
      );
    }
  } catch (err) {
    console.error(`[Bot 4 - Sync] Error in guildMemberUpdate listener:`, err.message);
  }
});

// Real-time Event Listener for members leaving the guild
client.on(Events.GuildMemberRemove, async (member) => {
  try {
    const ranks = await Rank.find({ discordRoleId: { $ne: "" } });
    const rankIds = ranks.map(r => r._id);

    await UserRank.updateMany({ discordId: member.id, rankId: { $in: rankIds } }, { rankId: null });
    await DiscordUser.updateMany(
      { discordId: member.id },
      { $set: { rankId: null, isWhitelist: false, whitelistAt: null } }
    );
    console.log(`[Bot 4 - Sync] User ${member.user.username} left the guild. Rank & Whitelist cleared.`);
  } catch (err) {
    console.error(`[Bot 4 - Sync] Error in guildMemberRemove listener:`, err.message);
  }
});

client.once(Events.ClientReady, async () => {
  console.log("[Bot 4 - Sync] Bot is ready. Initializing guild whitelist sync...");
  try {
    const guildId = config.discord.guildId;
    const guild = client.guilds.cache.get(guildId) || client.guilds.cache.first();
    if (guild) {
      await guild.members.fetch().catch(e => console.warn("[Bot 4] Initial members fetch warning:", e.message));
      await syncAllWhitelistsNow(guild);

      // Periodic auto-sync every 60 seconds
      setInterval(() => {
        syncAllWhitelistsNow(guild);
      }, 60000);
    }
  } catch (e) {
    console.error("[Bot 4 - Sync] Initial sync failed:", e.message);
  }
});
