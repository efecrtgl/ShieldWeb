# Shield Software — FiveM Bridge Management

Bu FiveM scripti, Shield Software web paneli ile FiveM oyun sunucunuz arasında çift yönlü veri akışını ve komut köprüsünü yönetir.

## Kurulum Adımları

1. **Klasör İsimlendirme:**
   Script klasörünün ismi `shield-software` (veya `arc-web`) olarak kullanılabilir.
   
2. **Sunucuya Yükleme:**
   Klasörü FiveM sunucunuzun `resources/` dizini altına yükleyin (Örnek: `resources/[realflexd]/shield-software`).

3. **Sunucu Başlatma İzinleri (server.cfg):**
   Bu script oyun sunucusunda doğrudan kod fonksiyonlarıyla ve gerektiğinde komut yetkileriyle çalışır.
   
   Sunucunuzun server.cfg dosyasına aşağıdaki satırı ekleyin:
   
   ```cfg
   add_ace resource.shield-software command allow
   ```

## Desteklenen Komut Listesi

Script, config.json içinde tanımlı şu komut şablonlarını çözümleyip çalıştırır:
- setjob (Meslek atama)
- setgang (Çete atama)
- giveitem (Eşya verme)
- pedmenu (Karakter ped menüsünü açma)
- kill (Oyuncuyu öldürme)
- revive (Oyuncuyu canlandırma)
- pedver (Karakter ped modelini değiştirme)
- pedal (Ped modelini sıfırlama)
- start_screen_watch (Oyuncunun ekranını anlık canlı izleme)
- stop_screen_watch (Canlı ekran izlemeyi sonlandırma)

## Canlı Ekran İzleme Entegrasyonu (0 FPS Drop Koruması)
Canlı ekran izleme özelliği FiveM'in resmi ve optimize render altyapısını kullanır.
Sunucunuzun `server.cfg` dosyasına `screenshot-basic` eklentisini eklediğinizden emin olun:
```cfg
ensure screenshot-basic
ensure shield-software
```
Ekran izleme istemcide yalnızca yönetici panelden "Ekran İzle" butonuna bastığında tetiklenir, pencere kapandığında yayın anında durur. Bu sayede oyuncuda sıfır FPS kaybı yaşanır. Panel üzerinden 60 FPS (Maksimum Akıcılık), 30 FPS (Ultra Akıcı), 15 FPS (Akıcı), 5 FPS (Dengeli) ve 1.2 FPS (Ultra Hafif) hız seçenekleri anlık olarak değiştirilebilir.
