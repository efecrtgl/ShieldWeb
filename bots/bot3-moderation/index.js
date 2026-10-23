const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  ChannelType,
  PermissionFlagsBits
} = require("discord.js");
const { createBot, connectDatabase } = require("../botHelper");
const config = require("../../config");
const DiscordUser = require("../../models/DiscordUser");
const ServerStats = require("../../models/ServerStats");
const ActionLog = require("../../models/ActionLog");
const Team = require("../../models/Team");
const Business = require("../../models/Business");
const { textToLetterEmojis, common } = require("../emojis");
const { defaultAvatarUrl } = require("../../utils/discordAvatar");

async function getGuild(client) {
  try {
    const stats = await ServerStats.findOne();
    if (stats && stats.guildId) {
      const g = client.guilds.cache.get(stats.guildId) || await client.guilds.fetch(stats.guildId).catch(() => null);
      if (g) return g;
    }
  } catch (e) { }
  const targetGuildId = config.discord.guildId;
  return client.guilds.cache.get(targetGuildId)
    || await client.guilds.fetch(targetGuildId).catch(() => null)
    || client.guilds.cache.first();
}

connectDatabase("Bot 3");

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Safely processes a batch of member IDs with delays and retry logic to strictly prevent
 * Discord API rate limit drops and ensure no roles (whitelist, team roles, etc.) are missed.
 */
async function processBatchWithDelay(items, processorFn, delayMs = 350, maxRetries = 3) {
  if (!Array.isArray(items) || items.length === 0) return { success: 0, failed: 0 };
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let attempts = 0;
    let success = false;

    while (attempts < maxRetries && !success) {
      attempts++;
      try {
        await processorFn(item, i);
        success = true;
        successCount++;
      } catch (err) {
        console.warn(`[Bot 3 Rate-Limit Shield] ${i + 1}/${items.length} attempt ${attempts}/${maxRetries} failed for item ${item}: ${err.message}`);
        if (attempts < maxRetries) {
          await delay(delayMs * (attempts + 1));
        } else {
          failCount++;
        }
      }
    }

    if (i < items.length - 1) {
      await delay(delayMs);
    }
  }

  return { success: successCount, failed: failCount };
}

function createV2Response(title, details, isSuccess = true) {
  const emoji = isSuccess ? common.yes : common.no;
  const color = isSuccess ? 0x10B981 : 0xEF4444;

  const letteredTitle = textToLetterEmojis(title);

  const container = new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`${emoji} ${letteredTitle}`),
      new TextDisplayBuilder().setContent(details)
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`*${config.footer || "Developed by realflexd & kai7m"}*`)
    );

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container]
  };
}

async function safeSetNickname(member, baseName, suffix = "") {
  if (!member || !member.manageable) return;
  const cleanBase = (baseName || member.user?.username || "").split(" | ")[0].trim();
  let fullNick = suffix ? `${cleanBase} | ${suffix}` : cleanBase;
  if (fullNick.length > 32) {
    const maxBaseLen = Math.max(1, 32 - (suffix ? suffix.length + 3 : 0));
    fullNick = suffix ? `${cleanBase.slice(0, maxBaseLen)} | ${suffix}` : cleanBase.slice(0, 32);
  }
  try {
    await member.setNickname(fullNick);
  } catch (err) {
    // Ignore permission/form errors gracefully
  }
}

