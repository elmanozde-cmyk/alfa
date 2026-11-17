# Alfa

Seans ve kasa trading oyunu.

Bu repo kaynak kodudur. Telefona APK olarak inmez. Oyun Grok onizlemesinde oynanir.

## Nasil oynanir
- Masaya otur veya Ogretici seans
- Zilden once kulis ve acilis emri
- Grafikte dikey surukle: stop / hedef
- Bitir ile gunu erken kapat, acik lot gece kalir

## Ses
Ses oyunun icinde uretilir (zil, haber, islem). Grok sohbetinden MP3/WAV yuklenemez.

---

# İzim — Yürüyüş Haritası (`yuruyus/`)

Yürüdüğün yolları haritaya çizer ve kaydeder. Sonra **Haritam** sekmesini açınca gezdiğin tüm yerler üst üste görünür.

- **Yürüyüş:** Başla → yürü → Bitir ve kaydet. Mesafe, süre ve tempo (dk/km) canlı gösterilir. Duraklat/devam desteklenir.
- **Haritam:** Kaydedilen bütün yürüyüşler farklı renklerde. Birine dokununca o yürüyüşe yakınlaşır.
- **Yedekle / Geri yükle:** Kayıtları JSON dosyası olarak indir veya başka cihaza aktar.
- Veriler sadece telefonda (tarayıcı hafızasında) tutulur, sunucuya gitmez.
- Sayfa yanlışlıkla kapanırsa yarım kalan yürüyüş kaybolmaz, açınca devam eder.

**Çalıştırmak:** Klasörü HTTPS olan bir yere koy (ör. GitHub Pages). Konum için HTTPS şart. Telefonda açıp "Ana ekrana ekle" de.
Yerelde denemek: `cd yuruyus && python3 -m http.server` → `http://localhost:8000`.

**Sınır:** Web uygulaması olduğu için ekran kilitlenince veya uygulama arka plana atılınca telefon GPS'i durdurabilir. Uygulama kayıt sırasında ekranı açık tutmaya çalışır. Cep telefonu kilitliyken de kayıt için ileride native (Capacitor/Android) sürüm gerekir.
