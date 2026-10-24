# 🚀 Shield Software — FiveM & Discord Web Paneli

**Shield Software**, FiveM roleplay sunucuları ve Discord toplulukları için web sitesi, yönetim paneli, Discord bot orkestratörü ve FiveM köprüsünden (bridge) oluşan bir Node.js uygulamasıdır.

---

## 🌟 Özellikler

- **Web sitesi:** Ana sayfa ve güncelleme notları, istatistikler, galeri, ekip sayfası, kurallar, SSS, mağaza (donate), yayıncılar, karakterler ve başvuru formları.
- **Discord OAuth2 girişi** ve rütbe tabanlı ayrıntılı yetki sistemi (rütbeler Discord rolleriyle eşitlenebilir).
- **Yönetim paneli:** Kullanıcı / whitelist / ceza / ekip / işletme / başvuru / mağaza / rütbe / bot / modül yönetimi, sistem logları, admin sohbeti (SSE), FiveM sunucu kontrolü ve script editörü.
- **5 Discord botu** (`bots/`), gateway tarafından ayrı süreçler olarak başlatılır, izlenir ve çöktüğünde yeniden başlatılır:
  1. Doğrulama (verification) 2. Loglama (logger) 3. Moderasyon (moderation) 4. Senkronizasyon (sync) 5. Yönetim (management)
- **FiveM köprüsü:** `shield-software/` kaynağı oyun sunucusunda çalışır; HMAC imzalı isteklerle oyuncu listesi, karakter verisi ve komut kuyruğunu panel ile eşitler.

---

## 🛠️ Kurulum

### Gereksinimler
- **Node.js 22.12+** (`@discordjs/voice` gereksinimi)
- **MongoDB 6+**
- (Opsiyonel) **PM2** — `npm` bağımlılığı olarak gelir.

### Adımlar
```bash
npm ci
cp .env.example .env      # Windows: copy .env.example .env
# .env dosyasını doldurun (en az SESSION_SECRET, MONGODB_URI, DISCORD_OAUTH_URL, DISCORD_CLIENT_SECRET, SUPERUSERS, bot tokenları)
npm start
```

Uygulama açılışta yapılandırmayı doğrular: eksik zorunlu ayarlar (ör. `SESSION_SECRET`) başlatmayı açıklayıcı bir hata ile durdurur, eksik opsiyonel ayarlar uyarı olarak yazdırılır. Tüm değişkenler ve açıklamaları için `.env.example` dosyasına bakın.

### Discord girişi (OAuth2)
- Tek giriş adresi `DISCORD_OAUTH_URL` değişkenidir (Developer Portal > OAuth2 > URL Generator, kapsamlar: `identify guilds`). `client_id`, geri dönüş adresi (`redirect_uri`) ve kapsamlar buradan okunur; uygulama her girişte yeni bir `state` ekler.
- `redirect_uri` panelin herkese açık adresi + `/auth/callback` olmalı ve Developer Portal > OAuth2 > Redirects listesinde **birebir** (şema, alan adı, port, yol) kayıtlı olmalıdır. Örn. `https://panel.example.com/auth/callback`.
- Panel başka bir adresten açılırsa giriş önce bu kanonik adrese yönlendirilir; böylece oturum çerezi geri dönüş adresiyle aynı alan adında kalır.
- Oturum çerezi HTTPS üzerinden gelen isteklerde otomatik olarak `Secure` olur (ters proxy `X-Forwarded-Proto` göndermelidir). Panel Discord Activity içinde gömülü kullanılacaksa `SESSION_COOKIE_SAMESITE=none` (yalnızca HTTPS) ayarlayın.

### Komutlar
| Komut | Açıklama |
|---|---|
| `npm start` | Gateway + bot orkestratörünü başlatır |
| `npm run dev` | Dosya değişikliklerinde otomatik yeniden başlatma ile çalıştırır |
| `npm test` | Birim testlerini çalıştırır (`node --test`) |
| `npm run lint` | ESLint kontrolü |
| `npm run bakim` | Bağımsız bakım modu sayfasını sunar (`maintenance/`) |
| `npm run seed:applications` | Varsayılan başvuru formlarını oluşturur/günceller |
| `npm run pm2:start` / `pm2:stop` / `pm2:logs` | PM2 ile prodüksiyon çalıştırma |

Windows için `module.bat` (bağımlılık kurulumu) ve `pm2-baslat.bat` / `pm2-durdur.bat` / `pm2-loglar.bat` betikleri de mevcuttur.

### FiveM köprüsü
1. `shield-software/` klasörünü FiveM sunucusunun `resources/` dizinine kopyalayın ve `server.cfg`'ye `ensure shield-software` ile `add_ace resource.shield-software command allow` ekleyin.
2. `shield-software/config.example.json` dosyasını `config.json` olarak kopyalayın; içindeki `apiUrl` değerini panelin adresine, `secretKey` değerini `.env` içindeki `FIVEM_BRIDGE_SECRET` ile **aynı** olacak şekilde ayarlayın.
3. Oyun sunucusu panelle aynı makinede değilse IP adresini `FIVEM_BRIDGE_ALLOWED_IP` listesine ekleyin.

---

## 📂 Proje Yapısı