const moderationClient = createBot("moderation", "Bot 3 (Moderation)", config.bots.moderation.token, {
  onMessage: async (msg, client) => {
    if (msg.type === "CREATE_DISCORD_TEAM") {
      const { name, color, bossId, teamType, illegalCategoryId, legalCategoryId, businessCategoryId, bossRoleId, highCommandRoleId, executorId, executorUsername, requestId } = msg;
      console.log(`[Bot 3] IPC Received - CREATE_DISCORD_TEAM for ${name}`);
      console.log(`[Bot 3] Parameters: teamType=${teamType}, bossId=${bossId}, color=${color}, categoryIds: illegal=${illegalCategoryId}, legal=${legalCategoryId}, business=${businessCategoryId}`);

      try {
        console.log(`[Bot 3] Fetching guild: ${config.discord.guildId}`);
        const guild = await getGuild(client);
        if (!guild) {
          console.error(`[Bot 3] Guild not found in cache! Cache size: ${client.guilds.cache.size}`);
          throw new Error("Sunucu bulunamadi.");
        }
        console.log(`[Bot 3] Guild found: ${guild.name}`);

        console.log(`[Bot 3] Creating role: ${name} with color ${color}`);
        const teamRole = await guild.roles.create({
          name: name,
          color: color || "#3b82f6",
          reason: `Ekip Olusturuldu: ${name}`
        });
        console.log(`[Bot 3] Role created successfully with ID: ${teamRole.id}`);

        let member = null;
        if (bossId && bossId !== "none" && /^\d{17,20}$/.test(bossId)) {
          console.log(`[Bot 3] Fetching member bossId: ${bossId}`);
          member = await guild.members.fetch(bossId).catch(err => {
            console.error(`[Bot 3] Failed to fetch member ${bossId}:`, err.message);
            return null;
          });
        } else {
          console.log(`[Bot 3] No valid bossId provided (${bossId}), skipping member fetch.`);
        }

        if (member) {
          console.log(`[Bot 3] Member found: ${member.user.tag}. Adding team role: ${teamRole.id}`);
          await member.roles.add(teamRole.id).catch(() => { });
          console.log(`[Bot 3] Team role added.`);

          if (teamType === "illegal") {
            const effectiveWlRole = config.discord.whitelistRoleId;
            if (effectiveWlRole && effectiveWlRole !== "none") {
              await member.roles.add(effectiveWlRole).catch(err => console.error(`[Bot 3] Whitelist role add error:`, err.message));
            }
            const illegalBirimRoleId = config.discord.illegalBirimRoleId;
            if (illegalBirimRoleId && illegalBirimRoleId !== "none") {
              await member.roles.add(illegalBirimRoleId).catch(err => console.error(`[Bot 3] Illegal Birim role add error:`, err.message));
            }
          }

          const bossRoleVal = teamType === "illegal" ? bossRoleId : (teamType === "legal" ? highCommandRoleId : null);
          if (bossRoleVal && bossRoleVal !== "none") {
            const bossRoleObj = guild.roles.cache.get(bossRoleVal);
            if (bossRoleObj) {
              console.log(`[Bot 3] Found Boss role object. Assigning...`);
              await member.roles.add(bossRoleVal).catch(() => { });
              console.log(`[Bot 3] Boss role assigned.`);
            } else {
              console.warn(`[Bot 3] Boss role ${bossRoleVal} not found in guild cache!`);
            }
          }
        } else if (bossId && bossId !== "none") {
          console.warn(`[Bot 3] Member with bossId ${bossId} not found in guild. Skipping role assignment.`);
        }

        const stats = await ServerStats.findOne();
        let categoryId;
        if (teamType === "illegal") {
          categoryId = (illegalCategoryId && illegalCategoryId !== "none") ? illegalCategoryId : (stats?.illegalCategoryId || config.discord.illegalCategoryId);
        } else if (teamType === "business") {
          categoryId = (businessCategoryId && businessCategoryId !== "none") ? businessCategoryId : (stats?.businessCategoryId || config.discord.businessCategoryId);
        } else {
          categoryId = (legalCategoryId && legalCategoryId !== "none") ? legalCategoryId : (stats?.legalCategoryId || config.discord.legalCategoryId);
        }

        console.log(`[Bot 3] Category ID for channel: ${categoryId}`);
        let parentCategory = null;
        if (categoryId && categoryId !== "none" && /^\d{17,20}$/.test(String(categoryId).trim())) {
          parentCategory = guild.channels.cache.get(String(categoryId).trim()) || await guild.channels.fetch(String(categoryId).trim()).catch(() => null);
        }
        if (parentCategory && parentCategory.type === ChannelType.GuildCategory) {
          console.log(`[Bot 3] Parent category found: ${parentCategory.name} (${parentCategory.id})`);
        } else {
          console.log(`[Bot 3] Parent category not found or invalid: ${categoryId}`);
          parentCategory = null;
        }

        let cleanChannelName = name
          .toLowerCase()
          .replace(/ğ/g, "g")
          .replace(/ü/g, "u")
          .replace(/ş/g, "s")
          .replace(/ı/g, "i")
          .replace(/ö/g, "o")
          .replace(/ç/g, "c")
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-_]/g, "");
        if (!cleanChannelName) {
          cleanChannelName = `ekip-${Date.now().toString().slice(-4)}`;
        }
        console.log(`[Bot 3] Clean channel name: ${cleanChannelName}`);

        const staffRoleVal = stats?.staffRoleId || config.discord.staffRoleId || config.discord.whitelistRoleId;
        console.log(`[Bot 3] Staff role ID: ${staffRoleVal}`);

        const typeLabel = teamType === "illegal" ? "Ekip" : (teamType === "business" ? "İşletme" : "Departman");

        const overwrites = [
          {
            id: guild.id,
            deny: [PermissionFlagsBits.ViewChannel]
          },
          {
            id: teamRole.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
          }
        ];

        if (staffRoleVal && staffRoleVal !== "none" && guild.roles.cache.has(staffRoleVal)) {
          overwrites.push({
            id: staffRoleVal,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
          });
        }

        console.log(`[Bot 3] Creating channel under category: ${parentCategory ? parentCategory.name : 'root'}`);
        const channelOptions = {
          name: cleanChannelName,
          type: ChannelType.GuildText,
          permissionOverwrites: overwrites,
          reason: `Ekip Kanali Olusturuldu: ${name}`
        };
        if (parentCategory) {
          channelOptions.parent = parentCategory.id;
        }
        const teamChannel = await guild.channels.create(channelOptions);
        console.log(`[Bot 3] Channel created successfully with ID: ${teamChannel.id}`);

        const bossMentionStr = (bossId && bossId !== "none" && /^\d{17,20}$/.test(bossId)) ? `<@${bossId}>` : "Atanmadı (Henüz Yok)";
        const detailsMarkdown = `### ${common.passed} ${typeLabel} Kurulumu Tamamlandı

${common.member} **Yönetici:** ${bossMentionStr}
${common.admin} **Oluşturan Yetkili:** <@${executorId}>
${common.activity} **Tarih:** ${new Date().toLocaleString("tr-TR")}
${common.preview} **Detaylar:**
${common.arrow} ${typeLabel} Rolü: <@&${teamRole.id}>
${common.arrow} ${typeLabel} Kanalı: <#${teamChannel.id}>
${common.arrow} ${typeLabel} Rengi: \`${color}\``;

        console.log(`[Bot 3] Sending V2 welcome response inside team channel`);
        const responseTypeKey = teamType === "illegal" ? "EKIPOLUSTURULDU" : (teamType === "business" ? "ISLETMEOLUSTURULDU" : "DEPARTMANOLUSTURULDU");
        const embedResponse = createV2Response(
          responseTypeKey,
          detailsMarkdown,
          true
        );
        await teamChannel.send(embedResponse);
        console.log(`[Bot 3] Welcome message sent.`);

        console.log(`[Bot 3] Saving action log to MongoDB`);
        const log = new ActionLog({
          executorId,
          executorUsername,
          targetId: bossId,
          targetUsername: member ? member.user.username : "Bilinmeyen Boss",
          actionType: teamType === "illegal" ? "team_create" : "department_create",
          details: `Discord uzerinde ${name} isimli ${teamType === "illegal" ? "ekip" : "departman"} olusturuldu.`
        });
        await log.save();
        console.log(`[Bot 3] ActionLog saved.`);

        if (process.send) {
          console.log(`[Bot 3] Sending CREATE_DISCORD_TEAM_RESPONSE success to orchestrator`);
          process.send({
            type: "CREATE_DISCORD_TEAM_RESPONSE",
            requestId,
            success: true,
            roleId: teamRole.id,
            channelId: teamChannel.id
          });
        }
      } catch (err) {
        console.error(`[Bot 3] CREATE_DISCORD_TEAM failed:`, err);
        if (process.send) {
          process.send({
            type: "CREATE_DISCORD_TEAM_RESPONSE",
            requestId,
            success: false,
            error: err.message
          });
        }
      }
    }

    if (msg.type === "DELETE_DISCORD_TEAM") {
      const { roleId, channelId, teamName, executorId, executorUsername, requestId } = msg;
      console.log(`[Bot 3] IPC Received - DELETE_DISCORD_TEAM for roleId=${roleId}, channelId=${channelId}, teamName=${teamName}`);

      try {
        const guild = await getGuild(client);
        if (!guild) throw new Error("Sunucu bulunamadi.");

        let roleToDelete = null;
        if (roleId) {
          roleToDelete = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
        }

        if (!roleToDelete && teamName) {
          const allRoles = await guild.roles.fetch().catch(() => null);
          if (allRoles) {
            roleToDelete = allRoles.find(r => r.name.toLowerCase().trim() === teamName.toLowerCase().trim());
          }
        }

        if (roleToDelete) {
          console.log(`[Bot 3] Deleting Discord role: ${roleToDelete.name} (${roleToDelete.id})`);
          await roleToDelete.delete(`Ekip silindi. Yetkili: ${executorUsername}`).catch(e => console.error(`[Bot 3] Role delete error:`, e.message));
        } else {
          console.warn(`[Bot 3] Role not found for roleId: ${roleId} or teamName: ${teamName}`);
        }

        let channelToDelete = null;
        if (channelId) {
          channelToDelete = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
        }

        if (!channelToDelete && teamName) {
          const cleanChannelName = teamName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-_]/g, "");
          const allChannels = await guild.channels.fetch().catch(() => null);
          if (allChannels) {
            channelToDelete = allChannels.find(c => c.name.toLowerCase() === cleanChannelName);
          }
        }

        if (channelToDelete) {
          console.log(`[Bot 3] Deleting Discord channel: ${channelToDelete.name} (${channelToDelete.id})`);
          await channelToDelete.delete(`Ekip silindi. Yetkili: ${executorUsername}`).catch(e => console.error(`[Bot 3] Channel delete error:`, e.message));
        }

        const log = new ActionLog({
          executorId,
          executorUsername,
          targetId: "system",
          targetUsername: "System",
          actionType: "team_delete",
          details: `Discord uzerinden roleId: ${roleId} ve channelId: ${channelId} olan ekip silindi.`
        });
        await log.save();

        if (process.send) {
          process.send({
            type: "DELETE_DISCORD_TEAM_RESPONSE",
            requestId,
            success: true
          });
        }
      } catch (err) {
        console.error(`[Bot 3] IPC Delete Team failed:`, err.message);
        if (process.send) {
          process.send({
            type: "DELETE_DISCORD_TEAM_RESPONSE",
            requestId,
            success: false,
            error: err.message
          });
        }
      }
    }

    if (msg.type === "EDIT_DISCORD_TEAM") {
      const { name, color, bossId, oldBossId, roleId, channelId, teamType, bossRoleId, highCommandRoleId, executorId, executorUsername, requestId } = msg;
      console.log(`[Bot 3] IPC Received - EDIT_DISCORD_TEAM for ${name}`);

      try {
        const guild = await getGuild(client);
        if (!guild) throw new Error("Sunucu bulunamadi.");

        if (roleId) {
          const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
          if (role) {
            await role.edit({
              name: name,
              colors: { primaryColor: color },
              reason: `Ekip duzenlendi (Isim: ${name}). Yetkili: ${executorUsername}`
            });
            console.log(`[Bot 3] Discord rol ismi '${name}' olarak guncellendi (ID: ${roleId}).`);
          }
        }

        if (channelId) {
          const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
          if (channel) {
            const trMap = { 'ç': 'c', 'Ç': 'c', 'ğ': 'g', 'Ğ': 'g', 'ı': 'i', 'I': 'i', 'İ': 'i', 'ö': 'o', 'Ö': 'o', 'ş': 's', 'Ş': 's', 'ü': 'u', 'Ü': 'u' };
            let cleanChannelName = name.replace(/[çÇğĞıIİöÖşŞüÜ]/g, m => trMap[m] || m)
              .toLowerCase()
              .trim()
              .replace(/\s+/g, "-")
              .replace(/[^a-z0-9-_]/g, "");
            if (!cleanChannelName) cleanChannelName = "ekip";

            await channel.edit({
              name: cleanChannelName,
              reason: `Ekip duzenlendi (Kanal: ${cleanChannelName}). Yetkili: ${executorUsername}`
            });
            console.log(`[Bot 3] Discord kanal ismi '${cleanChannelName}' olarak guncellendi (ID: ${channelId}).`);
          }
        }

        if (bossId !== oldBossId) {
          const bossRoleVal = teamType === "illegal" ? bossRoleId : highCommandRoleId;
          if (bossRoleVal && bossRoleVal !== "none") {
            const bossRoleObj = guild.roles.cache.get(bossRoleVal);
            if (bossRoleObj) {
              if (oldBossId) {
                const oldBossMember = await guild.members.fetch(oldBossId).catch(() => null);
                if (oldBossMember) {
                  await oldBossMember.roles.remove(bossRoleVal);
                }
              }
              const newBossMember = await guild.members.fetch(bossId).catch(() => null);
              if (newBossMember) {
                await newBossMember.roles.add(bossRoleVal);
                if (roleId) {
                  await newBossMember.roles.add(roleId);
                }
              }
            }
          }
        } else {
          if (bossId) {
            const newBossMember = await guild.members.fetch(bossId).catch(() => null);
            if (newBossMember && roleId) {
              await newBossMember.roles.add(roleId);
            }
          }
        }

        const log = new ActionLog({
          executorId,
          executorUsername,
          targetId: bossId,
          targetUsername: "Team Boss",
          actionType: teamType === "illegal" ? "team_edit" : "department_edit",
          details: `Discord uzerinde ${name} isimli ekip duzenlendi.`
        });
        await log.save();

        if (process.send) {
          process.send({
            type: "EDIT_DISCORD_TEAM_RESPONSE",
            requestId,
            success: true
          });
        }
      } catch (err) {
        console.error(`[Bot 3] IPC Edit Team failed:`, err.message);
        if (process.send) {
          process.send({
            type: "EDIT_DISCORD_TEAM_RESPONSE",
            requestId,
            success: false,
            error: err.message
          });
        }
      }
    }

    if (msg.type === "TOGGLE_TEAM_VOICE_SUPPORT") {
      const { roleId, voiceSupportRoleId, executorId, executorUsername, requestId } = msg;
      console.log(`[Bot 3] IPC Received - TOGGLE_TEAM_VOICE_SUPPORT for role ${roleId}`);

      try {
        const guild = await getGuild(client);
        if (!guild) throw new Error("Sunucu bulunamadi.");

        if (!roleId) throw new Error("Ekip rolü bulunamadı.");
        if (!voiceSupportRoleId || voiceSupportRoleId === "none") throw new Error("Sesli destek rolü ayarlanmamış.");

        const vsRole = guild.roles.cache.get(voiceSupportRoleId) || await guild.roles.fetch(voiceSupportRoleId).catch(() => null);
        if (!vsRole) {
          throw new Error("Sesli destek rolü Discord sunucusunda bulunamadı. Lütfen Geliştirici Ayarlarından Sesli Destek Rol ID'sini kontrol edin.");
        }

        const teamRole = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
        if (!teamRole) throw new Error("Ekip rolü Discord sunucusunda bulunamadı.");

        await guild.members.fetch().catch(() => null);
        const teamMembers = Array.from(teamRole.members.values());
        if (teamMembers.length === 0) {
          throw new Error("Bu ekibin rolüne sahip hiçbir üye sunucuda bulunamadı.");
        }

        const hasAnyWithoutSupport = teamMembers.some(m => !m.roles.cache.has(voiceSupportRoleId));
        let action = "";

        if (hasAnyWithoutSupport) {
          for (const m of teamMembers) {
            if (!m.roles.cache.has(voiceSupportRoleId)) {
              await m.roles.add(voiceSupportRoleId).catch(e => console.error(`[Bot 3] Add voice support role error for ${m.user.username}: ${e.message}`));
              await new Promise(r => setTimeout(r, 150));
            }
          }
          action = "verildi";
        } else {
          for (const m of teamMembers) {
            if (m.roles.cache.has(voiceSupportRoleId)) {
              await m.roles.remove(voiceSupportRoleId).catch(e => console.error(`[Bot 3] Remove voice support role error for ${m.user.username}: ${e.message}`));
              await new Promise(r => setTimeout(r, 150));
            }
          }
          action = "kaldırıldı";
        }

        const log = new ActionLog({
          executorId,
          executorUsername,
          targetId: "system",
          targetUsername: "System",
          actionType: "team_voice_support_toggle",
          details: `Discord uzerinde roleId: ${roleId} olan ekibin tüm üyelerine sesli destek rolü toplu olarak ${action}.`
        });
        await log.save();

        if (process.send) {
          process.send({
            type: "TOGGLE_TEAM_VOICE_SUPPORT_RESPONSE",
            requestId,
            success: true,
            message: `Ekip üyelerine sesli destek rolü başarıyla ${action}!`
          });
        }
      } catch (err) {
        console.error(`[Bot 3] IPC Toggle Team Voice Support failed:`, err.message);
        if (process.send) {
          process.send({
            type: "TOGGLE_TEAM_VOICE_SUPPORT_RESPONSE",
            requestId,
            success: false,
            error: err.message
          });
        }
      }
    }

    if (msg.type === "SYNC_ALL_WHITELISTS") {
      const { whitelistRoleId, executorId, executorUsername, requestId } = msg;
      console.log(`[Bot 3] IPC Received - SYNC_ALL_WHITELISTS for role ${whitelistRoleId}`);

      try {
        const guild = await getGuild(client);
        if (!guild) throw new Error("Sunucu bulunamadi.");

        if (!whitelistRoleId || whitelistRoleId === "none") {
          throw new Error("Whitelist rolü ayarlanmamış.");
        }

        const whitelistRole = guild.roles.cache.get(whitelistRoleId);
        if (!whitelistRole) throw new Error("Whitelist rolü sunucuda bulunamadı.");

        await guild.members.fetch();
        const wlMembers = Array.from(whitelistRole.members.values());

        const usersList = wlMembers.map(m => ({
          discordId: m.user.id,
          username: m.user.username,
          avatarUrl: m.user.avatar ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png` : defaultAvatarUrl(m.user.id)
        }));

        const log = new ActionLog({
          executorId,
          executorUsername,
          targetId: "system",
          targetUsername: "System",
          actionType: "whitelist_sync_pull",
          details: `Discord uzerindeki whitelist rolüne sahip tüm kullanıcılar başarıyla içe aktarıldı (Adet: ${usersList.length}).`
        });
        await log.save();

        if (process.send) {
          process.send({
            type: "SYNC_ALL_WHITELISTS_RESPONSE",
            requestId,
            success: true,
            users: usersList
          });
        }
      } catch (err) {
        console.error(`[Bot 3] IPC Sync Whitelists failed:`, err.message);
        if (process.send) {
          process.send({
            type: "SYNC_ALL_WHITELISTS_RESPONSE",
            requestId,
            success: false,
            error: err.message
          });
        }
      }
    }

    if (msg.type === "EXECUTE_BULK_PUNISHMENT") {
      const { discordIds, punishments, warningsAdded, wlDaysAdded, isPerma, isTT, characterApprovalRoleId, wlPunishedRoleId, warning1RoleId, warning2RoleId, warning3RoleId, warning4RoleId, warning5RoleId, warning6RoleId, warning7RoleId, warning8RoleId, warning9RoleId, executorId, executorUsername, requestId } = msg;
      console.log(`[Bot 3] IPC Received - EXECUTE_BULK_PUNISHMENT for ${discordIds.length} users`);

      const effectiveWlPunishedRoleId = (wlPunishedRoleId && wlPunishedRoleId !== "none") ? wlPunishedRoleId : config.discord.wlPunishedRoleId;

      try {
        const guild = await getGuild(client);
        if (!guild) throw new Error("Sunucu bulunamadi.");

        const results = [];

        for (const dId of discordIds) {
          try {
            let currentWarnings = 0;
            let currentWlCezaBitis = null;
            let currentHasTT = false;
            let currentUsername = "Bilinmeyen Kullanıcı";

            const dbUser = await DiscordUser.findOne({ discordId: dId });
            if (dbUser) {
              currentWarnings = dbUser.warnings || 0;
              currentWlCezaBitis = dbUser.wlCezaBitis || null;
              currentHasTT = dbUser.hasTT || false;
              currentUsername = dbUser.username;
            }

            const member = await guild.members.fetch(dId).catch(() => null);
            if (member) {
              currentUsername = member.user.username;
            }

            let newWarnings = currentWarnings;
            let newWlCezaBitis = currentWlCezaBitis ? new Date(currentWlCezaBitis) : null;
            let finalIsPerma = isPerma;
            let finalHasTT = currentHasTT;

            if (dbUser && dbUser.isPermaBanned) {
              finalIsPerma = true;
            }

            if (finalIsPerma) {
              newWarnings = 0;
              newWlCezaBitis = new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);

              if (member) {
                const baseNickname = (member.nickname || member.user.username || "").split(" | ")[0];
                await safeSetNickname(member, baseNickname, "PERMA CEZALI");

                const rolesToRemove = [characterApprovalRoleId, warning1RoleId, warning2RoleId, warning3RoleId, warning4RoleId, warning5RoleId, warning6RoleId, warning7RoleId, warning8RoleId, warning9RoleId].filter(r => r && r !== "none");
                for (const rId of rolesToRemove) {
                  await member.roles.remove(rId).catch(err => console.error(`[Bot 3] Failed to remove role ${rId}: ${err.message}`));
                }

                const rolesToAdd = [effectiveWlPunishedRoleId].filter(r => r && r !== "none");
                for (const rId of rolesToAdd) {
                  await member.roles.add(rId).catch(err => console.error(`[Bot 3] Failed to add role ${rId}: ${err.message}`));
                }
              }
            } else {
              let totalWlDaysToApply = wlDaysAdded;
              let addedWarningsToCalculate = warningsAdded;

              if (isTT) {
                if (currentHasTT) {
                  totalWlDaysToApply += 7;
                } else {
                  totalWlDaysToApply += 1;
                  finalHasTT = true;
                }
              }

              newWarnings += addedWarningsToCalculate;
              if (newWarnings < 0) {
                newWarnings = 0;
              }

              if (newWarnings >= 10) {
                let warningWlDays = 0;
                if (newWarnings === 10) warningWlDays = 1;
                else if (newWarnings === 11) warningWlDays = 2;
                else if (newWarnings === 12) warningWlDays = 3;
                else if (newWarnings === 13) warningWlDays = 4;
                else warningWlDays = 5 + (newWarnings - 14);

                totalWlDaysToApply += warningWlDays;
                newWarnings = 0;
              }

              if (totalWlDaysToApply > 0) {
                const now = new Date();
                let baseDate = now;
                if (newWlCezaBitis && newWlCezaBitis > now) {
                  baseDate = newWlCezaBitis;
                }
                newWlCezaBitis = new Date(baseDate.getTime() + totalWlDaysToApply * 24 * 60 * 60 * 1000);

                if (member) {
                  const baseNickname = (member.nickname || member.user.username || "").split(" | ")[0];
                  const dStr = String(newWlCezaBitis.getDate()).padStart(2, '0');
                  const mStr = String(newWlCezaBitis.getMonth() + 1).padStart(2, '0');
                  const yStr = newWlCezaBitis.getFullYear();
                  const hStr = String(newWlCezaBitis.getHours()).padStart(2, '0');
                  const minStr = String(newWlCezaBitis.getMinutes()).padStart(2, '0');
                  const dateFormatted = `${dStr}.${mStr}.${yStr} - ${hStr}:${minStr}`;

                  await safeSetNickname(member, baseNickname, dateFormatted);

                  const rolesToRemove = [characterApprovalRoleId].filter(r => r && r !== "none");
                  for (const rId of rolesToRemove) {
                    await member.roles.remove(rId).catch(err => console.error(`[Bot 3] Failed to remove role ${rId}: ${err.message}`));
                  }

                  const rolesToAdd = [effectiveWlPunishedRoleId].filter(r => r && r !== "none");
                  for (const rId of rolesToAdd) {
                    await member.roles.add(rId).catch(err => console.error(`[Bot 3] Failed to add role ${rId}: ${err.message}`));
                  }
                }
              }

              if (member) {
                const warningRoles = [
                  warning1RoleId, warning2RoleId, warning3RoleId,
                  warning4RoleId, warning5RoleId, warning6RoleId,
                  warning7RoleId, warning8RoleId, warning9RoleId
                ];
                for (let w = 1; w <= 9; w++) {
                  const roleId = warningRoles[w - 1];
                  if (roleId && roleId !== "none") {
                    if (newWarnings === w) {
                      await member.roles.add(roleId).catch(() => null);
                    } else {
                      await member.roles.remove(roleId).catch(() => null);
                    }
                  }
                }
              }
            }

            // DB updates are handled by the Web Server upon receiving the EXECUTE_BULK_PUNISHMENT_RESPONSE

            // Dispatch notification to Warning / Penalty Channel
            try {
              let warningChannelId = msg.punishmentLogChannelId;
              if (!warningChannelId || warningChannelId === "none") {
                try {
                  const statsDoc = await ServerStats.findOne();
                  if (statsDoc && statsDoc.punishmentLogChannelId && statsDoc.punishmentLogChannelId !== "none") {
                    warningChannelId = statsDoc.punishmentLogChannelId;
                  }
                } catch (e) { }
              }
              if (!warningChannelId || warningChannelId === "none") {
                warningChannelId = config.discord.punishmentLogChannelId;
              }

              const warningChan = client.channels.cache.get(warningChannelId) || await client.channels.fetch(warningChannelId).catch(() => null);
              if (warningChan) {
                const complainantTag = (msg.complainant && /^\d{17,20}$/.test(String(msg.complainant).trim()))
                  ? `<@${String(msg.complainant).trim()}>`
                  : (msg.complainant && String(msg.complainant).trim() !== "" ? String(msg.complainant).trim() : "Yok / Belirtilmedi");

                const executorMention = (executorId && /^\d{17,20}$/.test(String(executorId).trim()))
                  ? `<@${String(executorId).trim()}>`
                  : (executorUsername || "Yönetim");

                const reasonText = (punishments && punishments.length > 0)
                  ? punishments.map(p => p.name).filter(Boolean).join(", ")
                  : "Belirtilmedi";

                let expiryText = "Yok (Yalnızca Uyarı)";
                if (finalIsPerma) {
                  expiryText = "Kalıcı (Perma Ban)";
                } else if (newWlCezaBitis && newWlCezaBitis > new Date()) {
                  const dStr = String(newWlCezaBitis.getDate()).padStart(2, '0');
                  const mStr = String(newWlCezaBitis.getMonth() + 1).padStart(2, '0');
                  const yStr = newWlCezaBitis.getFullYear();
                  const hStr = String(newWlCezaBitis.getHours()).padStart(2, '0');
                  const minStr = String(newWlCezaBitis.getMinutes()).padStart(2, '0');
                  expiryText = `${dStr}.${mStr}.${yStr} - ${hStr}:${minStr}`;
                }

                const noticeMessage = `**Uyarı Veren Yetkili:** ${executorMention}\n` +
                  `**Ceza Alan Kişi:** <@${dId}>\n` +
                  `**Şikayetçi Taraf:** ${complainantTag}\n` +
                  `**Verilen Cezanın Sebebi:** ${reasonText}\n` +
                  `**Cezanın Biteceği Süre:** ${expiryText}`;

                await warningChan.send({ content: noticeMessage });
                console.log(`[Bot 3] Uyarı kanalı (${warningChannelId}) bildirimi gönderildi: ${dId}`);
              }
            } catch (errNotice) {
              console.warn(`[Bot 3] Warning channel dispatch error:`, errNotice.message);
            }

            results.push({
              discordId: dId,
              username: currentUsername,
              success: true,
              warnings: newWarnings,
              wlCezaBitis: newWlCezaBitis ? newWlCezaBitis.toISOString() : null,
              isPermaBanned: finalIsPerma,
              hasTT: finalHasTT
            });

          } catch (errInner) {
            console.error(`[Bot 3] Punishment failed for user ${dId}:`, errInner.message);
            results.push({
              discordId: dId,
              success: false,
              error: errInner.message
            });
          }
        }

        if (process.send) {
          process.send({
            type: "EXECUTE_BULK_PUNISHMENT_RESPONSE",
            requestId,
            success: true,
            results
          });
        }
      } catch (err) {
        console.error(`[Bot 3] EXECUTE_BULK_PUNISHMENT failed:`, err.message);
        if (process.send) {
          process.send({
            type: "EXECUTE_BULK_PUNISHMENT_RESPONSE",
            requestId,
            success: false,
            error: err.message
          });
        }
      }
    }

    if (msg.type === "GET_DISCORD_BANS") {
      try {
        const guild = await getGuild(client);
        if (!guild) {
          if (process.send) process.send({ type: "GET_DISCORD_BANS_RESPONSE", requestId: msg.requestId, success: false, bans: [], error: "Sunucu bulunamadı" });
          return;
        }
        const bansCollection = await guild.bans.fetch().catch(() => new Map());
        const bans = [];
        bansCollection.forEach((ban) => {
          bans.push({
            discordId: ban.user.id,
            username: ban.user.username || "Bilinmeyen Kullanıcı",
            avatarUrl: ban.user.displayAvatarURL({ extension: 'png' }) || "https://cdn.discordapp.com/embed/avatars/0.png",
            reason: ban.reason || "Sebep belirtilmemiş"
          });
        });
        if (process.send) {
          process.send({
            type: "GET_DISCORD_BANS_RESPONSE",
            requestId: msg.requestId,
            success: true,
            bans
          });
        }
      } catch (err) {
        console.error(`[Bot 3] GET_DISCORD_BANS failed:`, err.message);
        if (process.send) {
          process.send({
            type: "GET_DISCORD_BANS_RESPONSE",
            requestId: msg.requestId,
            success: false,
            bans: [],
            error: err.message
          });
        }
      }
    }

    if (msg.type === "CLEAR_USER_PUNISHMENTS" || msg.type === "EXECUTE_CLEAR_PUNISHMENT") {
      const { discordId, whitelistRoleId, unregisteredRoleId, characterApprovalRoleId, wlPunishedRoleId, warning1RoleId, warning2RoleId, warning3RoleId, warning4RoleId, warning5RoleId, warning6RoleId, warning7RoleId, warning8RoleId, warning9RoleId, executorId, executorUsername, requestId } = msg;

      const effectiveWhitelistRoleId = (whitelistRoleId && whitelistRoleId !== "none") ? whitelistRoleId : config.discord.whitelistRoleId;
      const effectiveUnregisteredRoleId = (unregisteredRoleId && unregisteredRoleId !== "none") ? unregisteredRoleId : config.discord.unregisteredRoleId;
      const effectiveWlPunishedRoleId = (wlPunishedRoleId && wlPunishedRoleId !== "none") ? wlPunishedRoleId : config.discord.wlPunishedRoleId;

      try {
        const guild = await getGuild(client);
        if (!guild) throw new Error("Sunucu bulunamadi.");

        const member = await guild.members.fetch(discordId).catch(() => null);
        if (member) {
          const baseNickname = (member.nickname || member.user.username || "").split(" | ")[0];
          await safeSetNickname(member, baseNickname);

          const rolesToRemove = [effectiveWlPunishedRoleId, effectiveUnregisteredRoleId, warning1RoleId, warning2RoleId, warning3RoleId, warning4RoleId, warning5RoleId, warning6RoleId, warning7RoleId, warning8RoleId, warning9RoleId].filter(r => r && r !== "none");
          for (const rId of rolesToRemove) {
            await member.roles.remove(rId).catch(err => console.error(`[Bot 3] Failed to remove role ${rId}: ${err.message}`));
          }

          const rolesToAdd = [effectiveWhitelistRoleId, characterApprovalRoleId].filter(r => r && r !== "none");
          for (const rId of rolesToAdd) {
            await member.roles.add(rId).catch(err => console.error(`[Bot 3] Failed to add role ${rId}: ${err.message}`));
          }
        }

        const actionLog = new ActionLog({
          executorId,
          executorUsername,
          targetId: discordId,
          targetUsername: member ? member.user.username : "Bilinmeyen Kullanıcı",
          actionType: "user_punishments_clear",
          details: `Kullanıcının aktif cezaları yetkili tarafından kaldırıldı.`
        });
        await actionLog.save();

        if (process.send) {
          process.send({
            type: "CLEAR_USER_PUNISHMENTS_RESPONSE",
            requestId,
            success: true
          });
        }
      } catch (err) {
        console.error(`[Bot 3] CLEAR_USER_PUNISHMENTS failed:`, err.message);
        if (process.send) {
          process.send({
            type: "CLEAR_USER_PUNISHMENTS_RESPONSE",
            requestId,
            success: false,
            error: err.message
          });
        }
      }
    }

    if (msg.type === "ADD_USER_TO_TEAM") {
      const { discordId, roleId, channelId, teamName, whitelistRoleId, unregisteredRoleId, executorUsername, teamId, isBusiness, teamType } = msg;
      console.log(`[Bot 3] IPC Received - ADD_USER_TO_TEAM for discordId=${discordId}, roleId=${roleId}, teamName=${teamName}, teamType=${teamType}`);
      try {
        const guild = await getGuild(client);
        if (!guild) throw new Error("Sunucu bulunamadı.");

        const member = await guild.members.fetch(discordId).catch(err => {
          console.error(`[Bot 3] Failed to fetch member ${discordId}:`, err.message);
          return null;
        });

        if (member) {
          const effectiveWhitelistRoleId = (whitelistRoleId && whitelistRoleId !== "none")
            ? whitelistRoleId
            : config.discord.whitelistRoleId;

          if (effectiveWhitelistRoleId && effectiveWhitelistRoleId !== "none") {
            await member.roles.add(effectiveWhitelistRoleId).catch(err => console.error(`[Bot 3] Whitelist role add error:`, err.message));
          }
          if (unregisteredRoleId && unregisteredRoleId !== "none") {
            await member.roles.remove(unregisteredRoleId).catch(err => console.error(`[Bot 3] Unregistered role remove error:`, err.message));
          }

          // Check if team is Illegal
          let isIllegalTeam = (teamType === "illegal");
          if (!isIllegalTeam && teamId && !isBusiness) {
            try {
              const foundTeam = await Team.findById(teamId);
              if (foundTeam && foundTeam.type === "illegal") {
                isIllegalTeam = true;
              }
            } catch (dbErr) {
              console.error("[Bot 3] Failed to check team type from DB:", dbErr.message);
            }
          }

          if (isIllegalTeam) {
            const illegalBirimRoleId = config.discord.illegalBirimRoleId;
            console.log(`[Bot 3] Adding Illegal Birim role (${illegalBirimRoleId}) to member ${discordId}`);
            await member.roles.add(illegalBirimRoleId).catch(err => {
              console.error(`[Bot 3] Illegal Birim role add error for ${illegalBirimRoleId}:`, err.message);
            });
          }

          let targetRole = null;
          const allRoles = await guild.roles.fetch().catch(() => null);

          // 1. Try finding role by stored roleId
          if (roleId && roleId !== "none" && allRoles) {
            targetRole = allRoles.get(roleId);
          }

          // 2. Fallback search by teamName if roleId not found or missing
          if (!targetRole && teamName && allRoles) {
            const cleanTeamName = teamName.toLowerCase().trim();
            targetRole = allRoles.find(r => {
              const rName = r.name.toLowerCase().trim();
              const rNameClean = rName.replace(/^\[.*?\]\s*/, "").trim();
              return rName === cleanTeamName || rNameClean === cleanTeamName;
            });

            if (!targetRole) {
              targetRole = allRoles.find(r => {
                const rName = r.name.toLowerCase().trim();
                return rName.includes(cleanTeamName) || cleanTeamName.includes(rName);
              });
            }
          }

          // 3. Auto-create role if it does not exist in Discord
          if (!targetRole && teamName) {
            console.log(`[Bot 3] Team role not found for "${teamName}". Auto-creating Discord role...`);
            targetRole = await guild.roles.create({
              name: teamName,
              reason: `Otomatik Ekip Rolü Oluşturuldu: ${teamName}`
            }).catch(err => {
              console.error(`[Bot 3] Failed to auto-create team role for "${teamName}":`, err.message);
              return null;
            });
          }

          // 4. Assign role to member & save roleId if newly resolved/created
          if (targetRole) {
            console.log(`[Bot 3] Adding role "${targetRole.name}" (${targetRole.id}) to member ${discordId}`);
            await member.roles.add(targetRole.id).catch(err => {
              console.error(`[Bot 3] Role add error for ${targetRole.id} (${targetRole.name}):`, err.message);
            });

            if (teamId && targetRole.id !== roleId) {
              try {
                const ModelClass = isBusiness ? Business : Team;
                await ModelClass.findByIdAndUpdate(teamId, { roleId: targetRole.id });
                console.log(`[Bot 3] Updated ${isBusiness ? "Business" : "Team"} ${teamId} roleId to ${targetRole.id}`);
              } catch (dbErr) {
                console.error(`[Bot 3] Failed to update roleId in MongoDB:`, dbErr.message);
              }
            }
          } else {
            console.warn(`[Bot 3] Warning: No valid role found or created for ${teamName} (discordId: ${discordId})`);
          }

          // Channel permissions and notification
          let targetChannel = null;
          if (channelId) {
            targetChannel = guild.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
          }

          if (targetChannel) {
            await targetChannel.permissionOverwrites.create(member, {
              ViewChannel: true,
              SendMessages: true,
              ReadMessageHistory: true
            }).catch(err => console.error(`[Bot 3] Channel perm overwrite error:`, err.message));

            const detailsMarkdown = `### ${common.passed} Ekibe Yeni Katılım

${common.member} **Kullanıcı:** <@${discordId}> (\`${member.user.username}\`)
${common.admin} **Ekleyen Yetkili:** \`${executorUsername || 'Sistem'}\`
${common.activity} **Zaman:** ${new Date().toLocaleString("tr-TR")}
${common.preview} **Yapılan İşlemler:**
${common.arrow} Kullanıcıya Whitelist yetkisi tanımlandı.
${common.arrow} Kullanıcı ekibe dahil edilerek Ekip rolü verildi.

Ekibe hoş geldin! 🎉`;
            const embedResponse = createV2Response("YENIKATILIM", detailsMarkdown, true);
            await targetChannel.send(embedResponse).catch(err => console.error("Failed to send message to team channel:", err.message));
            await targetChannel.send(`<@${discordId}> ekip ticketına eklendi`).catch(err => console.error("Failed to send text mention message to team channel:", err.message));
          }
        } else {
          console.warn(`[Bot 3] Member ${discordId} could not be fetched from Discord guild.`);
        }

        if (process.send) {
          process.send({ type: "ADD_USER_TO_TEAM_RESPONSE", requestId: msg.requestId, success: true });
        }
      } catch (err) {
        console.error("ADD_USER_TO_TEAM failed:", err.message);
        if (process.send) {
          process.send({ type: "ADD_USER_TO_TEAM_RESPONSE", requestId: msg.requestId, success: false, error: err.message });
        }
      }
    }

    if (msg.type === "REMOVE_USER_FROM_TEAM") {
      const { discordId, roleId, channelId, teamName, executorUsername } = msg;
      console.log(`[Bot 3] IPC Received - REMOVE_USER_FROM_TEAM for discordId=${discordId}, roleId=${roleId}`);
      try {
        const guild = await getGuild(client);
        if (!guild) throw new Error("Sunucu bulunamadı.");

        const member = await guild.members.fetch(discordId).catch(() => null);
        if (member) {
          let targetRoleId = roleId;
          if ((!targetRoleId || targetRoleId === "none") && teamName) {
            const allRoles = await guild.roles.fetch().catch(() => null);
            if (allRoles) {
              const foundRole = allRoles.find(r => r.name.toLowerCase().trim() === teamName.toLowerCase().trim());
              if (foundRole) targetRoleId = foundRole.id;
            }
          }

          if (targetRoleId && targetRoleId !== "none") {
            await member.roles.remove(targetRoleId).catch(err => console.error(`[Bot 3] Role remove error:`, err.message));
          }

          if (channelId) {
            const channel = guild.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
            if (channel) {
              await channel.permissionOverwrites.delete(member).catch(() => { });

              const detailsMarkdown = `### ${common.failed} Ekipten Ayrılma

${common.member} **Kullanıcı:** <@${discordId}> (\`${member.user.username}\`)
${common.admin} **Uzaklaştıran Yetkili:** \`${executorUsername}\`
${common.activity} **Zaman:** ${new Date().toLocaleString("tr-TR")}
${common.preview} **Yapılan İşlemler:**
${common.arrow} Kullanıcı ekipten uzaklaştırıldı.
${common.arrow} Ekip rolü üyeden kaldırıldı.`;
              const embedResponse = createV2Response("EKIPTENAYRILMA", detailsMarkdown, false);
              await channel.send(embedResponse).catch(err => console.error("Failed to send message to team channel:", err.message));
            }
          }
        }

        if (process.send) {
          process.send({ type: "REMOVE_USER_FROM_TEAM_RESPONSE", requestId: msg.requestId, success: true });
        }
      } catch (err) {
        console.error("REMOVE_USER_FROM_TEAM failed:", err.message);
        if (process.send) {
          process.send({ type: "REMOVE_USER_FROM_TEAM_RESPONSE", requestId: msg.requestId, success: false, error: err.message });
        }
      }
    }

    if (msg.type === "WIPE_TEAM_MEMBERS") {
      const { memberDiscordIds, unregisteredRoleId, wipePunishRoleId, roleId, channelId, executorUsername } = msg;
      try {
        const guild = await getGuild(client);
        if (!guild) throw new Error("Sunucu bulunamadı.");

        const effectiveUnregisteredRoleId = (unregisteredRoleId && unregisteredRoleId !== "none")
          ? unregisteredRoleId
          : config.discord.unregisteredRoleId;

        const effectiveWipePunishRoleId = (wipePunishRoleId && wipePunishRoleId !== "none")
          ? wipePunishRoleId
          : config.discord.wipePunishRoleId;

        let channel = null;
        if (channelId) {
          channel = guild.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
        }

        const targetDiscordIds = new Set(Array.isArray(memberDiscordIds) ? memberDiscordIds : []);
        if (roleId && guild.roles.cache.has(roleId)) {
          const roleObj = guild.roles.cache.get(roleId);
          if (roleObj && roleObj.members) {
            roleObj.members.forEach(m => targetDiscordIds.add(m.id));
          }
        }

        const savedMemberRoles = [];
        for (const discordId of targetDiscordIds) {
          const member = await guild.members.fetch(discordId).catch(() => null);
          if (member) {
            try {
              const currentRoles = member.roles.cache
                .filter(r => r.id !== guild.id && r.id !== effectiveUnregisteredRoleId && r.id !== effectiveWipePunishRoleId)
                .map(r => r.id);
              savedMemberRoles.push({
                discordId,
                username: member.user ? member.user.username : "",
                roles: currentRoles
              });

              const rolesToAssign = [];
              if (effectiveUnregisteredRoleId && effectiveUnregisteredRoleId !== "none") {
                rolesToAssign.push(effectiveUnregisteredRoleId);
              }
              if (effectiveWipePunishRoleId && effectiveWipePunishRoleId !== "none") {
                rolesToAssign.push(effectiveWipePunishRoleId);
              }

              if (rolesToAssign.length > 0) {
                await member.roles.set(rolesToAssign).catch(async () => {
                  const rolesToRemove = member.roles.cache.filter(r => r.id !== guild.id && !rolesToAssign.includes(r.id));
                  for (const r of rolesToRemove.values()) {
                    await member.roles.remove(r).catch(() => { });
                  }
                  for (const rId of rolesToAssign) {
                    await member.roles.add(rId).catch(() => { });
                  }
                });
              } else {
                const rolesToRemove = member.roles.cache.filter(r => r.id !== guild.id);
                for (const r of rolesToRemove.values()) {
                  await member.roles.remove(r).catch(() => { });
                }
              }

              if (channel) {
                await channel.permissionOverwrites.delete(member.id).catch(() => { });
                await channel.send(`<@${discordId}> ekip ticketından çıkarıldı.`).catch(() => { });
              }
            } catch (roleErr) {
              console.error(`Wipe roles error for member ${discordId}:`, roleErr.message);
            }
          }
        }

        if (channel) {
          const detailsMarkdown = `### ${common.failed} Ekip Üyelerine Wipe Atıldı

Bu ekibin tüm üyelerinin rolleri yönetim kararıyla **${executorUsername}** tarafından sıfırlanmış, whitelist yetkileri kaldırılmış, üzerlerine kayıtsız üye rolü ve wipe cezası rolü tanımlanmış ve ekip ticketından çıkarılmışlardır.

${common.admin} **Yetkili:** \`${executorUsername}\`
${common.activity} **Zaman:** ${new Date().toLocaleString("tr-TR")}
${common.preview} **Yapılan İşlemler:**
${common.arrow} Ekipteki tüm üyelerin rolleri temizlendi.
${common.arrow} Üyelere kayıtsız üye rolü ve wipe rolü tanımlandı.
${common.arrow} Tüm ekip üyeleri ekip ticketından çıkarıldı.`;
          const embedResponse = createV2Response("EKIPWIPE", detailsMarkdown, false);
          await channel.send(embedResponse).catch(() => null);
        }

        if (process.send) {
          process.send({ type: "WIPE_TEAM_MEMBERS_RESPONSE", requestId: msg.requestId, success: true, savedMemberRoles });
        }
      } catch (err) {
        console.error("WIPE_TEAM_MEMBERS failed:", err.message);
        if (process.send) {
          process.send({ type: "WIPE_TEAM_MEMBERS_RESPONSE", requestId: msg.requestId, success: false, error: err.message });
        }
      }
    }

    if (msg.type === "UNWIPE_TEAM_MEMBERS") {
      const { membersToRestore, unregisteredRoleId, whitelistRoleId, wipePunishRoleId, teamRoleId, channelId, executorUsername } = msg;
      try {
        const guild = await getGuild(client);
        if (!guild) throw new Error("Sunucu bulunamadı.");

        const effectiveWipePunishRoleId = (wipePunishRoleId && wipePunishRoleId !== "none")
          ? wipePunishRoleId
          : config.discord.wipePunishRoleId;

        let channel = null;
        if (channelId) {
          channel = guild.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
        }

        for (const item of membersToRestore) {
          const { discordId, roles } = item;
          const member = await guild.members.fetch(discordId).catch(() => null);
          if (member) {
            try {
              if (unregisteredRoleId && unregisteredRoleId !== "none") {
                await member.roles.remove(unregisteredRoleId).catch(() => { });
              }
              if (effectiveWipePunishRoleId && effectiveWipePunishRoleId !== "none") {
                await member.roles.remove(effectiveWipePunishRoleId).catch(() => { });
              }

              if (Array.isArray(roles)) {
                for (const rId of roles) {
                  if (rId !== unregisteredRoleId && rId !== guild.id && guild.roles.cache.has(rId)) {
                    await member.roles.add(rId).catch(() => { });
                  }
                }
              }

              if (teamRoleId && guild.roles.cache.has(teamRoleId)) {
                await member.roles.add(teamRoleId).catch(() => { });
              }
              if (whitelistRoleId && whitelistRoleId !== "none" && guild.roles.cache.has(whitelistRoleId)) {
                await member.roles.add(whitelistRoleId).catch(() => { });
              }

              if (channel) {
                await channel.permissionOverwrites.edit(member.id, {
                  ViewChannel: true,
                  SendMessages: true,
                  ReadMessageHistory: true
                }).catch(() => { });
                await channel.send(`<@${discordId}> ekip ticketına tekrardan eklendi.`).catch(() => { });
              }
            } catch (roleErr) {
              console.error(`Unwipe roles error for member ${discordId}:`, roleErr.message);
            }
          }
        }

        if (channel) {
          const detailsMarkdown = `### ${common.passed} Ekip Wipe İşlemi Geri Alındı

Ekibe daha önce atılan wipe işlemi **${executorUsername}** tarafından tamamen geriye alınmış, tüm ekip üyelerine eski rolleri iade edilmiş ve ekip ticketına tekrardan eklenmişlerdir.

${common.admin} **Yetkili:** \`${executorUsername}\`
${common.activity} **Zaman:** ${new Date().toLocaleString("tr-TR")}
${common.preview} **Yapılan İşlemler:**
${common.arrow} Tüm üyelerin eski rolleri geri verildi.
${common.arrow} Ekip ticket erişimleri tekrar tanımlandı.`;
          const embedResponse = createV2Response("EKIPWIPEGERIAL", detailsMarkdown, true);
          await channel.send(embedResponse).catch(() => null);
        }

        if (process.send) {
          process.send({ type: "UNWIPE_TEAM_MEMBERS_RESPONSE", requestId: msg.requestId, success: true });
        }
      } catch (err) {
        console.error("UNWIPE_TEAM_MEMBERS failed:", err.message);
        if (process.send) {
          process.send({ type: "UNWIPE_TEAM_MEMBERS_RESPONSE", requestId: msg.requestId, success: false, error: err.message });
        }
      }
    }

    if (msg.type === "CK_TEAM_MEMBERS") {
      const { channelId, executorUsername, deletedCharactersCount } = msg;
      try {
        const guild = await getGuild(client);
        if (guild && channelId) {
          const channel = guild.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
          if (channel) {
            const detailsMarkdown = `### 💀 Ekibe Komple CK Atıldı

Bu ekibin tüm üyelerinin sunucudaki (**FiveM**) tüm karakter kayıtları yönetim kararıyla **${executorUsername}** tarafından veritabanından kalıcı olarak **SİLİNMİŞTİR**.

${common.admin} **Yetkili:** \`${executorUsername}\`
${common.activity} **Zaman:** ${new Date().toLocaleString("tr-TR")}
${common.preview} **Yapılan İşlemler:**
${common.arrow} Ekipteki tüm üyelerin sunucu karakterleri (CK) veritabanından silindi.
${common.arrow} Toplam **${deletedCharactersCount}** karakter kaydı temizlendi.`;
            const embedResponse = createV2Response("EKIPCK", detailsMarkdown, false);
            await channel.send(embedResponse).catch(() => null);
          }
        }
      } catch (err) {
        console.error("CK_TEAM_MEMBERS bot notification error:", err.message);
      }
    }

    if (msg.type === "BAN_DISCORD_TEAM") {
      const { roleId, channelId, whitelistRoleId, wlPunishedRoleId, unregisteredRoleId, memberDiscordIds, executorUsername } = msg;
      try {
        const guild = await getGuild(client);
        if (!guild) throw new Error("Sunucu bulunamadı.");

        if (channelId) {
          const channel = guild.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
          if (channel) {
            const detailsMarkdown = `### ${common.failed} Ekip Feshedildi / Banlandı

Bu ekip, yönetim kararıyla **${executorUsername}** tarafından feshedilmiş ve tüm üyelerinin whitelist yetkileri sonlandırılmıştır.

${common.admin} **Yetkili:** \`${executorUsername}\`
${common.activity} **Zaman:** ${new Date().toLocaleString("tr-TR")}
${common.preview} **Yapılan İşlemler:**
${common.arrow} Ekip Discord kanalı ve rolü feshedildi.
${common.arrow} Tüm üyelerin whitelist yetkisi askıya alındı/iptal edildi.
${common.arrow} Üyelerin ekip rolleri silindi.`;
            const embedResponse = createV2Response("EKIPKAPATILDI", detailsMarkdown, false);
            await channel.send(embedResponse).catch(() => null);
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }

        for (const discordId of memberDiscordIds) {
          const member = await guild.members.fetch(discordId).catch(() => null);
          if (member) {
            if (roleId) {
              await member.roles.remove(roleId).catch(() => null);
            }
            if (whitelistRoleId && whitelistRoleId !== "none") {
              await member.roles.remove(whitelistRoleId).catch(() => null);
            }
            if (wlPunishedRoleId && wlPunishedRoleId !== "none") {
              await member.roles.add(wlPunishedRoleId).catch(() => null);
            } else if (unregisteredRoleId && unregisteredRoleId !== "none") {
              await member.roles.add(unregisteredRoleId).catch(() => null);
            }
          }
        }

        if (roleId) {
          const role = guild.roles.cache.get(roleId);
          if (role) await role.delete(`Ekip banlandı. Yetkili: ${executorUsername}`).catch(() => null);
        }
        if (channelId) {
          const channel = guild.channels.cache.get(channelId);
          if (channel) await channel.delete(`Ekip banlandı. Yetkili: ${executorUsername}`).catch(() => null);
        }

        if (process.send) {
          process.send({ type: "BAN_DISCORD_TEAM_RESPONSE", requestId: msg.requestId, success: true });
        }
      } catch (err) {
        console.error("BAN_DISCORD_TEAM failed:", err.message);
        if (process.send) {
          process.send({ type: "BAN_DISCORD_TEAM_RESPONSE", requestId: msg.requestId, success: false, error: err.message });
        }
      }
    }

    if (msg.type === "KICK_DISCORD_USER") {
      const { discordId, reason, executorUsername, requestId } = msg;
      try {
        const guild = await getGuild(client);
        if (!guild) throw new Error("Sunucu bulunamadı.");
        const member = await guild.members.fetch(discordId).catch(() => null);
        if (!member) throw new Error("Kullanıcı sunucuda bulunamadı.");
        await member.kick(`Kickleyen Yetkili: ${executorUsername}. Sebep: ${reason || "Belirtilmedi"}`);
        if (process.send) {
          process.send({ type: "KICK_DISCORD_USER_RESPONSE", requestId, success: true });
        }
      } catch (err) {
        console.error("KICK_DISCORD_USER failed:", err.message);
        if (process.send) {
          process.send({ type: "KICK_DISCORD_USER_RESPONSE", requestId, success: false, error: err.message });
        }
      }
    }

    if (msg.type === "BAN_DISCORD_USER") {
      const { discordId, reason, executorUsername, requestId } = msg;
      try {
        const guild = await getGuild(client);
        if (!guild) throw new Error("Sunucu bulunamadı.");
        await guild.members.ban(discordId, { reason: `Banlayan Yetkili: ${executorUsername}. Sebep: ${reason || "Belirtilmedi"}` });
        if (process.send) {
          process.send({ type: "BAN_DISCORD_USER_RESPONSE", requestId, success: true });
        }
      } catch (err) {
        console.error("BAN_DISCORD_USER failed:", err.message);
        if (process.send) {
          process.send({ type: "BAN_DISCORD_USER_RESPONSE", requestId, success: false, error: err.message });
        }
      }
    }

    if (msg.type === "UNBAN_DISCORD_USER") {
      const { discordId, executorUsername, requestId } = msg;
      try {
        const guild = await getGuild(client);
        if (!guild) throw new Error("Sunucu bulunamadı.");
        await guild.members.unban(discordId, `Banı Kaldıran Yetkili: ${executorUsername}`);
        if (process.send) {
          process.send({ type: "UNBAN_DISCORD_USER_RESPONSE", requestId, success: true });
        }
      } catch (err) {
        console.error("UNBAN_DISCORD_USER failed:", err.message);
        if (process.send) {
          process.send({ type: "UNBAN_DISCORD_USER_RESPONSE", requestId, success: false, error: err.message });
        }
      }
    }

    if (msg.type === "SEND_TEAM_DM") {
      const { memberDiscordIds, message, teamName, executorUsername } = msg;
      try {
        const guild = await getGuild(client);
        if (guild) {
          for (const discId of (memberDiscordIds || [])) {
            const member = await guild.members.fetch(discId).catch(() => null);
            if (member) {
              await member.send(`📩 **${teamName}** Ekibine Özel Mesaj (Gönderen Yetkili: ${executorUsername}):\n\n${message}`).catch(() => null);
            }
          }
        }
      } catch (err) {
        console.error("SEND_TEAM_DM failed:", err.message);
      }
    }

    if (msg.type === "GIVE_TEAM_WHITELIST") {
      const { memberDiscordIds, whitelistRoleId } = msg;
      try {
        const guild = await getGuild(client);
        if (guild && whitelistRoleId && Array.isArray(memberDiscordIds)) {
          console.log(`[Bot 3] GIVE_TEAM_WHITELIST queued for ${memberDiscordIds.length} members with rate-limit protection...`);
          await processBatchWithDelay(memberDiscordIds, async (discId) => {
            const member = await guild.members.fetch(discId).catch(() => null);
            if (member) {
              await member.roles.add(whitelistRoleId);
              console.log(`[Bot 3] Whitelist role (${whitelistRoleId}) assigned to ${member.user.tag}`);
            }
          }, 350);
        }
      } catch (err) {
        console.error("GIVE_TEAM_WHITELIST failed:", err.message);
      }
    }

    if (msg.type === "TAKE_TEAM_WHITELIST") {
      const { memberDiscordIds, whitelistRoleId } = msg;
      try {
        const guild = await getGuild(client);
        if (guild && whitelistRoleId && Array.isArray(memberDiscordIds)) {
          console.log(`[Bot 3] TAKE_TEAM_WHITELIST queued for ${memberDiscordIds.length} members with rate-limit protection...`);
          await processBatchWithDelay(memberDiscordIds, async (discId) => {
            const member = await guild.members.fetch(discId).catch(() => null);
            if (member) {
              await member.roles.remove(whitelistRoleId);
              console.log(`[Bot 3] Whitelist role (${whitelistRoleId}) removed from ${member.user.tag}`);
            }
          }, 350);
        }
      } catch (err) {
        console.error("TAKE_TEAM_WHITELIST failed:", err.message);
      }
    }

    if (msg.type === "GIVE_TEAM_ROLE") {
      const { memberDiscordIds, teamRoleId } = msg;
      try {
        const guild = await getGuild(client);
        if (guild && teamRoleId && Array.isArray(memberDiscordIds)) {
          console.log(`[Bot 3] GIVE_TEAM_ROLE queued for ${memberDiscordIds.length} members with rate-limit protection...`);
          await processBatchWithDelay(memberDiscordIds, async (discId) => {
            const member = await guild.members.fetch(discId).catch(() => null);
            if (member) {
              await member.roles.add(teamRoleId);
              console.log(`[Bot 3] Team role (${teamRoleId}) assigned to ${member.user.tag}`);
            }
          }, 350);
        }
      } catch (err) {
        console.error("GIVE_TEAM_ROLE failed:", err.message);
      }
    }

    if (msg.type === "APPLICATION_REVIEW_NOTIFY") {
      const { discordId, applicationTitle, status, reviewerNotes, executorUsername, channelId } = msg;
      let targetChannelId = channelId;
      if (!targetChannelId || targetChannelId === "none") {
        try {
          const statsDoc = await ServerStats.findOne();
          if (statsDoc && statsDoc.applicationLogChannelId && statsDoc.applicationLogChannelId !== "none") {
            targetChannelId = statsDoc.applicationLogChannelId;
          }
        } catch (e) { }
      }
      if (!targetChannelId || targetChannelId === "none") {
        targetChannelId = config.discord.applicationLogChannelId;
      }
      console.log(`[Bot 3] IPC Received - APPLICATION_REVIEW_NOTIFY for discordId=${discordId}, status=${status}, channelId=${targetChannelId}`);
      try {
        const guild = await getGuild(client);
        if (guild) {
          const targetChannel = guild.channels.cache.get(targetChannelId) || await client.channels.fetch(targetChannelId).catch(() => null);
          if (targetChannel) {
            const isApproved = status === "approved";
            const statusLabel = isApproved ? "**ONAYLANDI** ✅" : "**REDDEDİLDİ** ❌";
            const noteText = (reviewerNotes && reviewerNotes.trim()) ? reviewerNotes.trim() : "Belirtilmedi";

            const plainTextMessage = `<@${discordId}> Başvurunuz ${statusLabel}\n` +
              `**Başvuru Türü:** ${applicationTitle || 'Genel Başvuru'}\n` +
              `**Değerlendiren Yetkili:** ${executorUsername || 'Yönetim'}\n` +
              `**Değerlendirme Notu:** ${noteText}`;

            await targetChannel.send(plainTextMessage);
            console.log(`[Bot 3] Application review plain text notification sent to channel ${targetChannelId} for user ${discordId}`);
          } else {
            console.warn(`[Bot 3] Application notification channel ${targetChannelId} not found.`);
          }
        }
      } catch (err) {
        console.error("[Bot 3] APPLICATION_REVIEW_NOTIFY error:", err.message);
      }
    }
  }
});

