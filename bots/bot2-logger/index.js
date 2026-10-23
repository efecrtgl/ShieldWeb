const { 
  REST, 
  Routes, 
  SlashCommandBuilder, 
  EmbedBuilder, 
  ChannelType, 
  PermissionFlagsBits,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder
} = require("discord.js");
const { createBot, connectDatabase } = require("../botHelper");
const config = require("../../config");

// Connect MongoDB if not already connected
connectDatabase("Bot 2");

const standardEmojis = {
  passed: "✅",
  failed: "❌",
  yes: "✅",
  no: "❌",
  warning: "⚠️",
  mic: "🎙️",
  folder: "📁",
  search_threads: "🔍",
  bot: "🤖",
  member: "👤",
  global: "🌐",
  server_owner: "👑",
  vega_right_arrow: "➔",
  new: "✨"
};

function getEmoji(name, fallback = "") {
  return standardEmojis[name] || fallback || "";
}

function getRawEmojiId(name) {
  return null;
}

// 40 Actions Mapping definition
const LOG_ACTIONS = {
  wlGive: { name: "Whitelist Ver", channel: "wl-ver", emoji: "passed", type: "success" },
  wlTake: { name: "Whitelist Al", channel: "wl-al", emoji: "failed", type: "danger" },
  voiceSupportToggle: { name: "Sesli Destek Ver-Al", channel: "sesli-destek-ver-al", emoji: "mic", type: "warning" },
  discordBan: { name: "Discord'dan Banla", channel: "banlog", emoji: "ban", type: "danger" },
  discordUnban: { name: "Discord'dan Ban Kaldır", channel: "discord-ban-kaldir", emoji: "yes", type: "success" },
  discordKick: { name: "Discord'dan Kickle", channel: "discord-kick", emoji: "leave", type: "danger" },
  blacklistAdd: { name: "Blackliste Ekle", channel: "blacklist-ekle", emoji: "black", type: "danger" },
  blacklistRemove: { name: "Blacklistten Kaldır", channel: "blacklistten-kaldir", emoji: "white", type: "success" },
  removeAllRoles: { name: "Tüm Rolleri Kaldır", channel: "tum-rolleri-kaldir", emoji: "discord_off", type: "danger" },
  dbDeleteUser: { name: "Veritabanından Sil", channel: "veritabanindan-sil", emoji: "warning", type: "danger" },
  teamCreate: { name: "Ekip Oluştur", channel: "ekip-olustur", emoji: "folder", type: "success" },
  teamDelete: { name: "Ekip Sil", channel: "ekip-sil", emoji: "disactiv", type: "danger" },
  teamAddMember: { name: "Ekibe Üye Ekle", channel: "ekibe-uye-ekle", emoji: "join", type: "success" },
  teamRemoveMember: { name: "Ekipten Üye Kaldır", channel: "ekipten-uye-kaldir", emoji: "leave", type: "danger" },
  teamDiscordBan: { name: "Ekipi Discord'dan Banla", channel: "ekip-discord-ban", emoji: "ban", type: "danger" },
  teamDiscordKick: { name: "Ekipi Discord'dan Kickle", channel: "ekip-discord-kick", emoji: "leave", type: "danger" },
  teamBlacklistAdd: { name: "Ekipi Blackliste Ekle", channel: "ekip-blacklist-ekle", emoji: "black", type: "danger" },
  teamBlacklistRemove: { name: "Ekipi Blacklistten Çıkar", channel: "ekip-blacklistten-cikar", emoji: "white", type: "success" },
  teamVoiceSupport: { name: "Ekibe Sesli Destek Ver-Al", channel: "ekip-sesli-destek", emoji: "mic", type: "warning" },
  punishmentGive: { name: "Ceza Ver", channel: "ceza-ver", emoji: "win11_warning_icon", type: "danger" },
  punishmentRemove: { name: "Ceza Kaldır", channel: "ceza-kaldir", emoji: "yes", type: "success" },
  provideInitiative: { name: "İnsiyatif Sağla", channel: "insiyatif-sagla", emoji: "information", type: "warning" },
  userBan: { name: "Kullanıcıyı Banla", channel: "kullanici-banla", emoji: "ban", type: "danger" },
  userUnban: { name: "Kullanıcının Banını Kaldır", channel: "kullanici-ban-kaldir", emoji: "yes", type: "success" },
  userBlacklistAdd: { name: "Blackliste Kullanıcı Ekle", channel: "kullanici-blacklist-ekle", emoji: "black", type: "danger" },
  userBlacklistRemove: { name: "Blacklistten Kullanıcı Kaldır", channel: "kullanici-blacklistten-kaldir", emoji: "white", type: "success" },
  userLogin: { name: "Panel Giriş", channel: "panel-giris", emoji: "online_status", type: "info" },
  userLogout: { name: "Panel Çıkış", channel: "panel-cikis", emoji: "offline_status", type: "info" },
  rankCreate: { name: "Rütbe Oluştur", channel: "rutbe-olustur", emoji: "discord_roles_from_vega", type: "success" },
  rankEdit: { name: "Rütbe Düzenle", channel: "rutbe-duzenle", emoji: "edit", type: "warning" },
  rankDelete: { name: "Rütbe Sil", channel: "rutbe-sil", emoji: "failed", type: "danger" },
  giveCredits: { name: "Kredi Ver", channel: "kredi-ver", emoji: "card", type: "success" },
  donateCreate: { name: "Mağaza Ürün Ekle", channel: "magaza-urun-ekle", emoji: "new", type: "success" },
  donateEdit: { name: "Mağaza Ürün Düzenle", channel: "magaza-urun-duzenle", emoji: "edit", type: "warning" },
  donateDelete: { name: "Mağaza Ürün Sil", channel: "magaza-sil", emoji: "failed", type: "danger" },
  botCreate: { name: "Bot Ekle", channel: "bot-ekle", emoji: "bot", type: "success" },
  botEdit: { name: "Bot Düzenle", channel: "bot-duzenle", emoji: "bot_2", type: "warning" },
  botDelete: { name: "Bot Sil", channel: "bot-sil", emoji: "failed", type: "danger" },
  reviewApplications: { name: "Başvuru Değerlendir", channel: "basvuru-degerlendir", emoji: "application_bot", type: "warning" },
  sensitiveToggle: { name: "Hassas Veri Değişikliği", channel: "hassas-veri-degisikligi", emoji: "privacy", type: "warning" },
  fivemSetJob: { name: "FiveM Setjob Komutu", channel: "setjob", emoji: "activity", type: "warning" },
  fivemPedMenu: { name: "FiveM Ped Menu Komutu", channel: "pedmenu", emoji: "member", type: "success" },
  fivemKill: { name: "FiveM Kill Komutu", channel: "kill", emoji: "failed", type: "danger" },
  fivemRevive: { name: "FiveM Revive Komutu", channel: "revive", emoji: "passed", type: "success" },
  fivemVReturn: { name: "FiveM Araç Çek Komutu", channel: "vreturn", emoji: "activity", type: "warning" },
  fivemSendDM: { name: "FiveM DM Gönder Komutu", channel: "send-dm", emoji: "mail", type: "info" },
  chatSend: { name: "Sohbet Mesajı Gönder", channel: "sohbet-gonder", emoji: "mail", type: "info" },
  chatEdit: { name: "Sohbet Mesajı Düzenle", channel: "sohbet-duzenle", emoji: "edit", type: "warning" },
  chatDelete: { name: "Sohbet Mesajı Sil", channel: "sohbet-sil", emoji: "failed", type: "danger" }
};

