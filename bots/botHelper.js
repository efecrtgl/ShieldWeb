const { Client, GatewayIntentBits, ActivityType, Events, EmbedBuilder } = require("discord.js");
const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus } = require("@discordjs/voice");
const mongoose = require("mongoose");
const config = require("../config");
const ServerStats = require("../models/ServerStats");
const DiscordUser = require("../models/DiscordUser");
const DiscordBot = require("../models/DiscordBot");

// Each bot runs in its own process and needs its own MongoDB connection.
function connectDatabase(botLabel) {
  if (mongoose.connection.readyState !== 0) return;
  mongoose.connect(config.mongodb.uri).catch(err => {
    console.error(`[${botLabel}] MongoDB connection failed:`, err.message);
  });
}

/**
 * Creates and initializes a Discord bot instance.
 * @param {string} botId - The unique ID of the bot (e.g., 'verification')
 * @param {string} botName - The human-readable name of the bot
 * @param {string} token - The Discord bot token
 * @param {object} options - Optional callbacks and configurations (onReady, onInteraction, onMessage)
 */
function createBot(botId, botName, token, options = {}) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

  let currentConfig = null;
  let pendingVoiceChannelId = null;

  async function handleVoiceJoin(voiceChannelId) {
    if (voiceChannelId !== undefined) {
      pendingVoiceChannelId = voiceChannelId;
    }
    if (!client || !client.isReady() || !client.user) {
      console.log(`[${botName}] Ses kanalına katılım sıraya alındı: ${voiceChannelId} (ClientReady bekleniyor)`);
      return;
    }

    const targetChannelId = (voiceChannelId || pendingVoiceChannelId || "").toString().trim();

    if (targetChannelId) {
      try {
        let channel = client.channels.cache.get(targetChannelId);
        if (!channel) {
          channel = await client.channels.fetch(targetChannelId).catch(() => null);
        }

        let guild = channel ? channel.guild : null;
        if (!guild) {
          let guildId = config.discord.guildId;
          try {
            const stats = await ServerStats.findOne();
            if (stats && stats.guildId) guildId = stats.guildId;
          } catch (e) {}
          guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        }

        if (guild) {
          let connection = getVoiceConnection(guild.id);
          if (!connection) {
            connection = joinVoiceChannel({
              channelId: targetChannelId,
              guildId: guild.id,
              adapterCreator: guild.voiceAdapterCreator,
              selfDeaf: true,
              selfMute: false
            });

            console.log(`[${botName}] Ses kanalına başarıyla bağlandı: ${targetChannelId} (Sunucu: ${guild.name || guild.id})`);

            connection.on('error', (error) => {
              console.log(`[${botName}] Ses Bağlantı Hatası: ${error.message}`);
              try {
                connection.destroy();
              } catch (e) {}
            });

            connection.on(VoiceConnectionStatus.Failed, () => {
              try {
                connection.destroy();
              } catch (e) {}
            });
          } else {
            if (connection.joinConfig.channelId !== targetChannelId) {
              connection.rejoin({
                channelId: targetChannelId,
                selfDeaf: true,
                selfMute: false
              });
              console.log(`[${botName}] Ses kanalına yeniden bağlandı: ${targetChannelId}`);
            }
          }
        } else {
          console.log(`[${botName}] Ses kanalı (${targetChannelId}) için sunucu bulunamadı.`);
        }
      } catch (err) {
        console.log(`[${botName}] Voice channel join failed: ${err.message}`);
      }
    } else {
      client.guilds.cache.forEach(g => {
        const conn = getVoiceConnection(g.id);
        if (conn) {
          try {
            conn.destroy();
          } catch (e) {}
        }
      });
    }
  }

  let presenceTimeout = null;
  function flashPresence(tempText, durationMs = 2500) {
    if (!client.user) return;
    if (currentConfig && currentConfig.errorMode === true) {
      return; // Skip flash presence if error mode is active
    }
    if (presenceTimeout) {
      clearTimeout(presenceTimeout);
    }
    
    client.user.setPresence({
      activities: [{ name: tempText, type: ActivityType.Playing }],
      status: "idle"
    });
    
    presenceTimeout = setTimeout(() => {
      if (currentConfig) {
        applyConfig(currentConfig);
      }
    }, durationMs);
  }

  function applyConfig(cfg) {
    if (!client.user) return;
    
    const isErrorMode = cfg.errorMode === true || cfg.errorMode === "true";
    console.log(`[${botName}] Durum Güncelleniyor - Hata Modu: ${isErrorMode}, Yazı: ${cfg.statusText || "Varsayılan"}`);
    
    const presenceText = isErrorMode ? "⚠️ Hata Bulunuyor!" : (cfg.statusText || "Playing Shield");
    const presenceStatus = isErrorMode ? "dnd" : (cfg.statusType || "online");

    const activity = {
      name: presenceText
    };
    
    if (cfg.activityType === "streaming" && !isErrorMode) {
      activity.type = ActivityType.Streaming;
      activity.url = cfg.streamingUrl || "https://twitch.tv/shieldrp";
    } else if (cfg.activityType === "listening" && !isErrorMode) {
      activity.type = ActivityType.Listening;
    } else if (cfg.activityType === "watching" && !isErrorMode) {
      activity.type = ActivityType.Watching;
    } else {
      activity.type = ActivityType.Playing;
    }
    
    client.user.setPresence({
      activities: [activity],
      status: presenceStatus
    });
    
    if (cfg.avatarUrl) {
      const currentAvatar = client.user.displayAvatarURL();
      // Only set avatar if the bot doesn't have one or has a default one, to avoid rate limits
      if (!currentAvatar || currentAvatar.includes("/embed/avatars/")) {
        client.user.setAvatar(cfg.avatarUrl).catch(err => {
          console.log(`[${botName}] Avatar update failed: ${err.message}`);
        });
      }
    }
 
    handleVoiceJoin(cfg.voiceChannelId);
  }

  let lastSyncedVoiceChannelId = undefined;
  let lastSyncedPresenceStr = "";

  client.once(Events.ClientReady, async () => {
    console.log(`${botName} ready as ${client.user.tag}`);
    if (process.send) {
      process.send({ type: "BOT_READY", clientId: client.user.id });
    }
    flashPresence("⚙️ Bot Başlatılıyor...", 4000);
    if (currentConfig) {
      applyConfig(currentConfig);
    }

    // Auto-sync configuration from MongoDB every 3 seconds
    setInterval(async () => {
      try {
        const dbBot = await DiscordBot.findOne({ botId });
        if (dbBot && dbBot.isEnabled) {
          // Check voiceChannelId change
          const targetVoiceId = (dbBot.voiceChannelId || "").toString().trim();
          if (lastSyncedVoiceChannelId !== targetVoiceId) {
            lastSyncedVoiceChannelId = targetVoiceId;
            handleVoiceJoin(targetVoiceId);
          }

          // Check presence change
          const currentPresenceStr = `${dbBot.statusText}|${dbBot.statusType}|${dbBot.activityType}|${dbBot.streamingUrl}`;
          if (lastSyncedPresenceStr !== currentPresenceStr) {
            lastSyncedPresenceStr = currentPresenceStr;
            currentConfig = {
              statusText: dbBot.statusText,
              statusType: dbBot.statusType,
              activityType: dbBot.activityType,
              streamingUrl: dbBot.streamingUrl,
              avatarUrl: dbBot.avatarUrl,
              voiceChannelId: targetVoiceId
            };
            applyConfig(currentConfig);
          }
        }
      } catch (err) {}
    }, 3000);

    if (pendingVoiceChannelId || (currentConfig && currentConfig.voiceChannelId)) {
      handleVoiceJoin(pendingVoiceChannelId || (currentConfig && currentConfig.voiceChannelId));
    }
    if (options.onReady) {
      options.onReady(client);
    }
  });

  if (options.onInteraction) {
    client.on(Events.InteractionCreate, async (interaction) => {
      try {
        if (interaction.isCommand()) {
          flashPresence(`🛠️ /${interaction.commandName} Çalıştırılıyor...`, 3000);
        } else if (interaction.isButton()) {
          flashPresence("🖱️ Buton Tıklaması İşleniyor...", 2500);
        } else {
          flashPresence("⚡ Etkileşim İşleniyor...", 2000);
        }

        const allowedGuilds = new Set([
          config.discord.guildId,
          config.discord.loggerGuildId
        ].filter(Boolean));

        try {
          const stats = await ServerStats.findOne();
          if (stats) {
            if (stats.guildId) allowedGuilds.add(stats.guildId);
            if (stats.loggerGuildId && stats.loggerGuildId !== "none") allowedGuilds.add(stats.loggerGuildId);
          }
        } catch (err) {}

        // If the client is actually in this guild, permit interaction
        if (interaction.guildId && client.guilds.cache.has(interaction.guildId)) {
          allowedGuilds.add(interaction.guildId);
        }

        if (interaction.guildId && !allowedGuilds.has(interaction.guildId)) {
          console.warn(`[${botName}] Yetkisiz sunucudan gelen etkileşim reddedildi: ${interaction.guildId}`);
          if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            await interaction.reply({
              content: "⚠️ Bu bot bu sunucuda kullanılamaz.",
              ephemeral: true
            }).catch(() => {});
          }
          return;
        }

        await options.onInteraction(interaction, client);
      } catch (err) {
        console.error(`[${botName}] onInteraction yakalanan hata:`, err);
        if (interaction.isRepliable()) {
          const errMsg = {
            content: "⚠️ İşlem gerçekleştirilirken bir hata oluştu: " + (err.message || "Bilinmeyen hata"),
            ephemeral: true
          };
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply(errMsg).catch(() => {});
          } else {
            await interaction.reply(errMsg).catch(() => {});
          }
        }
      }
    });
  }

  process.on("message", (msg) => {
    console.log(`[${botName}] Alınan Sinyal: type=${msg ? msg.type : "tanımsız"}`);
    if (msg.type === "INIT_CONFIG" || msg.type === "UPDATE_CONFIG") {
      currentConfig = msg;
      if (client.isReady()) {
        applyConfig(msg);
      }
    } else if (msg.type === "VOICE_JOIN_REQUEST") {
      flashPresence("🔊 Ses Kanalına Katılınıyor...", 3000);
      if (currentConfig) {
        currentConfig.voiceChannelId = msg.channelId;
      }
      handleVoiceJoin(msg.channelId);
    } else if (msg.type === "UPDATE_PROFILE") {
      if (client.user) {
        if (msg.name && msg.name !== client.user.username) {
          client.user.setUsername(msg.name).then(() => {
            console.log(`[${botName}] Discord kullanıcı adı güncellendi: ${msg.name}`);
          }).catch(err => {
            console.error(`[${botName}] Discord kullanıcı adı güncellenemedi: ${err.message}`);
          });
        }
        if (msg.avatarUrl) {
          client.user.setAvatar(msg.avatarUrl).then(() => {
            console.log(`[${botName}] Discord profil resmi güncellendi.`);
          }).catch(err => {
            console.error(`[${botName}] Discord profil resmi güncellenemedi: ${err.message}`);
          });
        }
      }
    } else if (msg.type === "GET_DISCORD_LIVE_STATS") {
      (async () => {
        try {
          let guildId = config.discord.guildId;
          try {
            const stats = await ServerStats.findOne();
            if (stats && stats.guildId) guildId = stats.guildId;
          } catch (e) {}

          let guild = client.guilds.cache.get(guildId) || client.guilds.cache.first();
          if (!guild && guildId && /^\d{17,20}$/.test(guildId)) {
            guild = await client.guilds.fetch(guildId).catch(() => null);
          }
          if (!guild) {
            if (process.send) process.send({ type: "GET_DISCORD_LIVE_STATS_RESPONSE", requestId: msg.requestId, error: "Sunucu bulunamadı." });
            return;
          }

          // Live Total Discord Users directly from Gateway (instant, no rate-limits)
          const totalUsers = guild.memberCount || guild.members.cache.size;

          // Live Whitelist & Staff Count directly from Database
          const [whitelistCount, staffCount] = await Promise.all([
            DiscordUser.countDocuments({ isWhitelist: true }),
            DiscordUser.countDocuments({ rankId: { $ne: null } })
          ]);

          if (process.send) {
            process.send({
              type: "GET_DISCORD_LIVE_STATS_RESPONSE",
              requestId: msg.requestId,
              success: true,
              stats: {
                totalUsers,
                staffCount,
                whitelistCount
              }
            });
          }
        } catch (err) {
          if (process.send) {
            process.send({
              type: "GET_DISCORD_LIVE_STATS_RESPONSE",
              requestId: msg.requestId,
              error: err.message
            });
          }
        }
      })();
    } else if (msg.type === "FIND_USER_VOICE_REQUEST") {
      (async () => {
        try {
          let guildId = config.discord.guildId;
          try {
            const stats = await ServerStats.findOne();
            if (stats && stats.guildId) guildId = stats.guildId;
          } catch (e) {}

          const guild = client.guilds.cache.get(guildId);
          if (!guild) {
            if (process.send) process.send({ type: "FIND_USER_VOICE_RESPONSE", requestId: msg.requestId, error: "Sunucu bulunamadı." });
            return;
          }

          const member = await guild.members.fetch(msg.targetUserId).catch(() => null);
          if (!member) {
            if (process.send) process.send({ type: "FIND_USER_VOICE_RESPONSE", requestId: msg.requestId, error: "Kullanıcı sunucuda bulunamadı." });
            return;
          }

          const voiceState = member.voice;
          if (!voiceState || !voiceState.channelId) {
            if (process.send) process.send({ type: "FIND_USER_VOICE_RESPONSE", requestId: msg.requestId, error: "Kullanıcı herhangi bir ses kanalında bulunmuyor." });
            return;
          }

          if (process.send) process.send({ type: "FIND_USER_VOICE_RESPONSE", requestId: msg.requestId, channelId: voiceState.channelId });
        } catch (err) {
          if (process.send) process.send({ type: "FIND_USER_VOICE_RESPONSE", requestId: msg.requestId, error: err.message });
        }
      })();
    } else if (msg.type === "SEND_EXECUTOR_DM_ALERT") {
      (async () => {
        try {
          const { executorId, title, teamName, failedIds, reason } = msg;
          if (!executorId || !/^\d{17,20}$/.test(executorId)) return;

          const targetUser = await client.users.fetch(executorId).catch(() => null);
          if (targetUser) {
            const embed = new EmbedBuilder()
              .setTitle(title || "🚨 [İŞLEM BİLDİRİMİ / TAMAMLANAMADI]")
              .setColor(0xEF4444)
              .setDescription(`**${teamName || "Sistem"}** üzerinde işlem yapılırken bazı ID'ler için işlem tamamlanamadı.`)
              .addFields(
                { name: "Hatalı / Tamamlanamayan ID'ler", value: `\`\`\`\n${Array.isArray(failedIds) ? failedIds.join(", ") : failedIds}\n\`\`\``, inline: false },
                { name: "Başarısızlık Sebebi", value: reason || "Kullanıcı sunucuda bulunamadı veya yetki yetersiz.", inline: false }
              )
              .setFooter({ text: `${config.footer || "Shield System Alert"}` })
              .setTimestamp();

            await targetUser.send({ embeds: [embed] }).catch(err => {
              console.warn(`[${botName}] Executor DM gönderilemedi (${executorId}):`, err.message);
            });
            console.log(`[${botName}] Executor DM uyarısı (${executorId}) kullanıcısına başarıyla gönderildi.`);
          }
        } catch (err) {
          console.error(`[${botName}] Executor DM gönderme hatası:`, err.message);
        }
      })();
    } else {
      if (options.onMessage) {
        options.onMessage(msg, client);
      }
    }
  });

  client.login(token).catch((err) => {
    console.log(`${botName} failed to login: ${err.message}`);
  });

  return client;
}

module.exports = { createBot, connectDatabase };
