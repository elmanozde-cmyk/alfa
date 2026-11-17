# İzim — Yürüyüş Haritası

Yürüdüğün yolları haritaya çizer ve kaydeder. Sonra **Haritam** sekmesini açınca gezdiğin tüm yerler üst üste görünür.

- **Yürüyüş:** Başla → yürü → Bitir ve kaydet. Mesafe, süre, tempo (dk/km), yeni keşfedilen nokta ve tur sayısı canlı gösterilir. Duraklat/devam desteklenir.
- **Keşif:** Harita sisle kaplı; yürüdüğün yerler açılır. Renk koyulaştıkça oradan daha çok geçmişsin demektir. Bir yere dokununca kaç kez geçtiğini, kaç farklı günde geldiğini, ilk/son ziyareti gösterir. Keşfedilen alan (km²) ve en çok gittiğin yerler listelenir.
- **Harita modları (Ayarlar → Harita):** *Normal* — harita tamamen açık, yollar çizgi. *Keşif* — kara ve göller sisle kapalı, deniz açık; yürüdükçe harita açılır.
- **Nabız ve form (Günlük):** son 30 günün ortalama nabzı, hızı ve *kalp verimliliği* (bir atışta kaç metre) önceki 30 günle karşılaştırılır; 8 haftalık grafik. Yürüyüş ve koşu ayrı değerlendirilir.
- **Tur sayma:** Aynı noktaya farklı bir yoldan dönmek bir tur sayılır (parkın etrafında 3 kez dönmek = 3 tur). Aynı yoldan geri dönmek tur sayılmaz.
- **Günlük:** Bu hafta / bu ay / toplam km, seri (art arda yürünen gün), son 14 günün grafiği ve gün gün özet: nerede yürüdün (mahalle adı), kaç km, kaç yeni nokta keşfettin. Bir güne dokununca o günün rotaları haritada görünür.
- **Yedekle / Geri yükle:** Kayıtları JSON dosyası olarak indir veya başka cihaza aktar.
- Mahalle adları OpenStreetMap (Nominatim) üzerinden alınır.
- Veriler önce telefona kaydedilir. Günlük sekmesinden e-posta ile giriş yapılırsa Supabase'e yedeklenir ve cihazlar arasında eşitlenir (internet yokken de çalışır).
- Sayfa yanlışlıkla kapanırsa yarım kalan yürüyüş kaybolmaz, açınca devam eder.

**Çalıştırmak:** Klasörü HTTPS olan bir yere koy (ör. GitHub Pages). Konum için HTTPS şart. Telefonda açıp "Ana ekrana ekle" de.
Yerelde denemek: `python3 -m http.server` → `http://localhost:8000`.

**Sınır:** Web uygulaması olduğu için ekran kilitlenince veya uygulama arka plana atılınca telefon GPS'i durdurabilir. Uygulama kayıt sırasında ekranı açık tutmaya çalışır. Cep telefonu kilitliyken de kayıt için ileride native (Capacitor/Android) sürüm gerekir.

## Nabız (Bluetooth)
- Yürüyüş ekranında **♥ Nabız bağla**: standart Bluetooth nabız sinyali yayan cihazlara bağlanır (Polar H10/H9/Verity Sense, "nabız paylaş" modundaki saatler).
- Android + Chrome gerekir; iPhone tarayıcıları Web Bluetooth desteklemez.

## Polar
- Ayarlar → Polar → **Polar hesabını bağla**. Saatle kaydedilen rotalı antrenmanlar yürüyüş olarak eklenir.
- Kurulum: `supabase/polar.sql` (SQL Editor), Supabase secret `POLAR_CLIENT_SECRET`, Polar'da yönlendirme adresi `https://ihvzwkpnhihmbzdvljvf.supabase.co/functions/v1/polar-callback`.
- Fonksiyonlar (`supabase/functions/`) GitHub Actions ile yayınlanır; repoya `SUPABASE_ACCESS_TOKEN` secret'ı eklenmelidir.

## Bulut (Supabase)
- Tablo ve erişim kuralları: `supabase/schema.sql` (Supabase → SQL Editor'de bir kez çalıştırılır).
- Uygulamada sadece **publishable** anahtar bulunur. `sb_secret_...` anahtarı asla koda konmaz.