const commands = [
  new SlashCommandBuilder()
    .setName("log-kurulum")
    .setDescription("Detaylı loglama kanallarını ve webhooklarını otomatik oluşturur."),
  new SlashCommandBuilder()
    .setName("log-ara")
    .setDescription("Veritabanı üzerinde derin detaylı log araması yapar.")
    .addStringOption(option =>
      option.setName("yapan")
        .setDescription("İşlemi yapan yetkilinin ID veya kullanıcı adı.")
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName("kime")
        .setDescription("İşlemin uygulandığı kişinin ID veya kullanıcı adı.")
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName("islem")
        .setDescription("Filtrelenecek eylem/işlem türü.")
        .setAutocomplete(true)
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName("detay")
        .setDescription("Log detayında aranacak anahtar kelime.")
        .setRequired(false)
    )
    .addIntegerOption(option =>
      option.setName("limit")
        .setDescription("Getirilecek maksimum kayıt sayısı (varsayılan: 5, maks: 15).")
        .setRequired(false)
    )
];

async function registerCommands(client) {
  try {
    const rest = new REST({ version: "10" }).setToken(config.bots.logger.token);
    
    // Get existing global commands
    const existingGlobal = await rest.get(
      Routes.applicationCommands(client.user.id)
    ).catch(() => []);

    const globalNeedsRedeploy = commands.some(localCmd => {
      const remoteCmd = existingGlobal.find(r => r.name === localCmd.name);
      if (!remoteCmd) return true;
      if (localCmd.description && remoteCmd.description !== localCmd.description) return true;
      const localOptions = localCmd.options || [];
      const remoteOptions = remoteCmd.options || [];
      if (localOptions.length !== remoteOptions.length) return true;
      return false;
    }) || existingGlobal.length !== commands.length;

    if (globalNeedsRedeploy) {
      console.log(`[Bot 2] Yeni veya değiştirilmiş global komutlar tespit edildi. Kaydediliyor...`);
      await rest.put(
        Routes.applicationCommands(client.user.id),
        { body: commands }
      );
      console.log(`[Bot 2] Uygulama komutları global olarak kaydedildi.`);
    } else {
      console.log(`[Bot 2] Global komutlarda değişiklik yok, tekrar kaydedilmedi.`);
    }

    // Register in guilds that the bot actually belongs to
    const targetGuilds = new Set();
    client.guilds.cache.forEach(g => targetGuilds.add(g.id));

    let loggerGuildId = config.discord.loggerGuildId;
    try {
      const ServerStats = require("../../models/ServerStats");
      const stats = await ServerStats.findOne();
      if (stats && stats.loggerGuildId && stats.loggerGuildId !== "none") {
        loggerGuildId = stats.loggerGuildId;
      }
    } catch (e) {}

    if (loggerGuildId && client.guilds.cache.has(loggerGuildId)) {
      targetGuilds.add(loggerGuildId);
    }

    for (const guildId of targetGuilds) {
      try {
        const existingGuild = await rest.get(
          Routes.applicationGuildCommands(client.user.id, guildId)
        ).catch(() => []);

        const guildNeedsRedeploy = commands.some(localCmd => {
          const remoteCmd = existingGuild.find(r => r.name === localCmd.name);
          if (!remoteCmd) return true;
          if (localCmd.description && remoteCmd.description !== localCmd.description) return true;
          const localOptions = localCmd.options || [];
          const remoteOptions = remoteCmd.options || [];
          if (localOptions.length !== remoteOptions.length) return true;
          return false;
        }) || existingGuild.length !== commands.length;

        if (guildNeedsRedeploy) {
          console.log(`[Bot 2] Yeni veya değiştirilmiş sunucu komutları tespit edildi (${guildId}). Kaydediliyor...`);
          await rest.put(
            Routes.applicationGuildCommands(client.user.id, guildId),
            { body: commands }
          );
          console.log(`[Bot 2] Uygulama komutları logger sunucusuna kaydedildi: ${guildId}`);
        } else {
          console.log(`[Bot 2] Sunucu komutlarında (${guildId}) değişiklik yok, tekrar kaydedilmedi.`);
        }
      } catch (err) {
        console.error(`[Bot 2] Sunucu (${guildId}) komutları kaydedilemedi:`, err.message);
      }
    }
  } catch (error) {
    console.error("[Bot 2] Komutlar kaydedilirken hata oluştu:", error.message);
  }
}

