const config = require("../config");
const { ServerStats, FAQItem, GalleryImage, DiscordBot, SiteModule, DiscordUser } = require("../models/ServerInfo");

// Default content inserted into an empty database on first boot.
const DEFAULT_FAQS = [
  { question: "Sunucuya nasıl giriş yapabilirim?", answer: "Sunucumuza giriş yapabilmek için Discord hesabınızı sitemizle eşleştirip, whitelist başvurusunda bulunmanız gerekmektedir. Başvurunuz onaylandıktan sonra giriş yapabilirsiniz.", order: 0 },
  { question: "Whitelist başvuruları ne zaman değerlendirilir?", answer: "Başvurular yetkili ekibimiz tarafından düzenli olarak incelenir ve genellikle 24 saat içerisinde sonuçlandırılarak Discord üzerinden bilgilendirme yapılır.", order: 1 },
  { question: "Sunucu ekonomisi ne durumdadır?", answer: "Sunucumuzda dengeli ve gerçeğe yakın, emek odaklı bir ekonomi yapısı bulunmaktadır. İllegal oluşumlar ile yasal işler arasında gelir dengesi gözetilmiştir.", order: 2 },
  { question: "Rol kalitesi ve kuralları nelerdir?", answer: "Kaliteli ve keyifli bir rol ortamı oluşturmak amacıyla tüm oyuncularımızın temel FiveM rol terimlerine ve sunucumuza özel kural yönetmeliklerine uyması zorunludur.", order: 3 }
];

const DEFAULT_GALLERY = [
  { imageUrl: "/images/screen1.jpg", caption: "Şehir Merkezi Gece Turu", order: 0 },
  { imageUrl: "/images/screen2.jpg", caption: "Emniyet Müdürlüğü Konvoyu", order: 1 },
  { imageUrl: "/images/screen3.jpg", caption: "Liman Bölgesi Devriyesi", order: 2 }
];

const DEFAULT_BOTS = [
  { botId: "verification", name: "Bot 1 (Verification)", isEnabled: true, description: "Kullanıcıların Discord hesaplarını siteyle eşleştirip whitelist başvurusu yapmalarını sağlar.", statusText: "Playing Shield", statusType: "online", activityType: "playing", streamingUrl: "", avatarUrl: "" },
  { botId: "logger", name: "Bot 2 (Logger)", isEnabled: true, description: "Sunucu içi hareketleri, giriş çıkışları ve kritik olayları log kanallarına raporlar.", statusText: "Playing Shield", statusType: "online", activityType: "playing", streamingUrl: "", avatarUrl: "" },
  { botId: "moderation", name: "Bot 3 (Moderation)", isEnabled: true, description: "Sunucu güvenliğini sağlar, küfür, reklam ve spam koruması uygular.", statusText: "Playing Shield", statusType: "online", activityType: "playing", streamingUrl: "", avatarUrl: "" },
  { botId: "sync", name: "Bot 4 (Sync)", isEnabled: true, description: "Oyun içi rütbeler ile Discord rollerini senkronize eder.", statusText: "Playing Shield", statusType: "online", activityType: "playing", streamingUrl: "", avatarUrl: "" },
  { botId: "management", name: "Bot 5 (Management)", isEnabled: true, description: "Sunucu yönetimi, whitelist kontrolü ve genel istatistik raporlarını yürütür.", statusText: "Playing Shield", statusType: "online", activityType: "playing", streamingUrl: "", avatarUrl: "" }
];


