const {
  REST,
  Routes,
  SlashCommandBuilder,
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");
const { createBot, connectDatabase } = require("../botHelper");
const config = require("../../config");
const DiscordUser = require("../../models/DiscordUser");
const ServerStats = require("../../models/ServerStats");
const ActionLog = require("../../models/ActionLog");
const { textToLetterEmojis, common } = require("../emojis");

connectDatabase("Bot 1");

async function modifyMemberRoles(client, discordId, action) {
  try {
    const stats = await ServerStats.findOne();
    const guildId = stats?.guildId || config.discord.guildId;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      return { success: false, error: "Sunucu bulunamadı. Lütfen config dosyasındaki Sunucu ID'sini kontrol edin." };
    }

    const member = await guild.members.fetch(discordId).catch(() => null);
    if (!member) {
      return { success: false, error: "Kullanıcı sunucuda bulunamadı." };
    }

    const whitelistRoleId = stats?.whitelistRoleId || config.discord.whitelistRoleId;
    const unregisteredRoleId = stats?.unregisteredRoleId || config.discord.unregisteredRoleId;

    const botMember = guild.members.me || await guild.members.fetch(client.user.id);

    if (action === "whitelist") {
      if (whitelistRoleId && whitelistRoleId !== "none") {
        const role = guild.roles.cache.get(whitelistRoleId);
        if (role) {
          if (role.position < botMember.roles.highest.position) {
            await member.roles.add(whitelistRoleId).catch(err => console.error(`[Bot 1] Failed to add whitelist role: ${err.message}`));
          } else {
            console.warn(`[Bot 1] Whitelist role position (${role.position}) is higher than bot's highest role (${botMember.roles.highest.position}).`);
          }
        }
      }
      if (unregisteredRoleId && unregisteredRoleId !== "none") {
        const role = guild.roles.cache.get(unregisteredRoleId);
        if (role) {
          if (role.position < botMember.roles.highest.position) {
            await member.roles.remove(unregisteredRoleId).catch(err => console.error(`[Bot 1] Failed to remove unregistered role: ${err.message}`));
          } else {
            console.warn(`[Bot 1] Unregistered role position (${role.position}) is higher than bot's highest role (${botMember.roles.highest.position}).`);
          }
        }
      }
      return { success: true, member };
    } else if (action === "remove-whitelist") {
      if (whitelistRoleId && whitelistRoleId !== "none") {
        const role = guild.roles.cache.get(whitelistRoleId);
        if (role) {
          if (role.position < botMember.roles.highest.position) {
            await member.roles.remove(whitelistRoleId).catch(err => console.error(`[Bot 1] Failed to remove whitelist role: ${err.message}`));
          } else {
            console.warn(`[Bot 1] Whitelist role position (${role.position}) is higher than bot's highest role (${botMember.roles.highest.position}).`);
          }
        }
      }
      if (unregisteredRoleId && unregisteredRoleId !== "none") {
        const role = guild.roles.cache.get(unregisteredRoleId);
        if (role) {
          if (role.position < botMember.roles.highest.position) {
            await member.roles.add(unregisteredRoleId).catch(err => console.error(`[Bot 1] Failed to add unregistered role: ${err.message}`));
          } else {
            console.warn(`[Bot 1] Unregistered role position (${role.position}) is higher than bot's highest role (${botMember.roles.highest.position}).`);
          }
        }
      }
      return { success: true, member };
    } else if (action === "unregister") {
      const rolesToRemove = member.roles.cache.filter(role =>
        role.id !== guild.id &&
        !role.managed &&
        role.position < botMember.roles.highest.position
      );
      if (rolesToRemove.size > 0) {
        await member.roles.remove(rolesToRemove).catch(err =>
          console.error(`[Bot 1] Failed to remove some roles from ${discordId}: ${err.message}`)
        );
      }
      if (unregisteredRoleId && unregisteredRoleId !== "none") {
        const role = guild.roles.cache.get(unregisteredRoleId);
        if (role) {
          if (role.position < botMember.roles.highest.position) {
            await member.roles.add(unregisteredRoleId).catch(err =>
              console.error(`[Bot 1] Failed to add unregistered role to ${discordId}: ${err.message}`)
            );
          } else {
            console.warn(`[Bot 1] Unregistered role position (${role.position}) is higher than bot's highest role (${botMember.roles.highest.position}).`);
          }
        }
      }
      return { success: true, member };
    }
  } catch (err) {
    console.error(`[Bot 1] Role modification error:`, err);
    return { success: false, error: `Roller düzenlenirken hata oluştu: ${err.message}` };
  }
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

const commands = [
  new SlashCommandBuilder()
    .setName("whitelist")
    .setDescription("Bir kullanıcıyı whiteliste ekler, ilgili rolleri senkronize eder.")
    .addUserOption(option =>
      option.setName("user").setDescription("Whiteliste eklenecek kullanıcı").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("sesli-destek")
    .setDescription("Bir kullanıcının sesli destek rolünü alır veya verir (Aç/Kapat).")
    .addUserOption(option =>
      option.setName("user").setDescription("Sesli destek rolü değiştirilecek kullanıcı").setRequired(true)
    ),

  new ContextMenuCommandBuilder()
    .setName("Whitelist")
    .setType(ApplicationCommandType.User),
  new ContextMenuCommandBuilder()
    .setName("Sesli Destek")
    .setType(ApplicationCommandType.User)
];

async function registerCommands(client) {
  try {
    const rest = new REST({ version: "10" }).setToken(config.bots.verification.token);

    let targetGuildId = config.discord.guildId;
    try {
      const stats = await ServerStats.findOne();
      if (stats && stats.guildId) targetGuildId = stats.guildId;
    } catch (e) {}

    const existing = await rest.get(
      Routes.applicationGuildCommands(client.user.id, targetGuildId)
    ).catch(() => []);

    const needsRedeploy = commands.some(localCmd => {
      const remoteCmd = existing.find(r => r.name === localCmd.name && r.type === localCmd.type);
      if (!remoteCmd) return true;

      if (localCmd.description && remoteCmd.description !== localCmd.description) return true;

      const localOptions = localCmd.options || [];
      const remoteOptions = remoteCmd.options || [];
      if (localOptions.length !== remoteOptions.length) return true;

      return false;
    }) || existing.length !== commands.length;

    if (needsRedeploy) {
      console.log(`[Bot 1] New or modified commands detected. Registering application commands...`);
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, targetGuildId),
        { body: commands }
      );
      console.log(`[Bot 1] Application commands registered successfully.`);
    } else {
      console.log(`[Bot 1] Application commands are already up-to-date. Skipping deployment.`);
    }
  } catch (error) {
    console.error("[Bot 1] Failed to register commands:", error.message);
  }
}