const PENALTY_CHECK_INTERVAL_MS = 60000;

// Lifts expired temporary whitelist punishments: restores Discord roles first, then clears the DB record.
// Runs only while the bot is connected so expiries are never cleared without their roles being restored.
setInterval(async () => {
  if (!moderationClient.isReady()) return;
  try {
    const expiredUsers = await DiscordUser.find({
      wlCezaBitis: { $ne: null, $lte: new Date() },
      isPermaBanned: { $ne: true }
    });
    if (expiredUsers.length === 0) return;

    const guild = await getGuild(moderationClient);
    const stats = await ServerStats.findOne();
    const configured = r => r && r !== "none";
    const warningRoles = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => stats?.[`warning${i}RoleId`]).filter(configured);
    const rolesToRemove = [
      stats?.wlPunishedRoleId || config.discord.wlPunishedRoleId,
      stats?.unregisteredRoleId || config.discord.unregisteredRoleId,
      ...warningRoles
    ].filter(configured);
    const rolesToAdd = [stats?.whitelistRoleId || config.discord.whitelistRoleId, stats?.characterApprovalRoleId].filter(configured);

    for (const u of expiredUsers) {
      console.log(`[Bot 3] Whitelist penalty expired for user ${u.username} (${u.discordId}). Clearing roles...`);
      const member = guild ? await guild.members.fetch(u.discordId).catch(() => null) : null;
      if (member) {
        const baseNickname = (member.nickname || member.user.username || "").split(" | ")[0];
        await member.setNickname(baseNickname).catch(() => null);
        for (const roleId of rolesToRemove) await member.roles.remove(roleId).catch(() => null);
        for (const roleId of rolesToAdd) await member.roles.add(roleId).catch(() => null);
      }
      u.wlCezaBitis = null;
      u.warnings = 0;
      await u.save();
    }
  } catch (err) {
    console.error("[Bot 3] Expired penalty check failed:", err.message);
  }
}, PENALTY_CHECK_INTERVAL_MS);
