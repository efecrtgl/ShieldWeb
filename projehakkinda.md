# Shield Software — Detaylı Geliştirme Dokümantasyonu ve Yapay Zeka Promptu

**Proje Adı:** Shield Software  
**Geliştiriciler:** realflexd & kai7m

---

## 1. Sistem Mimarisi ve Topoloji

Proje, dikey ölçeklenebilir mega servis mimarisi (Mega-Service & Micro-Service Architecture) ile tasarlanacaktır. Tüm sistem, tek bir merkezi konfigürasyon dosyasından beslenen, bir ana servis (App Gateway / Orchestrator) üzerinden yönlendirilen ve her alt modülü izole bir Node.js süreci (Process) olarak ayağa kalkan bir yapıya sahip olacaktır.

### A. Katmanlı Servis Yapısı
* **Ana Sunucu (Servis):** Projenin temel web sitesidir. Kullanıcının siteye giriş yapabilmesi için **Discord OAuth2** entegrasyonunu barındırır. Global `Navbar`, `Footer` ve ortak tüm layout bileşenleri bu katmandadır. Altındaki mega ve mikro servislerin yönetimini üstlenir.
* **Mega Servisler:** Mantıksal çatı gruplarıdır. Altındaki mikro servislerin isim uzayını (Namespace / Route) belirler.
* **Mikro Servisler:** Sitenin her bir modülü, ayrı bir klasör içerisinde, kendi portunda bağımsız bir sunucu (mikro servis) olarak çalıştırılacaktır. Mega servislere bağlıdırlar.

### B. Servis Hiyerarşisi ve Örnek Şema
* **Ana Sunucu (Servis)**
  * **DiscordSistem (Mega Servis)**
    * Kullanıcı İşlemleri (Mikro Servis)
    * Banlanan Kullanıcılar (Mikro Servis)
  * **FivemEnt (Mega Servis)**
    * İşletmeler (Mikro Servis)

### C. Sıralı Bot Fonksiyon Mimarisi
Sistem, işlem sırasına ve işlevlerine göre ayrılmış **5 adet bağımsız Discord botu** ile entegre çalışacaktır:
1. **Bot 1 (Doğrulama/Giriş Botu):** Kullanıcının siteye Discord OAuth2 ile giriş yapmasını, sunucu kontrolünü ve ilk kimlik doğrulamasını (Verification) yönetir.
2. **Bot 2 (Log/Kayıt Botu):** Sitede ve bağlı servislerde yapılan tüm kritik işlemleri, yetkilendirmeleri ve değişiklikleri Discord kanallarına loglar (Logger).
3. **Bot 3 (Moderasyon Botu):** Siteden verilen uzaklaştırma, ban veya ceza işlemlerini eş zamanlı olarak Discord sunucusunda uygular (Moderation).
4. **Bot 4 (Senkronizasyon Botu):** Web sitesindeki yetkiler ile Discord rollerini ve Fivem oyun içi yetkilerini anlık olarak senkronize eder (Sync).
5. **Bot 5 (Yönetim/Aksiyon Botu):** Kurucu komutlarını, işletme yönetim süreçlerini ve tetiklenen son aşama aksiyonları kontrol eder (Management).

### D. Merkezi Yönetim (Global Config) & Yetkilendirme
* Tüm sistemlerin portları, veri tabanı bağlantıları, OAuth2 bilgileri ve 5 botun tokenları tek bir merkezi `config.js` dosyasından yönetilecektir.
* Sistemde tanımlı **2 adet Discord ID'si** bulunacaktır. Bu iki kullanıcı, rollerine veya diğer izinlerine bakılmaksızın sistem üzerinde **tam erişime (Full Access)** sahip olacaktır.

---

## 2. Tasarım Dili Standartları

