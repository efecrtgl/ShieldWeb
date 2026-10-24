# Shield Software — FiveM köprüsü (resource)

Bu resource, oyun sunucusu ile Shield web paneli arasındaki köprüdür. Sunucu, panele her saniye imzalı bir HTTP
isteği gönderir; panelde bekleyen komutları alır, uygular ve sonucunu bir sonraki istekte bildirir.

Sürüm 2.1.0 · köprü protokolü v2

## Gereksinimler

- `qb-core`, `oxmysql` (zorunlu)
- `ox_inventory` (varsa envanter işlemleri onun üzerinden yapılır)
- `screenshot-basic` (canlı ekran izleme için)
- `illenium-appearance` veya `qb-clothing` (ped menüsü), `qb-ambulancejob` (revive / kill)

## Kurulum

1. Klasörü `resources/` altına kopyalayın. Klasör adı `shield-software` olmalıdır.
2. `config.example.json` dosyasını `config.json` olarak kopyalayın ve doldurun:
   - `apiUrl`: `https://<panel-adresi>/api/fivem/bridge/poll`
   - `secretKey`: paneldeki `.env` içinde bulunan `FIVEM_BRIDGE_SECRET` ile **aynı** değer
   - `pollInterval`: milisaniye (varsayılan 1000)
   - `dbLock`: `true` ise hiçbir SQL okuma/yazma yapılmaz (yalnızca çevrimiçi oyuncu bilgisi gönderilir)
   - `locations`: paneldeki "Işınla" hazır konumları (`spawn`, `hospital`, …)
3. `server.cfg`:
   ```cfg
   ensure oxmysql
   ensure qb-core
   ensure screenshot-basic
   ensure shield-software
   add_ace resource.shield-software command allow
   ```
4. Oyun sunucusunun IP adresini paneldeki `FIVEM_BRIDGE_ALLOWED_IP` listesine ekleyin (aynı makinede ise gerekmez).

`config.json` eksikse, `apiUrl` geçersizse veya `secretKey` örnek değerde kalmışsa köprü başlamaz ve konsola nedenini
yazar.

## Panelle veri alışverişi

| İstek | Sıklık | İçerik |
|-------|--------|--------|
| `POST /api/fivem/bridge/poll` | `pollInterval` | çevrimiçi oyuncular, `sv_maxclients`, önceki komutların sonuçları → bekleyen komutlar |
| `POST /api/fivem/bridge/characters` | 60 sn ve değişiklikte | `players` tablosundaki karakterler (50'lik parçalar) |
| `POST /api/fivem/bridge/shared-data` | 10 dk ve açılışta | QBCore / ox_inventory eşya, meslek, çete ve araç kayıtları |

Her istek `X-Bridge-Timestamp` ve `X-Bridge-Signature` (zaman damgası + gövdenin HMAC-SHA256'sı) taşır. Panel 30
saniyeden eski veya daha önce kullanılmış imzaları reddeder; istekler 10 saniyede zaman aşımına uğrar.

**Veri uydurulmaz:** sunucunun okuyamadığı bir değer (ör. karakteri yüklenmemiş oyuncunun mesleği, bilinmeyen para,
kayıtlı olmayan cilt modeli) `null` olarak gönderilir ve panelde "—" olarak gösterilir.

## Desteklenen komutlar

| Eylem | Açıklama | Başarısız olduğu durumlar |
|-------|----------|---------------------------|
| `setjob`, `setgang` | meslek / çete ve kademe atar (çevrimdışı oyuncuda SQL ile) | meslek/çete veya kademe tanımlı değil |
| `giveitem`, `removeitem`, `clearinventory` | envanter işlemleri | eşya kayıtlı değil, envanter kabul etmedi, eşya yok |
| `givemoney` | `cash`, `bank` veya `crypto` ekler | geçersiz tip, üst sınır (100.000.000) aşıldı |
| `update_character` | yalnızca panelde değiştirilen alanları (ad, soyad, doğum tarihi, para, meslek) uygular | karakter bulunamadı |
| `delete_character` | oyuncuyu atar, `players` ve ilişkili tabloları siler | — |
| `sync_characters` | bir karakteri (citizenid ile) veya hepsini panele yeniden gönderir | karakter okunamadı |
| `teleport` | `locations` içindeki konuma veya X/Y/Z'ye ışınlar | oyuncu oyunda değil, konum tanımlı değil |
| `vreturn` | plakası verilen aracı oyuncunun yanına çeker | oyuncu oyunda değil |
| `revive`, `kill`, `pedmenu`, `pedver`, `pedal`, `send_dm` | istemci olayları | oyuncu oyunda değil |
| `kick`, `ban` | sunucudan atar / `bans` tablosuna yazar ve atar | oyuncu sunucuda değil, ban kaydı yazılamadı |
| `execute_command` | yalnızca `start`, `ensure`, `stop`, `restart <resource>` ve `say` / `announce <metin>` | diğer tüm komutlar reddedilir |
| `start_screen_watch`, `stop_screen_watch` | canlı ekran izleme | `screenshot-basic` çalışmıyor |

Her komutun sonucu (başarılı / başarısız ve nedeni) panele bildirilir; panel "uygulandı", "başarısız" veya eski bir
köprüyle çalışıyorsa "iletildi, doğrulanamadı" olarak gösterir. Oyun sunucusu 30 saniye içinde almayan komutlar
iptal edilir; sunucu kapalıyken panel komut göndermez.

## Canlı ekran izleme

İzleme yalnızca yetkili panelde "Ekran" düğmesine bastığında başlar ve pencere kapanınca durur. Kareler oyuncunun
istemcisinden doğrudan panele (`/api/fivem/screen/upload`, oturuma özel tek kullanımlık anahtar ile) yüklenir.

## Güncelleme

Önce paneli, sonra bu resource'u güncelleyin (`restart shield-software`). Yeni resource eski panelin eylem adlarını da
anlar; eski resource yeni panelle çalışır ancak komut sonuçlarını bildiremez.
