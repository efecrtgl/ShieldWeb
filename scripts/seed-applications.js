const mongoose = require("mongoose");
const config = require("../config");
const Application = require("../models/Application");

const applicationsData = [
  {
    title: "Yetkili Başvurusu",
    shortDescription: "Shield Software yetkili kadrosuna katılmak ve sunucu yönetiminde görev almak için başvurun.",
    description: `<p>Shield Software bünyesinde yetkili kadromuza katılmak için aşağıdaki şartları taşımanız ve başvuru formunu eksiksiz doldurmanız gerekmektedir:</p>
<ul>
  <li>18 yaşından büyük olmanız gerekmektedir.</li>
  <li>Shield kurallarını bilip tüm mevzuata ve işleyişe hâkim olmak zorunludur.</li>
  <li>Günlük minimum 3-5 saatinizi sunucuya ve yetkili sorumluluklarına ayırabilmelisiniz.</li>
  <li>Oyun oynayacağı zamandan fedakarlık edip sunucu için yetkililik görevlerini üstlenebilmek.</li>
  <li>Saygı, üslup ve hiyerarşi kurallarına koşulsuz uyum sağlamak.</li>
  <li>Herhangi bir durumda dahi 3x uyarıya sahip olmamak.</li>
</ul>
<p><strong>Önemli Not:</strong> Yetkili başvurusu yapmadan önce sunucu kurallarını okumayı unutmayınız. Başvuru yapan her aday tüm kuralları okumuş ve kabul etmiş sayılır.</p>`,
    imageUrl: "/images/screen1.jpg",
    status: "open",
    order: 1,
    questions: [
      {
        id: "q_yetkili_discord_id",
        type: "short",
        label: "Discord ID'nizi giriniz",
        required: true,
        options: []
      },
      {
        id: "q_yetkili_steam_hex",
        type: "short",
        label: "Steam Hex ID'nizi giriniz",
        required: true,
        options: []
      },
      {
        id: "q_yetkili_name",
        type: "short",
        label: "Adınız ve Soyadınız",
        required: true,
        options: []
      },
      {
        id: "q_yetkili_age",
        type: "short",
        label: "Yaşınız",
        required: true,
        options: []
      },
      {
        id: "q_yetkili_about",
        type: "long",
        label: "Bize biraz kendinizden bahsediniz",
        required: true,
        options: []
      },
      {
        id: "q_yetkili_fivem_exp",
        type: "short",
        label: "Ne kadar süredir FiveM oynuyorsunuz?",
        required: true,
        options: []
      },
      {
        id: "q_yetkili_shield_exp",
        type: "short",
        label: "Ne kadar süredir Shield'da oynuyorsunuz?",
        required: true,
        options: []
      },
      {
        id: "q_yetkili_servers",
        type: "long",
        label: "Daha önce hangi sunucularda yetkililik yaptınız? Yaptıysanız hangi kademede bulundunuz?",
        required: true,
        options: []
      },
      {
        id: "q_yetkili_active_hours",
        type: "short",
        label: "Gün içerisinde aktif olduğunuz saat aralıkları nedir? (Örnek: 18.00 - 22.00 arası)",
        required: true,
        options: []
      },
      {
        id: "q_yetkili_contributions",
        type: "long",
        label: "Star V'ye katabileceğiniz katkılar nelerdir, yetkili olduktan sonraki planınız nedir?",
        required: true,
        options: []
      },
      {
        id: "q_yetkili_scripts_knowledge",
        type: "long",
        label: "Sunucudaki scriptler ve işleyiş hakkında bilgi sahibi misiniz? Oyuncuların herhangi bir soru sorduklarında cevap verebileceğinizi düşünüyor musunuz?",
        required: true,
        options: []
      },
      {
        id: "q_yetkili_terms",
        type: "checkbox",
        label: "Yetkili başvuru kurallarını ve sorumluluklarını okudum, kabul ediyorum.",
        required: true,
        options: ["Okudum ve şartları kabul ediyorum."]
      }
    ]
  },
  {
    title: "Streamer Başvurusu",
    shortDescription: "Shield Software sunucusunda yayıncı rolü ve özel yayıncı ayrıcalıkları için başvurun.",
    description: `<p>Shield sunucusunda yayıncı (streamer) permi almak için aşağıdaki formu eksiksiz doldurunuz. Başvuru öncesinde tüm kuralları okuduğunuzdan emin olunuz.</p>
<ul>
  <li>Yayınlarınızda Shield yazısı / logosu ve Discord sunucu davet linkinin yer alması gerekmektedir.</li>
  <li>Yayın geçmişlerinizin herkese açık ve en az son 3 gün boyunca silinmeden durması zorunludur.</li>
  <li>Kuralların dışına çıkmanız halinde streamer perminiz ve tarafınıza sağlanan tüm yardımlar geri alınır.</li>
</ul>`,
    imageUrl: "/images/screen2.jpg",
    status: "open",
    order: 2,
    questions: [
      {
        id: "q_streamer_discord_id",
        type: "short",
        label: "Discord ID'nizi giriniz",
        required: true,
        options: []
      },
      {
        id: "q_streamer_steam_hex",
        type: "short",
        label: "Steam Hex ID'nizi giriniz",
        required: true,
        options: []
      },
      {
        id: "q_streamer_platforms",
        type: "checkbox",
        label: "Yayın yaptığınız platformları seçiniz",
        required: true,
        options: ["Kick", "Twitch", "TikTok"]
      },
      {
        id: "q_streamer_channel_urls",
        type: "long",
        label: "Yayın adresinizi (linkinizi) giriniz. (Birden fazla ise alt alta yazınız)",
        required: true,
        options: []
      },
      {
        id: "q_streamer_vod_public",
        type: "radio",
        label: "Yayın geçmişiniz herkese açık mı ve son 3 gün boyunca silinmeden duruyor mu?",
        required: true,
        options: ["Evet", "Hayır"]
      },
      {
        id: "q_streamer_stream_count",
        type: "radio",
        label: "Yayın yaptığınız platformda en az 5 yayınınız bulunuyor mu?",
        required: true,
        options: ["Evet", "Hayır"]
      },
      {
        id: "q_streamer_sample_vods",
        type: "long",
        label: "Daha önce Star V ismini geçirerek açtığınız 3 yayının linkini paylaşınız",
        required: true,
        options: []
      },
      {
        id: "q_streamer_branding_confirm",
        type: "radio",
        label: "Yayınlarınızda Star V yazısı ve Discord sunucu davet linkinin bulunduğunu onaylıyor musunuz?",
        required: true,
        options: ["Evet.", "Hayır."]
      },
      {
        id: "q_streamer_terms",
        type: "checkbox",
        label: "Sunucu ve yayıncı kurallarını okudum ve kabul ediyorum. (Kuralların dışına çıkmanız halinde streamer perminiz ve sizlere verilen yardımlar geri alınır.)",
        required: true,
        options: ["Okudum, kabul ediyorum."]
      }
    ]
  },
  {
    title: "Boy Başvurusu",
    shortDescription: "Shield sunucusunda özel boy/çocuk karakter rolü deneyimi için başvuru formu.",
    description: `<p>Boy karakter rolü için başvuruda yer alan karakter hikâyesinin özenli, tutarlı ve gerçekçi olması zorunludur:</p>
<ul>
  <li>Özensiz, kısa geçilmiş veya baştan savma hazırlanan hikâyeler değerlendirmeye alınmadan direkt reddedilecektir.</li>
  <li>Gerçekçilikten uzak, mantık hataları bulunan veya karakterin geçmişiyle örtüşmeyen hikâyeler direkt reddedilecektir.</li>
  <li>Karakterin yaşına, geçmişine ve yaşadığı olaylara uygun olmayan abartılı hikâyeler kabul edilmeyecektir.</li>
  <li>Kopyala-yapıştır, hazır hikâye veya başka bir karakterden uyarlanmış içerikler direkt red sebebidir.</li>
  <li>Hikâyenin yalnızca uzun olması yeterli değildir; karakterin geçmişini, kişiliğini ve günümüzdeki davranışlarını mantıklı şekilde yansıtması gerekmektedir.</li>
</ul>
<p><strong>Önemli Hatırlatma:</strong> Başvurunuzu göndermeden önce karakter hikâyenizi dikkatli şekilde kontrol ediniz. Özen gösterilmemiş veya gerçekçilikten uzak başvurular için ek düzenleme talep edilmeyecek, başvuru direkt reddedilecektir.</p>`,
    imageUrl: "/images/screen3.jpg",
    status: "open",
    order: 3,
    questions: [
      {
        id: "q_boy_discord_id",
        type: "short",
        label: "Discord ID'nizi giriniz",
        required: true,
        options: []
      },
      {
        id: "q_boy_character_story",
        type: "long",
        label: "Karakter Hikayeniz (Geçmişi, kişiliği, davranışları ve günümüz durumu)",
        required: true,
        options: []
      }
    ]
  },
  {
    title: "2. Karakter Başvurusu",
    shortDescription: "Mevcut karakterinize ek olarak 2. karakter izni ve rol onayı başvuru formu.",
    description: `<p>İkinci bir karaktere sahip olmak için aşağıdaki kurallara dikkat etmeniz gerekmektedir:</p>
<ul>
  <li>Legal karakteri bulunan oyuncular, illegal 2. karakter açamaz.</li>
  <li>İllegal karakteri bulunan oyuncular, legal 2. karakter açamaz.</li>
  <li>2. karakteriniz, mevcut karakterinizin karşıt rolünde oluşturulamaz.</li>
  <li>Başvuruda karakterin geçmişi, kişiliği ve rol amacı detaylı ve gerçekçi şekilde belirtilmelidir.</li>
  <li>Özensiz, gerçek dışı, mantık hataları bulunan veya baştan savma hazırlanmış başvurular direkt reddedilecektir.</li>
  <li>1. karakter üzerinden mevcut karakterinizle çıkar sağlamak, bilgi aktarmak veya karakterler arası etkileşim kurmak kesinlikle yasaktır.</li>
</ul>
<p><strong>⚠️ Uyarı:</strong> 2. karakter başvurusu, yalnızca farklı bir rol deneyimi oluşturmak amacıyla yapılmalıdır. Kuralları aşmaya yönelik oluşturulan karakterler onaylanmayacaktır.</p>`,
    imageUrl: "/images/screen1.jpg",
    status: "open",
    order: 4,
    questions: [
      {
        id: "q_second_discord_id",
        type: "short",
        label: "Discord ID'niz",
        required: true,
        options: []
      },
      {
        id: "q_second_steam_hex",
        type: "short",
        label: "Steam Hex ID'niz",
        required: false,
        options: []
      },
      {
        id: "q_second_char_names",
        type: "short",
        label: "1. ve (onaylanırsa) 2. karakterinizin IC Adı ve Soyadı (Örnek: 1. Karakter: K... V..., 2. Karakter: A... Y...)",
        required: true,
        options: []
      },
      {
        id: "q_second_reason",
        type: "long",
        label: "Neden 2. karaktere sahip olmak istiyorsunuz?",
        required: true,
        options: []
      },
      {
        id: "q_second_char_story",
        type: "long",
        label: "2. Karakterinizin Hikayesi (Geçmişi, kişiliği ve rol hedefleri)",
        required: true,
        options: []
      }
    ]
  }
];

async function seed() {
  await mongoose.connect(config.mongodb.uri);
  console.log("Connected to MongoDB.");

  for (const appData of applicationsData) {
    const existing = await Application.findOne({ title: appData.title });
    if (existing) {
      console.log(`Updating existing application: ${appData.title}`);
      existing.shortDescription = appData.shortDescription;
      existing.description = appData.description;
      existing.imageUrl = appData.imageUrl;
      existing.status = appData.status;
      existing.order = appData.order;
      existing.questions = appData.questions;
      existing.isDeleted = false;
      await existing.save();
    } else {
      console.log(`Creating new application: ${appData.title}`);
      await Application.create(appData);
    }
  }

  const allApps = await Application.find({ isDeleted: false }).sort({ order: 1 });
  console.log(`\nAll active applications in database (${allApps.length}):`);
  allApps.forEach(a => {
    console.log(`- [${a.status.toUpperCase()}] ${a.title} (${a.questions.length} questions, order: ${a.order})`);
  });

  await mongoose.disconnect();
  console.log("Database disconnected successfully.");
}

seed().catch(err => {
  console.error("Seed error:", err);
  process.exit(1);
});