async function sendReply(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply(payload);
    } else {
      return await interaction.reply(payload);
    }
  } catch (err) {
    try {
      return await interaction.followUp(payload);
    } catch (e) { }
  }
}

createBot("verification", "Bot 1 (Verification)", config.bots.verification.token, {
  onReady: async (client) => {
    await registerCommands(client);
  },

  onInteraction: async (interaction, client) => {
    if (!interaction.isChatInputCommand() && !interaction.isUserContextMenuCommand()) return;

    const isSuperuser = config.isSuperuser(interaction.user.id);
    const isServerAdmin = interaction.member && interaction.member.permissions.has("Administrator");

    const stats = await ServerStats.findOne();
    const staffRoleId = stats?.staffRoleId;
    const hasStaffRole = staffRoleId && interaction.member && interaction.member.roles.cache.has(staffRoleId);

    if (!isSuperuser && !isServerAdmin && !hasStaffRole) {
      return sendReply(interaction, createV2Response(
        "YETKISIZ",
        "Bu komutu kullanmak için gerekli yetkilere sahip değilsiniz.",
        false
      ));
    }

    const targetUser = interaction.options.getUser("user") || (interaction.isUserContextMenuCommand() ? interaction.targetUser : null);
    if (!targetUser) {
      return sendReply(interaction, createV2Response("HATA", "Hedef kullanıcı bulunamadı.", false));
    }

    const commandName = interaction.commandName;

    if (commandName === "whitelist" || commandName === "Whitelist") {
      await interaction.deferReply().catch(() => { });

      const roleResult = await modifyMemberRoles(client, targetUser.id, "whitelist");
      if (!roleResult.success) {
        const log = new ActionLog({
          executorId: interaction.user.id,
          executorUsername: interaction.user.username,
          targetId: targetUser.id,
          targetUsername: targetUser.username,
          actionType: "whitelist_failed",
          details: `Whitelist islemi basarisiz oldu: ${roleResult.error}`
        });
        await log.save();
        return sendReply(interaction, createV2Response("HATA", roleResult.error, false));
      }

      await DiscordUser.findOneAndUpdate(
        { discordId: targetUser.id },
        {
          username: targetUser.username,
          avatarUrl: targetUser.displayAvatarURL({ extension: 'png' }) || "",
          isWhitelist: true
        },
        { upsert: true, new: true }
      );

      const log = new ActionLog({
        executorId: interaction.user.id,
        executorUsername: interaction.user.username,
        targetId: targetUser.id,
        targetUsername: targetUser.username,
        actionType: "whitelist",
        details: "Kullaniciya whitelist yetkisi ve rolu tanimlandi."
      });
      await log.save();

      const detailsMarkdown = `### ${common.passed} Whitelist Islemi Tamamlandi

${common.member} **Kullanıcı:** <@${targetUser.id}> (\`${targetUser.username}\`)
${common.admin} **Yetkili:** <@${interaction.user.id}> (\`${interaction.user.username}\`)
${common.activity} **Zaman:** ${new Date().toLocaleString("tr-TR")}
${common.preview} **Yapılan İşlemler:**
${common.arrow} Sunucu veritabanında whitelist durumu \`True\` yapıldı.
${common.arrow} Whitelist Discord rolü tanımlandı.
${common.arrow} Kayıtsız Üye rolü kaldırıldı.`;

      return sendReply(interaction, createV2Response(
        "WHITELIST",
        detailsMarkdown,
        true
      ));
    }


    if (commandName === "sesli-destek" || commandName === "Sesli Destek") {
      await interaction.deferReply().catch(() => { });

      const stats = await ServerStats.findOne();
      const guildId = stats?.guildId || config.discord.guildId;
      const guild = client.guilds.cache.get(guildId);
      const member = await guild.members.fetch(targetUser.id).catch(() => null);
      if (!member) {
        return sendReply(interaction, createV2Response("HATA", "Kullanıcı sunucuda bulunamadı.", false));
      }

      const voiceSupportRoleId = stats?.voiceSupportRoleId || config.discord.voiceSupportRoleId;
      if (!voiceSupportRoleId || voiceSupportRoleId === "none") {
        return sendReply(interaction, createV2Response("HATA", "Sesli destek rolü henüz ayarlanmamış.", false));
      }

      const botMember = guild.members.me || await guild.members.fetch(client.user.id);
      const role = guild.roles.cache.get(voiceSupportRoleId);
      if (!role) {
        return sendReply(interaction, createV2Response("HATA", "Ayarlanmış olan sesli destek rolü sunucuda bulunamadı.", false));
      }

      if (role.position >= botMember.roles.highest.position) {
        return sendReply(interaction, createV2Response("HATA", "Botun yetkisi sesli destek rolünü vermeye yetmiyor.", false));
      }

      const hasRole = member.roles.cache.has(voiceSupportRoleId);
      if (hasRole) {
        await member.roles.remove(voiceSupportRoleId);

        const log = new ActionLog({
          executorId: interaction.user.id,
          executorUsername: interaction.user.username,
          targetId: targetUser.id,
          targetUsername: targetUser.username,
          actionType: "voice_support_remove",
          details: "Yetkili tarafindan sesli destek rolu kaldirildi."
        });
        await log.save();

        const detailsMarkdown = `### ${common.passed} Sesli Destek Rolü Kaldırıldı

${common.member} **Kullanıcı:** <@${targetUser.id}> (\`${targetUser.username}\`)
${common.admin} **Yetkili:** <@${interaction.user.id}> (\`${interaction.user.username}\`)
${common.activity} **Zaman:** ${new Date().toLocaleString("tr-TR")}
${common.preview} **Açıklama:** Sesli destek odalarına erişim sağlayan rol yetkili tarafından başarıyla kullanıcıdan alındı.`;

        return sendReply(interaction, createV2Response(
          "SESLIDESTEK",
          detailsMarkdown,
          true
        ));
      } else {
        await member.roles.add(voiceSupportRoleId);

        const log = new ActionLog({
          executorId: interaction.user.id,
          executorUsername: interaction.user.username,
          targetId: targetUser.id,
          targetUsername: targetUser.username,
          actionType: "voice_support_add",
          details: "Yetkili tarafindan kullaniciya sesli destek rolu tanimlandi."
        });
        await log.save();

        const detailsMarkdown = `### ${common.passed} Sesli Destek Rolü Tanımlandı

${common.member} **Kullanıcı:** <@${targetUser.id}> (\`${targetUser.username}\`)
${common.admin} **Yetkili:** <@${interaction.user.id}> (\`${interaction.user.username}\`)
${common.activity} **Zaman:** ${new Date().toLocaleString("tr-TR")}
${common.preview} **Açıklama:** Sesli destek odalarına giriş yetkisi sağlayan rol yetkili tarafından başarıyla kullanıcıya tanımlandı.`;

        return sendReply(interaction, createV2Response(
          "SESLIDESTEK",
          detailsMarkdown,
          true
        ));
      }
    }
  },

  onMessage: async (msg, client) => {
    if (msg.type === "SYNC_WHITELIST") {
      const { discordId, isWhitelist, executorId, executorUsername } = msg;
      console.log(`[Bot 1] IPC Received - SYNC_WHITELIST for ${discordId}: ${isWhitelist}`);

      const action = isWhitelist ? "whitelist" : "remove-whitelist";
      const result = await modifyMemberRoles(client, discordId, action);

      if (result.success) {
        console.log(`[Bot 1] IPC Success - Whitelist sync completed for ${discordId}`);
        await DiscordUser.findOneAndUpdate(
          { discordId },
          {
            username: result.member.user.username,
            avatarUrl: result.member.user.displayAvatarURL({ extension: 'png' }) || ""
          }
        );

        const log = new ActionLog({
          executorId: executorId || "system",
          executorUsername: executorUsername || "System",
          targetId: discordId,
          targetUsername: result.member.user.username,
          actionType: isWhitelist ? "whitelist" : "remove-whitelist",
          details: "Web admin paneli uzerinden whitelist eslesmesi tamamlandi."
        });
        await log.save();
      } else {
        console.log(`[Bot 1] IPC Error - Whitelist sync failed: ${result.error}`);
        const log = new ActionLog({
          executorId: executorId || "system",
          executorUsername: executorUsername || "System",
          targetId: discordId,
          targetUsername: "Bilinmeyen Kullanici",
          actionType: isWhitelist ? "whitelist_failed" : "remove-whitelist_failed",
          details: `Web panel whitelist eslesmesi basarisiz: ${result.error}`
        });
        await log.save();
      }
    }

    if (msg.type === "UNREGISTER_USER") {
      const { discordId, executorId, executorUsername } = msg;
      console.log(`[Bot 1] IPC Received - UNREGISTER_USER for ${discordId}`);

      const result = await modifyMemberRoles(client, discordId, "unregister");
      if (result.success) {
        console.log(`[Bot 1] IPC Success - User unregistered on Discord: ${discordId}`);
        await DiscordUser.findOneAndUpdate(
          { discordId },
          {
            username: result.member.user.username,
            avatarUrl: result.member.user.displayAvatarURL({ extension: 'png' }) || ""
          }
        );

        const log = new ActionLog({
          executorId: executorId || "system",
          executorUsername: executorUsername || "System",
          targetId: discordId,
          targetUsername: result.member.user.username,
          actionType: "unregister",
          details: "Web admin paneli uzerinden tum rolleri silindi ve kayitsiz yapildi."
        });
        await log.save();
      } else {
        console.log(`[Bot 1] IPC Error - Unregister failed: ${result.error}`);
        const log = new ActionLog({
          executorId: executorId || "system",
          executorUsername: executorUsername || "System",
          targetId: discordId,
          targetUsername: "Bilinmeyen Kullanici",
          actionType: "unregister_failed",
          details: `Web panel rol silme islemi basarisiz: ${result.error}`
        });
        await log.save();
      }
    }

    if (msg.type === "TOGGLE_VOICE_SUPPORT") {
      const { discordId, executorId, executorUsername, requestId } = msg;
      console.log(`[Bot 1] IPC Received - TOGGLE_VOICE_SUPPORT for ${discordId}`);

      try {
        const stats = await ServerStats.findOne();
        const guildId = stats?.guildId || config.discord.guildId;
        const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null) || client.guilds.cache.first();
        if (!guild) throw new Error("Sunucu bulunamadi.");

        const member = await guild.members.fetch(discordId).catch(() => null);
        if (!member) throw new Error("Kullanici sunucuda bulunamadi.");

        const voiceSupportRoleId = stats?.voiceSupportRoleId || config.discord.voiceSupportRoleId;
        if (!voiceSupportRoleId || voiceSupportRoleId === "none") throw new Error("Sesli destek rolu henuz ayarlanmamis.");

        const botMember = guild.members.me || await guild.members.fetch(client.user.id);
        const role = guild.roles.cache.get(voiceSupportRoleId);
        if (!role) throw new Error("Sesli destek rolu sunucuda bulunamadi.");

        if (role.position >= botMember.roles.highest.position) throw new Error("Botun yetkisi yetersiz.");

        const hasRole = member.roles.cache.has(voiceSupportRoleId);
        if (hasRole) {
          await member.roles.remove(voiceSupportRoleId);

          const log = new ActionLog({
            executorId,
            executorUsername,
            targetId: discordId,
            targetUsername: member.user.username,
            actionType: "voice_support_remove",
            details: "Web arayuzunden sesli destek rolu kaldirildi."
          });
          await log.save();

          if (process.send) {
            process.send({
              type: "TOGGLE_VOICE_SUPPORT_RESPONSE",
              requestId,
              success: true,
              action: "removed"
            });
          }
        } else {
          await member.roles.add(voiceSupportRoleId);

          const log = new ActionLog({
            executorId,
            executorUsername,
            targetId: discordId,
            targetUsername: member.user.username,
            actionType: "voice_support_add",
            details: "Web arayuzunden sesli destek rolu tanimlandi."
          });
          await log.save();

          if (process.send) {
            process.send({
              type: "TOGGLE_VOICE_SUPPORT_RESPONSE",
              requestId,
              success: true,
              action: "added"
            });
          }
        }
      } catch (err) {
        console.error(`[Bot 1] IPC Toggle Voice Support failed:`, err.message);
        if (process.send) {
          process.send({
            type: "TOGGLE_VOICE_SUPPORT_RESPONSE",
            requestId,
            success: false,
            error: err.message
          });
        }
      }
    }
  }
});