async function getOrCreateCategoryForChannel(guild, index = 1) {
  const categoryName = index === 1 ? "SHIELD LOGS" : `SHIELD LOGS ${index}`;
  let category = guild.channels.cache.find(c => c.name === categoryName && c.type === ChannelType.GuildCategory);
  if (!category) {
    category = await guild.channels.create({
      name: categoryName,
      type: ChannelType.GuildCategory
    }).catch(() => null);
  }
  if (!category) return null;
  const children = guild.channels.cache.filter(c => c.parentId === category.id);
  if (children.size >= 45) {
    return getOrCreateCategoryForChannel(guild, index + 1);
  }
  return category;
}

async function runLogSetup(interaction, method, client) {
  try {
    const guild = interaction.guild;
    if (!guild) {
      return interaction.editReply({ content: "Bu komut sadece bir sunucu içinde çalıştırılabilir." });
    }

    // Automatically bind this guild as the logger guild in DB and config
    try {
      const ServerStats = require("../../models/ServerStats");
      const stats = await ServerStats.findOne();
      if (stats) {
        stats.loggerGuildId = guild.id;
        await stats.save();
      }
      config.discord.loggerGuildId = guild.id;
      console.log(`[Bot 2] Logger sunucu ID güncellendi: ${guild.id}`);
    } catch (e) {
      console.error("[Bot 2] Logger sunucu ID kaydedilemedi:", e.message);
    }

    const actionKeys = Object.keys(LOG_ACTIONS);
    let createdCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    if (method === "log_kurulum_hepsi") {
      await guild.channels.fetch();
      const existingChans = guild.channels.cache.filter(c => (c.name.startsWith("kai-") || Object.values(LOG_ACTIONS).some(act => act.channel === c.name)) && c.type === ChannelType.GuildText);
      for (const chan of existingChans.values()) {
        try {
          await chan.delete().catch(() => {});
        } catch (e) {}
      }
      const existingCats = guild.channels.cache.filter(c => (c.name.startsWith("SHIELD LOGS") || c.name.startsWith("STARV LOGS") || c.name.startsWith("ARCANIUM LOGS")) && c.type === ChannelType.GuildCategory);
      for (const cat of existingCats.values()) {
        try {
          await cat.delete().catch(() => {});
        } catch (e) {}
      }
    }

    for (const key of actionKeys) {
      try {
        const act = LOG_ACTIONS[key];
        const channelName = act.channel;

        if (method === "log_kurulum_eksik") {
          let existsDiscord = guild.channels.cache.find(c => (c.name === channelName || c.name === `kai-${channelName}`) && c.type === ChannelType.GuildText);
          if (!existsDiscord) {
            await guild.channels.fetch();
            existsDiscord = guild.channels.cache.find(c => (c.name === channelName || c.name === `kai-${channelName}`) && c.type === ChannelType.GuildText);
          }
          if (existsDiscord) {
            skippedCount++;
            continue;
          }
        }

        const category = await getOrCreateCategoryForChannel(guild);
        if (!category) {
          failedCount++;
          continue;
        }

        await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: category.id
        });

        createdCount++;
      } catch (err) {
        console.error(`[Bot 2] Failed to setup channel for ${key}:`, err.message);
        failedCount++;
      }
    }

    return interaction.editReply({
      content: `Kurulum tamamlandı!\n` +
               `${getEmoji("new")} Yeni oluşturulan kanal sayısı: **${createdCount}**\n` +
               `${getEmoji("yes")} Atlanan (zaten mevcut) kanal sayısı: **${skippedCount}**\n` +
               `${getEmoji("failed")} Başarısız olan kanal sayısı: **${failedCount}**`
    });
  } catch (err) {
    console.error("[Bot 2] runLogSetup main wrapper error:", err);
    return interaction.editReply({
      content: `Kurulum sırasında kritik hata oluştu: ${err.message}`
    });
  }
}