```
.
├── index.js              # Giriş noktası: yapılandırma doğrulama, MongoDB, HTTP sunucu, bot başlatma
├── app.js                # Express uygulaması (middleware ve router sıralaması)
├── config.js             # Ortam değişkenlerinden okunan merkezi yapılandırma + doğrulama
├── routes/               # HTTP rotaları
│   ├── public.js         # Herkese açık sayfalar
│   ├── auth.js           # Discord OAuth2 giriş/çıkış
│   ├── applications.js   # Kullanıcı başvuru formları
│   ├── bridge.js         # FiveM köprüsü + canlı ekran izleme
│   ├── chat.js           # Admin sohbeti (SSE)
│   ├── apiMonitor.js     # API istek izleyici (yalnızca kurucular)
│   └── admin/            # Yönetim paneli rotaları (alan bazında dosyalar)
├── services/             # İş mantığı: yetkiler, Discord API, bot süreçleri/IPC, loglama, FiveM durumu, seed
├── middleware/           # Güvenlik (CSRF/origin, CSP), site bağlamı ve modül kontrolü, upload, hata yönetimi
├── models/               # Mongoose şemaları
├── bots/                 # 5 Discord botu + ortak botHelper
├── utils/                # Küçük yardımcılar (log dosyası, format, http, avatar, markdown, yayıncı API)
├── views/ , public/      # EJS şablonları ve statik dosyalar
├── templates/            # Varsayılan server.cfg şablonu
├── maintenance/          # Bağımsız bakım modu sunucusu
├── scripts/              # Bakım/seed betikleri
├── shield-software/      # FiveM sunucu kaynağı (köprü istemcisi)
├── test/                 # Birim testleri
└── docs/                 # Modül bazlı dokümantasyon
```

---

## 🔐 Güvenlik Notları

- Gizli bilgiler (bot tokenları, OAuth client secret, oturum anahtarı, köprü anahtarı, Gemini anahtarı) **yalnızca** `.env` içinde tutulur; `.env` git'e eklenmez.
- Yönetim paneline yapılan durum değiştiren istekler `Origin` kontrolünden geçer. Panel bir ters proxy veya farklı bir alan adı üzerinden kullanılıyorsa bu adresi `SITE_URL` ya da `CSRF_TRUSTED_ORIGINS` içinde tanımlayın.
- Mağaza yüklemeleri yalnızca resim dosyalarını kabul eder.
- Oyuncu, karakter ve Discord adları her yerde kaçışlanarak gösterilir; güncelleme notlarında ham HTML çalışmaz.
- Giriş, başvuru, mağaza ve oyun komutları hız sınırlıdır (`AUTH_RATE_LIMIT_PER_MINUTE`).
- Köprü istekleri ham gövde üzerinden HMAC ile doğrulanır; tekrar gönderilen (replay) istekler reddedilir.

---

## 📚 Dokümantasyon

- [`docs/SYSTEM_AUDIT.md`](docs/SYSTEM_AUDIT.md) — gerçek mimari, bulunan hatalar ve kök nedenleri
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — kurulum, ortam değişkenleri, portlar, ters proxy, sağlık kontrolleri, yedekleme
- [`docs/REFACTORING_PROGRESS.md`](docs/REFACTORING_PROGRESS.md) — yapılan çalışma, testler, açık konular
- [`shield-software/README.md`](shield-software/README.md) — FiveM köprüsü

---

## 📑 Sürüm Geçmişi

### Yayınlanmamış — Üretime hazırlık
- FiveM köprüsü protokol v2: komut sonuçları panele bildirilir; sunucu kapalıyken komut gönderilmez; bekleyen komutlar 30 sn sonra iptal edilir.
- Uydurma veri kaldırıldı: varsayılan meslek/eşya listeleri, "Civilian/Freelancer", sahte oyuncu/whitelist sayıları, sahte FXServer konsol çıktıları.
- Güvenlik: oyuncu adlarından kaynaklı XSS, karakter düzenleme yetki açığı, CSRF kapsamı, köprü replay koruması, markdown/HTML temizleme, hız sınırlama, bağımlılık açıkları (npm audit: 0).
- Yönetim paneli ve site için yeni tasarım sistemi (`public/css/console.css`, `public/css/site.css`), gerçek verili genel bakış.
- `/healthz` ve `/readyz` sağlık uç noktaları.

### Yayınlanmamış — Kod tabanı yeniden yapılandırması
- `index.js` monolitik dosyası `routes/`, `services/`, `middleware/` katmanlarına ayrıldı; yapılandırma tamamen ortam değişkenlerine taşındı.
- Güvenlik: koddan gömülü bot tokenları ve anahtarlar kaldırıldı; `/api` ve `/api/json` izleyicisi kurucularla sınırlandırıldı ve hassas başlıklar maskelendi; OAuth `state` kontrolü ve oturum yenileme eklendi; admin istekleri için Origin (CSRF) kontrolü; köprü imzası için sabit-zamanlı karşılaştırma; dosya yükleme kısıtlamaları; regex enjeksiyonuna karşı arama kaçışlama.
- Hata düzeltmeleri: mağaza satın alımında eşzamanlı bakiye harcama, ekip düzenlemede çökme, işletme sesli destek isteğinin her zaman zaman aşımına uğraması, kullanıcı zaman tüneli hatası, süresi dolan cezalarda Discord rollerinin geri verilmemesi, Linux'ta script editörü yol kontrolü.

### [v1.1.0] - 2026-08-10
- Toplu rol işlemleri için sıralı kuyruk ve gecikme (`processBatchWithDelay`).

### [v0.0.2] - 2026-07-03
- Yüzen admin sohbet penceresi (SSE), mesaj düzenleme/silme, toplu rütbe eşitleme performansı.

### [v0.0.1] - 2026-06-29
- Merkezi orkestrasyon ve bot süreç yönetimi, oturum deposu, Discord OAuth2 entegrasyonu.

---

Bu proje **Shield Software Development Team** (realflexd & kai7m) tarafından geliştirilmiştir. Tüm hakları saklıdır.