const DEFAULT_MODULES = [
  { key: "applications", name: "Başvuru Sistemi", isEnabled: true, description: "Kullanıcıların whitelist veya yetkili başvurusu yapmasını sağlar." },
  { key: "donate", name: "Donate & Mağaza", isEnabled: true, description: "Kredi yükleme ve araç satın alma mağazasını aktif eder." },
  { key: "gallery", name: "Galeri Sayfası", isEnabled: true, description: "Sunucu içi ekran görüntülerinin sergilendiği galeri sayfasını aktif eder." },
  { key: "stats", name: "İstatistikler Sayfası", isEnabled: true, description: "Sunucu aktif oyuncu ve whitelist sayılarını gösteren sayfayı aktif eder." },
  { key: "team", name: "Ekibimiz Sayfası", isEnabled: true, description: "Yönetim ekibi üyelerinin listelendiği sayfayı aktif eder." },
  { key: "faq", name: "SSS Sayfası", isEnabled: true, description: "Sıkça sorulan sorular sayfasını aktif eder." },
  { key: "rules", name: "Kurallar Sayfası", isEnabled: true, description: "Sunucunun ve topluluğun kurallarının listelendiği sayfayı aktif eder." },
  { key: "penalties", name: "Cezalar Sayfası", isEnabled: true, description: "Oyuncuların ceza sicili sorgulama ve son cezaları listeleme sayfasını aktif eder." },
  { key: "admin_overview", name: "Genel Bakış (Admin)", isEnabled: true, description: "Yönetici panelindeki sunucu genel durum, os metrikleri ve canlı günlük akışı ekranını kontrol eder." },
  { key: "admin_users", name: "Kullanıcı Yönetimi (Admin)", isEnabled: true, description: "Yönetici panelindeki kayıtlı oyuncuları arama, whitelist durumu değiştirme ve silme panelini kontrol eder." },
  { key: "admin_teams", name: "Ekip Yönetimi (Admin)", isEnabled: true, description: "Yönetici panelindeki legal/illegal ekipleri kurma, üye ekleme ve silme panelini kontrol eder." },
  { key: "admin_punishments", name: "Cezalandırma Sistemi (Admin)", isEnabled: true, description: "Yönetici panelindeki ceza atma (uyarı, ban, kick) ve sicil geçmişi inceleme panelini kontrol eder." },
  { key: "admin_banned", name: "Banlananlar Paneli (Admin)", isEnabled: true, description: "Yönetici panelindeki sunucuda banlı olan kullanıcılar listesi ve unban panelini kontrol eder." },
  { key: "admin_blacklist", name: "Blacklist Paneli (Admin)", isEnabled: true, description: "Yönetici panelindeki kara listede yer alan kullanıcıların listelenmesi ve yönetilmesini kontrol eder." },
  { key: "admin_applications", name: "Başvuru Yönetimi (Admin)", isEnabled: true, description: "Yönetici panelindeki form oluşturma ve gelen başvuruları inceleme panelini kontrol eder." },
  { key: "admin_updates", name: "Güncelleme Yönetimi (Admin)", isEnabled: true, description: "Yönetici panelindeki timeline'a yama/güncelleme notları ekleme ve silme panelini kontrol eder." },
  { key: "admin_donate", name: "Donate & Kredi (Admin)", isEnabled: true, description: "Yönetici panelindeki mağaza ürünleri ekleme ve oyunculara KV kredi bakiye yükleme panelini kontrol eder." },
  { key: "admin_ranks", name: "Yetkilendirme Paneli (Admin)", isEnabled: true, description: "Yönetici panelindeki yetkililerin rütbe ve detaylı izin yetkilerini ayarlama panelini kontrol eder." },
  { key: "admin_bots", name: "Discord Bot Yönetimi (Admin)", isEnabled: true, description: "Yönetici panelindeki 5 adet Discord botunun anlık durum, presence ve kanal bağlantısı panelini kontrol eder." },
  { key: "admin_faq", name: "SSS Yönetimi (Admin)", isEnabled: true, description: "Yönetici panelindeki sıkça sorulan sorular ekleme/silme panelini kontrol eder." },
  { key: "admin_gallery", name: "Galeri Yönetimi (Admin)", isEnabled: true, description: "Yönetici panelindeki sunucu ekran görüntüleri galeri içerik panelini kontrol eder." },
  { key: "admin_theme", name: "Tema Ayarları (Admin)", isEnabled: true, description: "Yönetici panelindeki web sitesi genel tema rengini belirleme panelini kontrol eder." },
  { key: "admin_logos", name: "Logo & Banner Yönetimi (Admin)", isEnabled: true, description: "Yönetici panelindeki site logoları, bannerları ve faviconları değiştirme panelini kontrol eder." },
  { key: "maintenance", name: "Bakım Modu", isEnabled: false, description: "Aktif edildiğinde siteyi bakım moduna alır ve sadece yöneticilerin girişine izin verir." }
];

async function seedCollection(Model, documents) {
  if ((await Model.countDocuments()) === 0) {
    await Model.insertMany(documents);
  }
}

// Removes DiscordUser records whose discordId is not a valid Discord snowflake.
async function removeInvalidDiscordUsers() {
  await DiscordUser.deleteMany({ $or: [{ discordId: "none" }, { discordId: "" }, { discordId: null }, { discordId: { $not: /^\d{17,20}$/ } }] });
}

async function seedDefaults() {
  if (!(await ServerStats.findOne())) {
    await new ServerStats({
      guildId: config.discord.guildId,
      loggerGuildId: config.discord.loggerGuildId,
      whitelistRoleId: config.discord.whitelistRoleId,
      unregisteredRoleId: config.discord.unregisteredRoleId,
      voiceSupportRoleId: config.discord.voiceSupportRoleId,
      illegalCategoryId: config.discord.illegalCategoryId,
      legalCategoryId: config.discord.legalCategoryId,
      bossRoleId: config.discord.bossRoleId,
      highCommandRoleId: config.discord.highCommandRoleId
    }).save();
  }
  await seedCollection(FAQItem, DEFAULT_FAQS);
  await seedCollection(GalleryImage, DEFAULT_GALLERY);
  await seedCollection(DiscordBot, DEFAULT_BOTS);
  // Store items are never seeded: products with prices must come from the operator, and an empty store
  // would otherwise be refilled with sample products on every restart.
  await seedCollection(SiteModule, DEFAULT_MODULES);
}

module.exports = { seedDefaults, removeInvalidDiscordUsers };