async function autoRenameKaiChannels(client) {
  try {
    let loggerGuildId = config.discord.loggerGuildId;
    const ServerStats = require("../../models/ServerStats");
    const stats = await ServerStats.findOne();
    if (stats && stats.loggerGuildId) {
      loggerGuildId = stats.loggerGuildId;
    }
    if (!loggerGuildId || loggerGuildId === "none") return;

    const guild = client.guilds.cache.get(loggerGuildId) || await client.guilds.fetch(loggerGuildId).catch(() => null);
    if (!guild) return;

    await guild.channels.fetch().catch(() => {});
    const kaiChans = guild.channels.cache.filter(c => c.name.startsWith("kai-") && c.type === ChannelType.GuildText);
    if (kaiChans.size > 0) {
      console.log(`[Bot 2] ${kaiChans.size} adet 'kai-' ile başlayan kanal tespit edildi. İsimler güncelleniyor...`);
      for (const chan of kaiChans.values()) {
        const cleanName = chan.name.replace(/^kai-/, "");
        try {
          await chan.setName(cleanName, "'kai-' öneki kaldırıldı");
          console.log(`[Bot 2] Kanal ismi güncellendi: ${chan.name} -> ${cleanName}`);
        } catch (err) {
          console.error(`[Bot 2] ${chan.name} kanalı yeniden adlandırılamadı:`, err.message);
        }
      }
    }
  } catch (e) {
    console.error("[Bot 2] Auto rename kai channels failed:", e.message);
  }
}