Arayüzün tamamı **Glassmorphism** ve **Liquid Glass** tasarım hatlarına sadık kalınarak geliştirilecektir. CSS mimarisinde şu standartlar uygulanacaktır:
* **Arka Planlar:** `rgba(255, 255, 255, 0.05)` veya `rgba(0, 0, 0, 0.4)` yoğunluğunda soft transparan katmanlar.
* **Bulanıklık Efekti:** `backdrop-filter: blur(16px) saturate(180%);`
* **Kenarlıklar:** İnce ve derinlik algısı yaratan `1px solid rgba(255, 255, 255, 0.1)` hatları.
* **Sıvı Efektleri (Liquid Gradients):** Arka planda yavaşça hareket eden, organik ve keskin hatları olmayan animasyonlu sıvı gradyan balonları (`blob`).

---

## 3. Kesin Yapay Zeka Kuralları (AI Guardrails)

Sistem kodlarını üretirken aşağıdaki kurallara %100 uyulacaktır:
1. **Yorum Satırı Kesinlikle Yasaktır:** Üreteceğin hiçbir kod dosyasında, fonksiyonda, şemada veya konfigürasyonda tek bir satır dahi yorum satırı (`//`, `/* */`, `#`) **OLMAYACAKTIR**. Kodları tamamen yalın, açıklamasız ve temiz teslim edeceksin.
2. **Yalnızca İsteneni Yap:** Ben sana spesifik bir görev, rota, şema veya arayüz parçası söylemeden asla ekstra kod, "ileride gerekir" düşüncesiyle ek fonksiyon veya bonus özellik yazmayacaksın. Sadece odaklanmanı istediğim adıma sadık kalacaksın.
3. **Strict Instruction (Katı Talimat):** Verilen mimari şemanın, merkezi konfigürasyon yapısının, OAuth2 sisteminin, 5'li bot hiyerarşisinin ve teknoloji yığınının (MongoDB, Node.js, Discord.js v14) dışına çıkmayacaksın.

---

## 4. Kopyalanabilir Yapay Zeka Promptu (Doğrudan AI'a Verilecek Metin)

```text
Aşağıda detayları ve kuralları belirtilen "Shield Software" isimli projenin geliştirilmesinde mimar, frontend ve backend geliştirici olarak görev alacaksın. Sana bir modül veya görev vermeden kod yazmaya başlama, önce mimariyi anladığını onayla.

PROJE KÜNYESİ
- Proje Adı: Shield Software
- Geliştiriciler: realflexd & kai7m
- Veri Tabanı: MongoDB Community Server
- Backend: Node.js (Express.js veya saf HTTP)
- Discord Entegrasyonu: Discord.js v14

MİMARİ YAPI VE HİYERARŞİ
Proje; ana servis, mega servis ve mikro servis hiyerarşisiyle klasör bazlı izole çalışan bir mimariye sahiptir. Her mikro servis kendi klasöründe, kendi portunda bağımsız bir Node.js süreci olarak çalışır.

1. Ana Sunucu (Servis): Ana domaini yönetir, ortak Navbar/Layout yapısını barındırır, Discord OAuth2 giriş sistemini sağlar ve mega/mikro servisleri koordine eder.
2. Mega Servisler: Mantıksal çatı gruplarıdır.
3. Mikro Servisler: Mega servislere bağlı, izole çalışan alt modüllerdir.

MİMARİ ŞEMA:
- Ana Sunucu (Servis)
  ├── DiscordSistem (Mega Servis)
  │     ├── Kullanıcı İşlemleri (Mikro Servis)
  │     └── Banlanan Kullanıcılar (Mikro Servis)
  └── FivemEnt (Mega Servis)
        └── İşletmeler (Mikro Servis)

İŞLEM SIRASINA GÖRE BOT YAPISI:
Sistemde tanımlı 5 adet bağımsız bot bulunacaktır:
- Bot 1 (Verification): Discord OAuth2 giriş ve ilk kimlik doğrulama işlemleri.
- Bot 2 (Logger): Sitedeki tüm kritik işlemlerin Discord kanallarına loglanması