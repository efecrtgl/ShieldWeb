const config = require("../config");
const { ServerStats, FAQItem, GalleryImage, DiscordBot, DonateItem, SiteModule, DiscordUser } = require("../models/ServerInfo");

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

const DEFAULT_DONATE_ITEMS = [
  { name: "Porsche 911 GT3", description: "Muhteşem yol tutuşu ve 500 beygirlik gücüyle pistlerin efendisi.", price: 1000, category: "araba", imageUrl: "https://images.unsplash.com/photo-1614162692292-7ac56d7f7f1e?auto=format&fit=crop&w=600&q=80", order: 0 },
  { name: "Audi RS6 Avant", description: "V8 çift turbo motorlu, aile boyu süper spor vagon.", price: 800, category: "araba", imageUrl: "https://images.unsplash.com/photo-1606016159991-dfe4f2746ad5?auto=format&fit=crop&w=600&q=80", order: 1 },
  { name: "BMW M5 CS", description: "Sınırlı üretim, 635 beygirlik pist odaklı lüks sedan.", price: 750, category: "araba", imageUrl: "https://images.unsplash.com/photo-1617814076367-b759c7d7e738?auto=format&fit=crop&w=600&q=80", order: 2 },
  { name: "Yamaha YZF-R6", description: "Pist genleriyle doğmuş, 16.000 devir çeviren efsanevi supersport.", price: 400, category: "motorsiklet", imageUrl: "https://images.unsplash.com/photo-1568772585407-9361f9bf3a87?auto=format&fit=crop&w=600&q=80", order: 3 },
  { name: "Kawasaki Ninja H2R", description: "Supercharged motoruyla 310 beygir üreten, pistlerin sınırlarını zorlayan canavar.", price: 900, category: "motorsiklet", imageUrl: "https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=600&q=80", order: 4 },
  { name: "Ducati Panigale V4", description: "İtalyan tasarımı, MotoGP teknolojisiyle donatılmış V4 motorlu şaheser.", price: 850, category: "motorsiklet", imageUrl: "https://images.unsplash.com/photo-1599819811279-d5ad9cccf838?auto=format&fit=crop&w=600&q=80", order: 5 },
  { name: "Mekanik", description: "Araç modifikasyonları ve tamir işlemleri için resmi mekanik işletmesi.", price: 6000, category: "isletme", imageUrl: "https://images.unsplash.com/photo-1517524206127-48bbd363f3d7?auto=format&fit=crop&w=600&q=80", order: 6 },
  { name: "Galeri", description: "Şehirdeki standart araçların satış haklarına sahip resmi galeri.", price: 15000, category: "isletme", imageUrl: "https://images.unsplash.com/photo-1562141960-c151e49c253d?auto=format&fit=crop&w=600&q=80", order: 7 },
  { name: "MK2 Galeri", description: "Yüksek segment ve spor araçların satış haklarına sahip lüks galeri.", price: 25000, category: "isletme", imageUrl: "https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=600&q=80", order: 8 },
  { name: "Gunshop", description: "Yasal hafif silah ve mühimmat satışı yapma yetkisine sahip resmi silah dükkanı.", price: 6000, category: "isletme", imageUrl: "https://images.unsplash.com/photo-1595590424283-b8f17842773f?auto=format&fit=crop&w=600&q=80", order: 9 },
  { name: "Galeri Yanı Gunshop", description: "Galeri bölgesinin yanındaki avantajlı konuma sahip yasal silah dükkanı.", price: 8000, category: "isletme", imageUrl: "https://images.unsplash.com/photo-1584282479918-62280d8f074d?auto=format&fit=crop&w=600&q=80", order: 10 },
  { name: "Lojistik", description: "Şehir içi ve dışı kargo, nakliye ve teslimat operasyonlarını yöneten resmi lojistik firması.", price: 15000, category: "isletme", imageUrl: "https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?auto=format&fit=crop&w=600&q=80", order: 11 },
  { name: "Emlakçı", description: "Şehirdeki ev, malikane ve işyeri mülklerinin satış ve kiralama yetkisine sahip emlak ofisi.", price: 7000, category: "isletme", imageUrl: "https://images.unsplash.com/photo-1564013799919-ab600027ffc6?auto=format&fit=crop&w=600&q=80", order: 12 },
  { name: "Casino", description: "Şehirdeki tüm şans oyunları, kumar masaları ve eğlence etkinliklerini düzenleyen resmi casino.", price: 20000, category: "isletme", imageUrl: "https://images.unsplash.com/photo-1596838132731-3301c3fd4317?auto=format&fit=crop&w=600&q=80", order: 13 },
  { name: "Pawnshop", description: "Değerli eşya, maden ve antika alım-satımı yapabileceğiniz rehin dükkanı.", price: 7500, category: "isletme", imageUrl: "https://images.unsplash.com/photo-1578575437130-527eed3abbec?auto=format&fit=crop&w=600&q=80", order: 14 },
  { name: "Hurdacı", description: "Metal atıklar, araç parçaları ve geri dönüştürülebilir malzemelerin alım-satım merkezi.", price: 3500, category: "isletme", imageUrl: "https://images.unsplash.com/photo-1530587191325-3db32d826c18?auto=format&fit=crop&w=600&q=80", order: 15 },
  { name: "Silah Tamircisi", description: "Yasal silahların bakım, onarım ve modifikasyon işlemlerinin yapıldığı uzman atölye.", price: 6000, category: "isletme", imageUrl: "https://images.unsplash.com/photo-1486006920555-c77dce18193b?auto=format&fit=crop&w=600&q=80", order: 16 },
  { name: "İllegal Mekanik", description: "Kayıt dışı modifiye, plaka değişimi ve zırh kaplama gibi yeraltı mekanik işleri.", price: 6000, category: "illegal", imageUrl: "https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?auto=format&fit=crop&w=600&q=80", order: 17 },
  { name: "İllegal Lojistik", description: "Kayıt dışı sevkiyatlar, kaçakçılık rotaları ve gizli teslimat operasyonları yürüten şebeke.", price: 20000, category: "illegal", imageUrl: "https://images.unsplash.com/photo-1506784983877-45594efa4cbe?auto=format&fit=crop&w=600&q=80", order: 18 },
  { name: "Tacirlik", description: "Esrar, koko ve meth şeklindedir. Her farmın bir taciri var, her farmdaki tacir sayısı 2'dir.", price: 5000, category: "illegal", imageUrl: "https://images.unsplash.com/photo-1508962914676-134849a727f0?auto=format&fit=crop&w=600&q=80", order: 19 },
  { name: "İllegal Gunshop", description: "Ruhsatsız ağır silah, otomatik tüfek ve patlayıcı satışı yapan yeraltı silah deposu.", price: 15000, category: "illegal", imageUrl: "https://images.unsplash.com/photo-1553828981-d1be862ef67d?auto=format&fit=crop&w=600&q=80", order: 20 },
  { name: "Kalpazan", description: "Sahte para basımı, aklama operasyonları ve evrakta sahtecilik atölyesi.", price: 8000, category: "illegal", imageUrl: "https://images.unsplash.com/photo-1509023464722-18d996393ca8?auto=format&fit=crop&w=600&q=80", order: 21 },
  { name: "Blackmarket", description: "Gelişmiş illegal ekipmanlar, hack araçları ve özel kimyasalların satıldığı gizli pazar.", price: 8000, category: "illegal", imageUrl: "https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?auto=format&fit=crop&w=600&q=80", order: 22 },
  { name: "Torbacı", description: "Şehir sokaklarında madde satışı yapabilme yetkisi sağlayan sokak torbacılığı rolü.", price: 3000, category: "illegal", imageUrl: "https://images.unsplash.com/photo-1515003197210-e0cd71810b5f?auto=format&fit=crop&w=600&q=80", order: 23 }
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
  await seedCollection(DonateItem, DEFAULT_DONATE_ITEMS);
  await seedCollection(SiteModule, DEFAULT_MODULES);
}

module.exports = { seedDefaults, removeInvalidDiscordUsers };