createBot("logger", "Bot 2 (Logger)", config.bots.logger.token, {
  onReady: async (client) => {
    await registerCommands(client);
    await autoRenameKaiChannels(client);
  },

  onInteraction: async (interaction, client) => {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === "log-ara") {
        const focusedOption = interaction.options.getFocused(true);
        if (focusedOption.name === "islem") {
          const focusedValue = focusedOption.value.toLowerCase();
          const choices = Object.keys(LOG_ACTIONS).map(key => ({
            name: `${LOG_ACTIONS[key].name} (${key})`,
            value: key
          }));
          const filtered = choices.filter(choice => 
            choice.name.toLowerCase().includes(focusedValue) || 
            choice.value.toLowerCase().includes(focusedValue)
          ).slice(0, 25);
          await interaction.respond(filtered);
        }
      }
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId === "log_kurulum_eksik" || interaction.customId === "log_kurulum_hepsi") {
        const isSuperuser = config.isSuperuser(interaction.user.id);
        const isServerAdmin = interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator);

        if (!isSuperuser && !isServerAdmin) {
          return interaction.reply({
            content: "Bu kurulum işlemini başlatmak için Superuser veya Administrator yetkiniz olmalıdır.",
            ephemeral: true
          }).catch(() => {});
        }

        await interaction.deferReply({ ephemeral: true }).catch(() => {});
        const method = interaction.customId;
        runLogSetup(interaction, method, client);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "log-kurulum") {
      try {
        await interaction.deferReply({ ephemeral: true });

        const isSuperuser = config.isSuperuser(interaction.user.id);
        
        const isServerAdmin = interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator);

        if (!isSuperuser && !isServerAdmin) {
          return interaction.editReply({
            content: "Bu kurulum komutunu kullanmak için Superuser veya Administrator yetkiniz olmalıdır."
          });
        }

        const newEmojiId = getRawEmojiId("new");
        const yesEmojiId = getRawEmojiId("yes");

        const embed = new EmbedBuilder()
          .setTitle(`${getEmoji("folder", getEmoji("bot", ""))} Log Kanalları Kurulum Menüsü`)
          .setDescription(
            "Lütfen kurmak istediğiniz yöntemi seçin:\n\n" +
            `${getEmoji("new")} **Eksikleri Kur:** Sadece veritabanında veya sunucuda eksik olan log kanallarını tespit eder ve oluşturur.\n` +
            `${getEmoji("yes")} **Hepsini Sıfırla ve Kur:** Mevcut tüm log kanallarını siler ve tüm kanalları sıfırdan oluşturur.`
          )
          .setColor(0x3B82F6);

        const buttonEksik = new ButtonBuilder()
          .setCustomId("log_kurulum_eksik")
          .setLabel("Eksikleri Kur")
          .setStyle(ButtonStyle.Primary);
        if (newEmojiId) buttonEksik.setEmoji(newEmojiId);

        const buttonHepsi = new ButtonBuilder()
          .setCustomId("log_kurulum_hepsi")
          .setLabel("Hepsini Sıfırla ve Kur")
          .setStyle(ButtonStyle.Danger);
        if (yesEmojiId) buttonHepsi.setEmoji(yesEmojiId);

        const row = new ActionRowBuilder().addComponents(buttonEksik, buttonHepsi);

        await interaction.editReply({
          embeds: [embed],
          components: [row]
        });
      } catch (err) {
        console.error("log-kurulum komutu hatası:", err);
        if (interaction.isRepliable()) {
          await interaction.editReply({
            content: `Kurulum başlatılırken bir hata oluştu: ${err.message}`
          }).catch(() => {});
        }
      }
      return;
    } else if (interaction.commandName === "log-ara") {
      try {
        await interaction.deferReply({ ephemeral: true });

        const isSuperuser = config.isSuperuser(interaction.user.id);
        const isServerAdmin = interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator);

        if (!isSuperuser && !isServerAdmin) {
          return interaction.editReply({
            content: "Bu komutu kullanmak için Superuser veya Administrator yetkiniz olmalıdır."
          });
        }

        const yapan = interaction.options.getString("yapan");
        const kime = interaction.options.getString("kime");
        const islem = interaction.options.getString("islem");
        const detay = interaction.options.getString("detay");
        const limit = interaction.options.getInteger("limit") || 5;

        const query = {};
        if (yapan) {
          query.$or = [
            { executorId: yapan },
            { executorUsername: { $regex: yapan, $options: "i" } }
          ];
        }
        if (kime) {
          query.$and = query.$and || [];
          query.$and.push({
            $or: [
              { targetId: kime },
              { targetUsername: { $regex: kime, $options: "i" } }
            ]
          });
        }
        if (islem) {
          query.actionType = islem;
        }
        if (detay) {
          query.details = { $regex: detay, $options: "i" };
        }

        const ActionLog = require("../../models/ActionLog");
        const logs = await ActionLog.find(query).sort({ timestamp: -1 }).limit(Math.min(limit, 15));

        if (logs.length === 0) {
          const actEmoji = getEmoji("failed", "");
          return interaction.editReply({
            content: `${actEmoji} Arama kriterlerine uygun hiçbir log kaydı bulunamadı.`
          });
        }

        const embed = new EmbedBuilder()
          .setTitle(`${getEmoji("search_threads", "")} Detaylı Log Arama Sonuçları`)
          .setDescription(`Arama kriterlerine uyan son **${logs.length}** kayıt listelenmiştir:`)
          .setColor(0x3B82F6)
          .setTimestamp();

        logs.forEach((log, index) => {
          const actConfig = LOG_ACTIONS[log.actionType] || { name: log.actionType, emoji: "info" };
          const emoji = getEmoji(actConfig.emoji, getEmoji("bot", ""));
          const timeString = log.timestamp ? `<t:${Math.floor(log.timestamp.getTime() / 1000)}:R>` : "Bilinmiyor";
          
          let logDetails = `**Yetkili:** \`${log.executorUsername}\` (\`${log.executorId}\`)\n` +
                           `**İşlem:** ${emoji} **${actConfig.name}**\n` +
                           `**Zaman:** ${timeString}\n` +
                           `**Detay:** ${log.details || "Yok"}`;

          if (log.targetId) {
            logDetails += `\n**Hedef:** \`${log.targetUsername || "Bilinmiyor"}\` (\`${log.targetId}\`)`;
          }
          if (log.executorIp) {
            logDetails += `\n**IP:** ||${log.executorIp}||`;
          }

          embed.addFields({
            name: `${getEmoji("folder", "")} Kayıt #${index + 1}`,
            value: logDetails,
            inline: false
          });
        });

        embed.setFooter({ text: `${config.footer || "Shield Logs"}` });

        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.error("Log search failed:", err);
        return interaction.editReply({
          content: `Arama sırasında hata oluştu: ${err.message}`
        });
      }
    }
  },

  onMessage: async (msg, client) => {
    if (msg.type === "LOG_ACTION") {
      const { action, data } = msg;
      const actConfig = LOG_ACTIONS[action];
      if (!actConfig) return;

      try {
        const ActionLog = require("../../models/ActionLog");
        const logRecord = new ActionLog({
          executorId: data.executor ? data.executor.id : "system",
          executorUsername: data.executor ? data.executor.username : "System",
          targetId: data.target ? data.target.id : "",
          targetUsername: data.target ? data.target.username : "",
          actionType: action,
          details: data.details || "",
          timestamp: data.timestamp ? new Date(data.timestamp) : new Date(),
          executorIp: data.executor && data.executor.ip ? data.executor.ip : "",
          context: data.context || "Web Panel",
          rawData: data
        });
        await logRecord.save();

        let guildId = config.discord.loggerGuildId;
        try {
          const ServerStats = require("../../models/ServerStats");
          const stats = await ServerStats.findOne();
          if (stats && stats.loggerGuildId && stats.loggerGuildId !== "none") {
            guildId = stats.loggerGuildId;
          }
        } catch (e) {}
        if (!guildId) guildId = config.discord.guildId;

        const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return;

        const channelName = actConfig.channel;
        let channel = guild.channels.cache.find(c => (c.name === channelName || c.name === `kai-${channelName}`) && c.type === ChannelType.GuildText);
        if (!channel) {
          await guild.channels.fetch();
          channel = guild.channels.cache.find(c => (c.name === channelName || c.name === `kai-${channelName}`) && c.type === ChannelType.GuildText);
        }
        if (!channel) return;

        const embedColor = actConfig.type === "success" ? 0x10B981 :
                           actConfig.type === "danger" ? 0xEF4444 :
                           actConfig.type === "warning" ? 0xF59E0B : 0x3B82F6;

        const executorText = data.executor ? 
          `**Kullanıcı:** \`${data.executor.username}\`\n**Discord ID:** \`${data.executor.id}\`` : 
          "Sistem / Otomatik";

        const executorIp = data.executor && data.executor.ip ? `||${data.executor.ip}||` : "Bilinmiyor";

        const actEmoji = getEmoji(actConfig.emoji, getEmoji("bot", ""));
        const memberEmoji = getEmoji("member", getEmoji("bot", ""));
        const globalEmoji = getEmoji("global", getEmoji("bot", ""));
        const previewEmoji = getEmoji("search_threads", getEmoji("bot", ""));
        const arrowEmoji = getEmoji("vega_right_arrow", "");

        const embed = new EmbedBuilder()
          .setTitle(`${actEmoji} ${actConfig.name}`)
          .setColor(embedColor)
          .setTimestamp(data.timestamp ? new Date(data.timestamp) : new Date());

        embed.addFields({
          name: `${memberEmoji} Yetkili / Eylemi Yapan`,
          value: executorText,
          inline: true
        });

        embed.addFields({
          name: `${globalEmoji} Eylem Konumu & IP`,
          value: `**IP:** ${executorIp}\n**Platform:** \`${data.context || "Web Panel"}\``,
          inline: true
        });

        embed.addFields({
          name: `${previewEmoji} Eylem Detayı`,
          value: `${arrowEmoji} ${data.details || "Detay belirtilmedi."}`,
          inline: false
        });

        if (data.target) {
          const targetEmoji = getEmoji("server_owner", getEmoji("bot", ""));
          const targetDataVal = data.target.data ? `\n\`\`\`json\n${JSON.stringify(data.target.data, null, 2).substring(0, 500)}\n\`\`\`` : "";
          
          embed.addFields({
            name: `${targetEmoji} Eylem Uygulanan Kişi`,
            value: `**Kullanıcı:** \`${data.target.username || "Bilinmiyor"}\`\n**Discord ID:** \`${data.target.id || "Bilinmiyor"}\` ${targetDataVal}`,
            inline: false
          });
        }

        if (data.executor && data.executor.data) {
          const dataEmoji = getEmoji("folder", getEmoji("bot", ""));
          embed.addFields({
            name: `${dataEmoji} Yetkili Verileri`,
            value: `\`\`\`json\n${JSON.stringify(data.executor.data, null, 2).substring(0, 500)}\n\`\`\``,
            inline: false
          });
        }

        embed.setFooter({ text: `${config.footer || "Shield Logs"}`, iconURL: client.user.displayAvatarURL() });

        await channel.send({
          embeds: [embed]
        });

      } catch (err) {
        console.error(`[Bot 2] Failed to execute log action ${action}:`, err.message);
      }
    }
  }
});
