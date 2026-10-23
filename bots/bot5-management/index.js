const { createBot, connectDatabase } = require("../botHelper");
const config = require("../../config");

connectDatabase("Bot 5");

createBot("management", "Bot 5 (Management)", config.bots.management.token, {
  async onReady(client) {
    console.log("[Bot 5 (Management)] Yönetim Botu hazır. Slash komutları temizleniyor...");

    try {
      const guildId = config.discord.guildId;
      const guild = client.guilds.cache.get(guildId) || client.guilds.cache.first();
      if (guild) {
        await guild.commands.set([]);
        console.log(`[Bot 5 (Management)] Sunucu (${guild.name || guild.id}) slash komutları temizlendi.`);
      }
      await client.application.commands.set([]);
      console.log("[Bot 5 (Management)] Global slash komutları temizlendi.");
    } catch (err) {
      console.error("[Bot 5 (Management)] Slash komutları temizlenirken hata:", err.message);
    }
  }
});
