# CLAUDE.md — voku

## Proje nedir
Bir **input fotoğraftan** yola çıkıp, ChatGPT ve Google Gemini
**web üyelikleri** üzerinden (API değil, oturum açılmış tarayıcı ile)
prompt listesindeki her prompt için görsel üreten **job tabanlı** üretim
hattı.

Çıktı klasörü: `output/DD-MM-YYYY-<telefonno>/`
Telefon yoksa: `output/DD-MM-YYYY-000XXXXXXXX/` (000 ile başlayan uydurma id).

## Temel kavramlar
- **Job** = 1 input fotoğraf + 1 prompt seti + 1 çıktı klasörü.
- **Task** = job içindeki tek bir prompt (tek platform, tek üretim).
- **Adapter** = sürücü. Hepsi aynı arayüzü uygular: `hazirla()`, `uret()`.
  İki cinsi var:
  - **tarayıcılı** (`chatgpt`, `gemini`) — Playwright, oturum profilden.
  - **tarayıcısız** (`chatgpt-codex`) — `tarayiciGerekli = false` bayrağını
    taşır, runner tarayıcı açmaz. Codex CLI'ı alt süreç olarak çalıştırır.
- Bir platform hangi sürücüyle koşacağını `settings.platforms.<ad>.adapter`
  ile seçer. Böylece **prompt listesi değişmeden** motor tarayıcıdan
  Codex'e çevrilebilir (`platform: "chatgpt"` aynı kalır).
- **Runner** = kuyruk işleyici. Task'ları platforma göre gruplar; platformlar
  arası paralel, platform içinde **worker havuzu** (`concurrency`, varsayılan
  3): tarayıcılı sürücüde her worker bir sekme, tarayıcısızda bir alt süreç.
  Hata → retry (backoff); hata metninde kota/limit geçiyorsa backoff 6×.

## Motorlar (2026-07-23 itibarıyla ikisi de tarayıcısız)

| platform | adapter | motor | görsel başına | paralel |
|---|---|---|---|---|
| chatgpt | `chatgpt-codex` | Codex CLI + `image_gen` (gpt-image-2) | ~85 sn | 4 |
| gemini | `gemini-http` | yerel `gemini-web-to-api` köprüsü (gemini-3-pro-image) | ~20 sn | 4 |

Ölçülen tam koşu: **7 prompt (4 ChatGPT + 3 Gemini) → 180 sn.** Aynı iş
ayar öncesinde (2+3 paralel, varsayılan reasoning) 364 sn sürüyordu.

Tarayıcı sürücüleri (`chatgpt`, `gemini`) duruyor — köprü/Codex bozulursa
`adapter` alanını geri çevirmek yeterli.

**ChatGPT / Codex.** OpenAI'ın resmi "Sign in with ChatGPT" akışı; üretim
abonelik kotasından koşar. Kurulum `npm i -g @openai/codex`, giriş panelden
(süreçli giriş) veya `codex login`. Görsel üreten turlar Codex kullanım
limitini metin turlarına göre **3-5 kat hızlı** tüketir — `concurrency`
artırılırken bu akılda tutulur.

Codex bir **ajan**, düz görsel API'si değil: her istekte düşünme turları,
tool seçimi, dosya yazma ve doğrulama var. Süre buradan geliyor.

*İki tuzak (ikisi de ölçülerek bulundu):*
- **Prompt STDIN'den verilir** (`-` argümanı + stdin). Pozisyonel argüman
  olarak verilirse ve komutta `-c` varsa, `-i` çoklu değer aldığı için
  prompt yutulur; Codex boş girdiyle bekler ("Reading additional input from
  stdin…") ve **9 dakika sonra dosyasız, çıkış kodu 0 ile döner**. Sessiz
  başarısızlık — argüman sırasıyla oynarken dikkat.
- **`--output-schema`** OpenAI strict şeması ister: her object'te
  `additionalProperties: false` VE `required` tüm alanları kapsamalı.
  Opsiyonel alan 400 döndürür. Şema reddedilirse adapter şemasız tekrar dener.

*Reasoning effort ölçümü (tek görsel, aynı prompt):*
| effort | süre |
|---|---|
| varsayılan (medium) | 219 sn |
| `none` | 119 sn |
| **`low`** | **85 sn** ← kullanılan |

`none` beklenenin aksine daha yavaş: düşünme kapalıyken ajan fazladan
deneme turu atıyor. Ayar `platforms.chatgpt.codexConfig.model_reasoning_effort`.

**Gemini / HTTP köprüsü.** `tools/gemini-web-to-api` (Go, upstream
ntthanh2603). Çerezle (`__Secure-1PSID`/`__Secure-1PSIDTS`) Gemini web
oturumunu konuşur, OpenAI-uyumlu uç verir. Giriş **tarayıcıda** yapılır
(profil), panel giriş biterken çerezleri köprünün `.env`'ine senkronlar.
Servisi adapter kendi başlatır (`tools/gemini-api-server` binary'si).
- **Yerel yama şart:** upstream chat yolunda görseli indirmez, Google'ın
  lh3 URL'ini döndürür — o URL oturum bağımlı, dışarıdan 403. Yama chat'te
  de kimlik doğrulamalı indirmeyi açıp base64'ü içeriğe gömer.
  `tools/gemini-web-to-api.voku.patch` ile saklandı; repo güncellenirse
  yeniden uygulanır, yoksa adapter net hata verir.
- **Hukuki not:** köprü resmi değil, Google ToS gri alanı, upstream
  "ticari kullanım yasak" diyor. Ticari iş için Gemini'yi tarayıcı
  sürücüsüne geri almak daha savunulabilir.

**Gemini watermark temizliği.** Gemini üretilen görselin sağ alt köşesine
görünür bir logo basıyor. `tools/gwr`
([GargantuaX/gemini-watermark-remover](https://github.com/GargantuaX/gemini-watermark-remover),
paket adı `@pilio/gemini-watermark-remover`) ters alfa karışım formülüyle
siliyor — üretken model değil, matematiksel geri alma; doku bozulmuyor
(~2 sn/görsel).
- `gemini-http` adapter'ı her görselden sonra otomatik çalıştırır;
  kapatmak için `platforms.gemini.watermarkKaldir: false`.
- Başarısız olursa **görsel korunur**, sadece uyarı loglanır — watermark'lı
  çıktı, çıktısızlıktan iyidir.
- Geriye dönük temizlik: `node src/cli.js temizle [jobId] [--all]`.
- **Kaldırılan yalnızca görünür logodur.** Google'ın görünmez SynthID
  işareti dosyada kalır; içerik AI üretimi olarak tespit edilebilir olmayı
  sürdürür. Watermark kaldırma Google ToS açısından gri alandır.
- npm'de aynı isimli, kaynağı belirsiz paketler var — kurulum **repodan
  klonlanarak** yapılır, `npm i gemini-watermark-remover` ile değil.

**Paralel yazma tuzağı:** aynı job'ın task'ları aynı çıktı klasörüne yazar.
Bir adapter "klasörde beliren yeni dosya benimdir" derse paralel koşan
başka platformun çıktısını sahiplenir — dosya eşleştirmesi **`baseName`
öneki** ile yapılır.

## İş kaynakları: panel / telegram
Her job bir **kaynak** taşır (`job.kaynak`, manifest'te de var):

| kaynak | nasıl | künye |
|---|---|---|
| `panel` | panelden fotoğraf yüklenir | telefon + not elle yazılır |
| `telegram` | bota fotoğraf gelir | telefon/isim mesaj metninden çıkarılır |

Eski job'larda alan yok — okunurken `panel` sayılır (`kaynakNormalize`).
Panelde kuyruk kartlarında rozet, üstte **Tümü / Panel / Telegram** süzgeci
(iki kaynak birden varsa görünür), iş detayında kaynak + Telegram kullanıcısı
+ teslim durumu.

## Telegram botu
**Bota gelen her fotoğraf bir job'dır.** Fotoğrafın yanında gelen telefon /
isim / not job künyesine yazılır; üretim bitince **demo kareler tek seferde**,
albüm halinde aynı sohbete döner.

- Ayarlar `config/telegram.json` (git'e girmez, token orada; örnek dosya
  `telegram.example.json`). `VOKU_TELEGRAM_TOKEN` dosyadaki token'ı ezer.
- `izinliChatler` boşsa herkes iş açabilir; dolu liste = yalnız o chat id'ler.
  Kullanıcı kendi kimliğini `/id` ile öğrenir. **Bot adı bilinen bir kurulumda
  bu liste doldurulmalı** — yoksa yabancı biri iş açıp ChatGPT/Gemini kotasını
  yakabilir.
- Komutlar: `/start` `/yardim` `/durum` `/iptal` `/id`.

**Toplama penceresi.** Fotoğraf gelir gelmez job açılmaz; `toplamaMs` (20 sn)
beklenir — insan fotoğrafı atıp numarayı arkasından yazıyor, ikisini ayrı iş
saymak künyeyi bozardı. Metin gelince pencere `metinSonrasiMs`e (3 sn) iner.
Metin fotoğraftan **önce** gelirse `bilgiOmruMs` (5 dk) saklanır, ilk
fotoğrafa iliştirilir. Albümdeki her fotoğraf ayrı job olur, künye ortaktır.

**Telefon ayrıştırma** (`kunyeCikar`): metindeki TR cep kalıbı telefon olur,
kalan her şey nottur. Numara 10/11 haneye oturmuyorsa telefon sayılmaz, nota
düşer.

**Hangi hal gönderilir.** Varsayılan **üretim** (damgasız) — müşteriye giden
asıl iş odur. Mesajda "demo" geçerse damgalı hal gider. Karar iş açılırken
verilip `kaynakBilgi.teslimVaryanti`'ne yazılır (sonradan mesajın değişmesi
teslimi kaydırmasın); istenen varyantın dosyası yoksa ötekine düşülür ve
uyarı loglanır. Ayar: `varsayilanVaryant` / `demoAnahtari`.

**Teslim** job olayına bağlıdır, çalıştırana değil: iş panelden başlatılıp
bitse de kareler sohbete düşer. `kaynakBilgi.teslimAt` damgası aynı işi iki
kez göndermeyi engeller; bot açılışta biten ama teslim edilmemiş işleri tarar
(panel kapalıyken biten iş kaybolmaz). Fotoğraflar gönderim öncesi jpeg'e
indirgenir (Telegram 10MB/foto sınırı); `belgeOlarak: true` sıkıştırmasız
belge gönderir. Telegram'dan gelen işler **sıra sıra** koşar; iki job'ı aynı
anda başlatmak ChatGPT/Gemini kotasını çifter yakardı.

**Dinleme kilidi (`jobs/.telegram.lock`).** Telegram bir token için "kim
dinliyor" kilidi tutmaz — **son bağlanan kazanır**, öteki 409 alır. Panel ve
CLI körlemesine tekrar deneseydi hattı sırayla birbirinden kaparlardı. Kilit
dosyası (pid + kalp atışı) sırayı belirler: sahibi canlıysa öteki örnek 10
sn'de bir bakar, sahibi ölünce hat devralınır. `panel --no-telegram` ile
panelde bot hiç açılmaz; `node src/cli.js telegram` botu tek başına dinletir.

## Kimlik doğrulama
API anahtarı yok. Her platform için **kalıcı Chrome profili**
`.profiles/<platform>/` altında tutulur. Bir kez `voku login <platform>`
ile (veya panelden) elle giriş yapılır, oturum çerezleri profilde kalır.
Profil klasörleri **git'e girmez** (kişisel oturum verisi).

**Headless YASAK.** ChatGPT ve Gemini headless Chrome'u bot kontrolüne
sokuyor ("Bir dakika lütfen…" / Cloudflare); oturum açık olsa bile arayüz
gelmiyor. `headless: false` kalmalı — oturum sınaması ve üretim dahil her
şey görünür pencerede koşar. `run --headless` bayrağı uyarı basar.
Bir platform "arayüz tanınmadı" derse önce bot kontrolü mü diye bakılır
(`botKontroluMu`), oturum sorunu ile karıştırılmaz.

**Tarayıcı:** varsayılan `channel: "chrome"` — sistemdeki gerçek Google
Chrome kullanılır. Playwright'ın indirdiği Chromium'a göre hem `npx
playwright install` gerektirmez hem de ChatGPT/Gemini tarafında daha az bot
şüphesi çeker. Kanal açılamazsa indirilmiş Chromium'a otomatik düşer.
Değiştirmek için `config/settings.json > channel` (platform bazında
`platforms.<ad>.channel` ile de ezilebilir; `null` = Chromium).

## Panel
`node src/cli.js panel --open` → `http://127.0.0.1:4173`. Üç sekme:
**İşler** (kuyruk + kontak baskısı), **Promptlar** (liste editörü),
**Oturumlar** (giriş yönetimi). Altta canlı akış şeridi (SSE).

- Görsel dil: karanlık oda. Zemin banyo koyusu, accent safelight amber;
  sinyal renkleri **durum taşır**, dekor değildir — amber çalışıyor,
  yeşil-mavi tamam, kırmızı düştü.
- **Kontak baskısı** panelin imza öğesi: her task bir kare. Bekleyen kare
  pozlanmamış kağıt (tarama deseni), çalışan karede safelight bandı aşağı
  iner, biten kare üretilen görseli gösterir, düşen kare kırmızı çarpı alır.
- İş detayında telefon varsa **Sohbeti aç** düğmesi: `wa.me/90XXXXXXXXXX`.
  Numara TR biçimine oturmuyorsa (ör. sahte 000… iş kodu) düğme hiç çıkmaz —
  bozuk linke tıklatmaktansa göstermemek yeğdir (`waLinki`, src/job.js).
- Kuyruk üstünde **tarih süzgeci**: Tümü / Bugün / Dün / Aralık (uçlar dahil,
  yerel gün bazında). Arama kutusuyla birlikte çalışır; ikisi de iki+ job
  varken görünür.
- Kuyruk kartları girdi fotoğrafının küçük halini gösterir (kart yüksekliğini
  aşmaz, `object-fit: cover`). Üstteki arama kutusu kod, telefon, not ve
  prompt metinlerinde anlık filtreler; iki+ job varken görünür.
- **Header düzeni:** solda günlük akış (İşler, Baskı odası), sağda kurulum
  (Promptlar, Oturumlar), en sağda bağlantı lambaları — ChatGPT, Gemini,
  Telegram (hover'da durum metni).
- **Işık kutusu:** kontak baskısındaki bir kareye tıklamak büyütür; aynı
  işin o sekmedeki kareleri arasında ok tuşları / kenar okları / alttaki
  film şeridi ile gezinilir, Esc kapatır. Gezinme kümesi açıldığı sekmenin
  dosyalarıdır (üretim / demo / baskı / print seçimi).
  *CSS tuzağı:* gövde grid'i `minmax(0, 1fr)` olmalı — uzun prompt satırı
  (nowrap) sütunu max-content'e şişirip sahneyi pencereden taşırıyordu.
  Sahne sabit kutu + `object-fit: contain`; görsele yalnız `max-height`
  vermek kutuyu doğal genişlikte bırakıyor.
- **Panel kendini tazeler:** SSE canlı akışı taşır (bottan gelen iş kuyruğa
  kendiliğinden düşer), akış her yeniden bağlandığında ve sekme
  görünürken 45 sn'de bir `/api/state` sessizce senkronlanır. Sayfa
  yenilemenin aksine açık sekme, seçili iş, varyant ve süzgeçler korunur;
  prompt taslağına dokunulmaz.
- Panel CLI'ın üstüne kurulur, onun yerine geçmez: aynı `jobs/*.json`
  state'i, aynı runner. İkisi karışık kullanılabilir.
- Sunucu yalnız `127.0.0.1`'e bağlanır. Bir tünelin arkasına konursa erişim
  denetimi devreye girer (aşağıya bak).

## Kurulum, güncelleme ve platformlar
- **Depo:** github.com/olcayhizal/voku (public). Kişisel her şey depo dışıdır:
  `config/prompts.json`, `telegram.json`, `erisim.json`, `jobs/`, `sayfalar/`,
  `output/`, `.profiles/`, `tools/`. Örnek yapılandırmalar `*.example.json`.
- **Windows kurulumu:** `install.cmd` — winget ile Git + Node.js, repo klonu,
  `npm install`, örnek config kopyaları, Codex CLI, motor kurulumu, masaüstü
  kısayolu.
- **Motorlar depoda taşınmaz:** `tools/` üçüncü taraf koddur ve derlenmiş
  binary içerir (.gitignore). Her makinede `scripts/motorlari-kur.cmd` /
  `.command` ile kurulur: Go, köprü klonu, `patches/` altındaki yerel yama,
  `go build`, watermark temizleyici klonu. Yama depoda tutulur çünkü köprü
  onsuz görseli indirmiyor (lh3 URL'leri oturum bağımlı, dışarıdan 403).
- **Güncelleme** (`src/guncelleme.js`, `cli guncelle`): `git pull --ff-only`.
  Yerel commit ya da kirli çalışma ağacı varsa **güncelleme yapılmaz** —
  kullanıcının kurulumunu sessizce ezmek en kötü senaryodur. `package-lock`
  değiştiyse bağımlılıklar yenilenir. Kontrol sonucu 6 saat önbelleklenir
  (`.guncelleme-durumu.json`), betikler `var|adet|mesaj` satırını okur.
  Otomatik güncelleme `config/guncelleme.json > otomatik` ile açılır; açıksa
  panel her başlatılışta önce güncellenir.
- **Platform farkları `src/platform.js`'te toplanır** — `open`/`explorer`,
  `python3`/`python`/`py`, binary `.exe` uzantısı. Adapter'lara platform
  koşulu yazılmaz.
- Windows'ta ChatGPT motoru için Codex CLI native kurulum (OpenAI'ın
  "deneysel" etiketi duruyor) ya da WSL2 gerekir; Gemini köprüsü Go ile
  yeniden derlenmeli. Panel, Telegram botu, misafir erişimi platformdan
  bağımsızdır.
- **`spawn` + Windows: iki ayrı tuzak, ikisi de `platform.js`'te çözülür.**
  1. npm'in global kurduğu programlar `codex.cmd` gibi batch shim'leridir;
     Node `spawn` PATHEXT uygulamadığı için `spawn('codex')` **ENOENT** verir
     → `komutYolu()` tam yolu `where`/`which` ile çözer.
  2. Tam yolu vermek de yetmez: Node 18.20 / 20.12'deki güvenlik yaması
     (CVE-2024-27980) `.cmd`/`.bat` dosyalarını kabuksuz çalıştırmayı
     engeller, bu kez **EINVAL** gelir → `komutCagrisi()` bunları
     `cmd.exe /c <yol>` biçimine çevirir. `shell: true` kullanılmaz;
     uzun prompt metinlerinin tırnaklamasını bozar.
  Dış komut çağıran her yeni kod `komutCagrisi()` üzerinden geçmeli
  (`codex`, `npm`; `git` ve `.exe`'ler etkilenmez).
- **Alt süreçlerde `error` olayı zorunlu:** yakalanmazsa Node işlenmemiş
  olay sayıp **tüm paneli düşürür**. Eksik bir CLI yüzünden kuyruk ve
  Telegram botu ölmemeli — hata oturum kartına yazılır, panel ayakta kalır.

## VOKU.command / VOKU.cmd — çift tıklanan kontrol paneli
Terminal bilmeyen biri için tek giriş noktası: Finder'dan çift tıkla, menü
gelsin. Masaüstündeki kısayoldan da açılır (script symlink zincirini çözüp
proje klasörüne geçer — `dirname "$0"` kısayolda masaüstünü gösterir).

macOS'ta `VOKU.command` (bash), Windows'ta `VOKU.cmd` (batch) — aynı menü:
paneli tarayıcıda aç · dışarıya aç (tünel + misafir bağlantısını panoya
kopyala) · dış erişimi kapat · bağlantıyı yenile · her şeyi kapat ·
güncelle · otomatik güncelleme · açılışta kendiliğinden başlat.

- Üstte canlı durum: panel / Telegram / dış erişim lambaları + kuyruk özeti
  (`/api/state`'ten `node` ile okunur — jq bağımlılığı yok).
- Panel **`caffeinate -dimsu` altında** başlar: kapak kapanınca üretim ve
  Telegram botu yarıda kalmasın.
- Çift tıkla açılan kabukta Homebrew/nvm PATH'te olmayabilir — script
  `/opt/homebrew/bin`, `/usr/local/bin` ve nvm yolunu kendisi ekler.
- **Açılışta otomatik hazırlık:** dosya çift tıklandığında panel ve dış
  erişim kapalıysa sessizce açılır (menüde 9 ile kapatılabilir,
  `config/tunel.json > acilistaAc`). Beklenen davranış "her şey çalışır
  durumda gelsin"; menü sonra çizilir.
- **Tünel hazır mı ölçütü adrestir, süreç değil:** ölmekte olan bir ngrok
  örneği `pgrep`/`tasklist`'te görünüp "zaten açık" sanılmasına yol açıyordu
  (panel açılıyor, dış erişim sessizce kapalı kalıyordu). Süreç varsa ama
  4040 API adres vermiyorsa süreç temizlenip yeniden başlatılır.
- **Dış adres sabit kalır:** ilk açılışta alınan ngrok adresi
  `config/tunel.json`'a yazılır, sonraki açılışlarda `ngrok --url=<adres>`
  ile aynısı istenir; hesapta yoksa serbest adrese düşüp yenisini kaydeder.
  Misafir anahtarı zaten sabittir → paylaşılan bağlantı kalıcıdır. Menüde
  tam bağlantı (adres + anahtar) hep görünür.
- Otomatik başlatma: macOS'ta `~/Library/LaunchAgents/io.voku.panel.plist`
  (`RunAtLoad` + `KeepAlive`), Windows'ta Görev Zamanlayıcı ("VOKU Panel",
  onlogon) — komutu göreve gömmek yerine `scripts/baslat.cmd` çağrılır,
  iç içe tırnaklar bozuluyordu.
- Eksik bağımlılıkta teknik çıktı basmaz: Node yoksa nodejs.org'a, ngrok
  yoksa (brew varsa) kurulumu teklif etmeye, authtoken yoksa
  `ngrok config add-authtoken` adımına yönlendirir.

## Panel erişimi: sahip / misafir
Panel bir tünelden (ngrok, Cloudflare, `ssh -R`) dışarı açıldığında iş silen,
prompt değiştiren, hatta bu makinede Finder/Chrome açtıran uçlar da açılmış
olur. Bu yüzden koruma **panelin kendisindedir** (`src/erisim.js`), tünel
sağlayıcısında değil — tünel değişse de kural aynı kalır (ngrok'un ücretsiz
planında zaten basic auth yok).

| rol | kim | ne yapar |
|---|---|---|
| `sahip` | yerel istekler + `sahipToken` | her şey |
| `misafir` | `misafirToken`lı bağlantı | yalnız okur; yazan uçlar 403 |
| yok | anahtarsız uzak istek | 401 + kapı sayfası |

- **Yerel tespiti loopback'e bakmaz:** tünel ajanı da `127.0.0.1`'den bağlanır.
  Ayırt edici işaret `x-forwarded-for` / `x-real-ip` / `forwarded` başlıkları —
  biri varsa istek dışarıdandır, anahtar zorunludur.
- Kural izin listesi değil **metot kuralıdır**: misafirde GET dışı her istek
  403. Yeni uç eklendiğinde ayrıca korumaya gerek kalmasın diye.
- Arayüzde misafire kurulum sekmeleri (Promptlar, Oturumlar), bağlantı
  lambaları, "Yeni iş" ve tüm kare/iş eylemleri çizilmez.
- Anahtarlar `config/erisim.json` (git dışı), ilk açılışta üretilir.
  `node src/cli.js baglanti [--adres <url>] [--yenile]` bağlantıyı yazar,
  `--yenile` sızan bağlantıyı geçersiz kılar.
- `scripts/yayinla.sh` ngrok tünelini açıp misafir bağlantısını basar
  (`NGROK_DOMAIN` ile sabit adres). ngrok ücretsiz planı: 1 GB/ay veri,
  20k istek/ay — bu yüzden misafirde sessiz tazeleme 45 sn yerine 3 dk.

## Görsel önizlemeler
Kontak baskısı ve film şeridi ham PNG yüklemez: `?b=k` (480 px) / `?b=o`
(1400 px) jpeg önizlemeleri `.onizleme/` altında bir kez üretilip saklanır
(kaynak dosya değişirse tarih damgasından anlaşılıp yenilenir). Ölçüm:
3,3 MB PNG → 59 KB küçük, 503 KB orta. Işık kutusu ortayı, kuyruk kartı ve
şerit küçüğü kullanır; `kok` sanal varyantı job klasörünün kendisidir
(girdi fotoğrafı). Önizleme üretilemezse ham dosya servis edilir.
- Yeni platform panele kendiliğinden gelir (`config/settings.json > platforms`).
  Ekranda güzel adı için `PLATFORM_ETIKET` (public/app.js) haritasına bir satır.

## Dosya haritası
```
config/settings.json   çalışma ayarları (timeout, retry, headless, selector override)
config/prompts.json    prompt listesi + her prompt'un platformu
config/telegram.json   bot token + toplama/teslim ayarları (git dışı)
src/telegram.js        Telegram köprüsü: mesaj → job, iş bitince demo teslimi
src/cli.js             komut satırı girişi
src/server.js          panel sunucusu (Node http, bağımlılıksız) + JSON API + SSE
public/                panel arayüzü (vanilla html/css/js, build adımı yok)
src/config.js          ayar + prompt yükleme, doğrulama
src/job.js             job oluşturma, id/klasör adı mantığı
src/store.js           jobs/*.json atomic okuma-yazma
src/runner.js          kuyruk, retry, platform paralelliği
src/browser.js         playwright persistent context yönetimi
src/adapters/*.js      chatgpt / gemini sürücüleri
src/varyant.js         uretim/demo/baski klasörleri, DEMO damgası
src/logger.js          konsol + logs/voku.log
jobs/<id>.json         job state (tek kaynak)
output/<klasör>/       uretim| demo| baski alt klasörleri + input + manifest.json
```

## Kurallar
- **Job state tek kaynaktır** (`jobs/<id>.json`). Runner her task
  sonunda diske yazar; süreç ölse bile `voku run` kaldığı yerden devam eder.
- Tamamlanmış task **tekrar çalıştırılmaz** (idempotent). Yeniden üretim
  isteniyorsa `voku retry <jobId> --task <taskId>` ile status sıfırlanır.
- Üretilen dosya adı: `<sira>-<platform>-<promptId>[-N].png`.
- **Selector'ler kırılgandır.** ChatGPT/Gemini arayüzü değişince adapter
  içindeki sabit selector yerine `config/settings.json > selectors` altından
  override edilir; adapter kodu her seferinde elle düzeltilmez.
- Prompt listesi ve platform eşlemesi **Olcay tarafından verilir**;
  uydurulmaz. `config/prompts.json` tek kaynaktır.
- Hiçbir adım sessizce atlanmaz: atlanan/başarısız task manifest'te ve
  `voku status` çıktısında görünür.

## Kullanım
```bash
# Panel (önerilen giriş): oturum + prompt + iş yönetimi tek ekranda
# Telegram botu da bu süreçte dinler (kapatmak için --no-telegram).
node src/cli.js panel --open

# Botu panelsiz dinlet (panel açıksa gerekmez — kilit sırayı belirler)
node src/cli.js telegram

# 1) Bir kez: oturum aç (tarayıcı açılır, elle giriş yapılır, ENTER)
node src/cli.js login chatgpt
node src/cli.js login gemini

# 2) Prompt listesini doğrula
node src/cli.js prompts

# 3) Job aç (telefon varsa --phone; yoksa 000... id otomatik)
node src/cli.js new --image ~/Desktop/foto.jpg --phone 05551112233
node src/cli.js new --image ~/Desktop/foto.jpg --run     # aç + hemen çalıştır

# 4) Çalıştır / izle / tekrar dene
node src/cli.js run                 # bekleyen ilk job
node src/cli.js run --all           # bekleyen tüm job'lar
node src/cli.js status [jobId]
node src/cli.js retry <jobId>       # failed task'ları sıfırlar
```

## Durum makinesi
`pending → running → done | failed`
- Hata → `attempts++`, `maxAttempts`'a kadar backoff ile tekrar; tükenirse `failed`.
- Job durumu task'lardan türetilir: `pending / running / done / failed / partial`.
- Süreç ölürse `run` aynı job'da kaldığı yerden devam eder (done'lar atlanır).

## Durdurma
Panelde çalışan job'ın "Durdur" düğmesi (`POST /api/jobs/:id/stop`) bir
`AbortController` tetikler. Sinyal runner'ın worker döngüsüne, retry
beklemesine ve adapter'lara kadar iner:
- Codex: çalışan `codex` alt süreci SIGTERM (3 sn sonra SIGKILL),
- HTTP köprüsü: `fetch` isteği abort,
- tarayıcı: görsel bekleme döngüsü sinyalde kırılır, context kapanır.

**Durdurma bir arıza değildir:** kesilen task `failed` değil `pending`
kalır, `error` temizlenir, biten task'lar korunur. Job doğrudan yeniden
başlatılabilir. Kod bunu ayırt etmeli — durdurma sırasında oluşan hata
task'a yazılmaz.

## Girdi fotoğrafı hazırlığı
Job açılırken fotoğraf job klasörüne alınırken iki adımdan geçer
(`girdiyiHazirla`, `src/varyant.js`):
1. **EXIF yönü uygulanır** — telefon fotoğrafları çoğu zaman dönük saklanır;
   ham piksel boyutuna bakmadan önce bu düzeltilmeli.
2. **Yatay ise saat yönünde 90° döndürülür** (`genişlik > yükseklik`).
   Üretim her zaman dikey çerçeveden başlar.

Sonuç `job.inputDonduruldu` / `job.inputBoyut` alanlarına yazılır, panelde
künyede görünür. Görsel işlenemezse (bozuk/desteklenmeyen format) ham kopya
ile devam edilir — job açılamamaktansa döndürmesiz devam etmek yeğdir.

## Varyantlar (uretim / demo / baski)
Her job klasöründe üç alt klasör var; **dosya adları üçünde de aynıdır**,
varyant ayrı bir boyuttur (`task.files` yalnız dosya adını tutar).

| klasör | içerik |
|---|---|
| `uretim/` | adapter'ların yazdığı ham çıktı |
| `demo/` | çapraz tekrarlı "DEMO" damgalı hal (%20 beyaz, ince koyu kontur) |
| `baski/` | şablon tuvaline oturtulmuş, logolu, aynalanmış baskı çıktısı (**899×1181 px**) |

**Baskı tuvali 899×1181 px** (`BASKI_TUVALI`, src/varyant.js). Epson en-boy
oranını koruduğu için baskı genişliği doğrudan bu orandan doğar: yükseklik
100,79 mm'ye ayarlanınca genişlik 76,72 → ekranda **76,7 × 100,8**.
898 px ile 76,64 çıkıp ekranda 76,6 görünüyordu. Şablon PNG 898 px;
fark otomatik telafi ediliyor (logo görünür biçimde kaymaz).

**Baskı üretimi** (`baskiUret`, kaynak **uretim/** — demo damgası karışmaz):
1. Şablon seçilir: `job.inputDonduruldu` ? `assets/baski/yatay.png` :
   `assets/baski/dikey.png`. İkisi de 898×1181 dikey tuval; fark logo yönünde
   (dikeyde "VOKU" altta yatay, yatayda sol kenarda dik — ürün çevrilince okunur).
2. Görsel tuvale **cover** ile yerleşir: en-boy oranı korunur (eğilme/büzülme
   yok), taşan kısım kırpılır (boşluk kalmaz). Kırpma **merkezden** (`centre`): seri baskılarda kadrajın işten işe aynı
   kalması, içerik odaklı `attention` kırpmasına tercih edildi (2026-07-24 kararı).
3. Şablon üste bindirilir.
4. Transfer baskı için ayna alınır, eksen ürünün yönüne göre:
   dikey iş → **flop** (sol ↔ sağ), döndürülmüş iş → **flip** (üst ↔ alt).

**sharp tuzağı:** işlemler çağrı sırasına göre değil, sabit boru hattı
sırasına göre uygulanır ve **composite, flip/flop'tan sonra gelir**. Aynı
zincirde yazılırsa ayna yalnız zemine işler, logo düz kalır. Bu yüzden
birleştirme önce buffer'a alınır, ayna ayrı aşamada uygulanır.

- Demo hali **üretimin hemen ardından** runner tarafından basılır (sharp +
  SVG pattern, `src/varyant.js`). Başarısız olursa üretim korunur, uyarı düşer.
- Damga boyutu görsele göre ölçeklenir (kısa kenarın ~1/9'u), açı -32°.
- Panelde iş detayında **Üretim / Demo / Baskı** segmenti; her sekmede o
  klasördeki dosya sayısı rozette görünür, boşsa açıklayıcı boş durum çıkar.
- Dosya servisi: `/api/jobs/:id/file/<varyant>/<ad>`; varyantsız yol
  (`/file/<ad>`) job kökünü gösterir (input fotoğrafı, manifest).
- Geriye dönük: `node src/cli.js varyant [jobId] [--all] [--yeniden]`
  eski düz yapıyı `uretim/` altına taşır ve eksik demoları üretir.
- **Watermark temizliği demoyu geçersiz kılar:** `temizle` komutu üretimi
  düzelttikten sonra o task'ın demosunu yeniden basar; yoksa demo klasöründe
  watermark'lı eski hal kalırdı.


### Print sekmesi (baskı seçimi)
Panelde dördüncü sekme **Print** bir klasör değil, seçim görünümüdür —
dosyalar `baski/` klasöründen gelir.
- **Baskı** sekmesinde her karede `seç` düğmesi: basılacaklar işaretlenir.
  Seçilen karede düğme yerine **adet kontrolü** (`− N +`) çıkar — aynı
  görselden birden fazla kopya istenebilir (1-99). `−` ile 1'in altına inmek
  seçimi kaldırır; ayrı bir "listeden çıkar" düğmesi gerekmesin diye.
- **Print** sekmesi yalnız seçilenleri listeler; her karede `basıldı`
  toggle'u var. Basılan kare yeşil kenar + rozet alır, görseli soluklaşır.
- Sekme rozeti seçili **görsel** sayısını; yanındaki satır hem görsel hem
  **kopya** oranını gösterir ("1/2 görsel basıldı · 3/5 kopya").
- Veri: `job.baskiSecim` — dosya adına göre `{ secili, adet, basildi, seciliAt, basildiAt }`.
  Dosya adı üç varyantta da aynı olduğundan tek anahtar yeter.
- **Seçimden çıkarılan dosyanın `basildi` işareti de temizlenir** (listede
  olmayan bir şeyin "basıldı" olması anlamsız).
- API: `POST /api/jobs/:id/secim` gövde `{ dosya, secili?, basildi? }`;
  `adet` mutlak değer gönderilir (0 = seçimi kaldır, üst sınır 99);
  dosya o işe ait değilse 400. Durum `manifest.json`'a da yazılır.

## Baskı odası (header sekmesi)
Panelin dördüncü ana sekmesi. Sayfalar artık **kalıcı kayıt**
(`sayfalar/sayfalar.json`, `src/sayfa.js`) — dolduğu tarih, basım tarihi ve
ürettiği .etdx dosyası saklanır.

**Yaşam döngüsü:** seçim yapılır → bekleyen kopyalar sıraya girer → 6 kopya
birikince sayfa **dolar ve kilitlenir** (kalemleri + dolma tarihi sabitlenir)
→ basılınca basım tarihi damgalanır. Son sayfa yarım kaldığı sürece
akışkandır; yeni seçim geldikçe dolar. **Kilitli sayfa bir daha dizilmez** —
basılmış işin geçmişi sonradan değişmemeli.

- Sıra: iş oluşturma zamanı → task sırası; aynı müşterinin kopyaları ardışık
  kalır, çoğunlukla aynı sayfaya düşer.
- Bir seçimin tüm kopyaları ayrı slot kaplar: 15 kopya → 2 tam sayfa + 3'lük
  yarım sayfa.
- Sol sidebar: arama + Tümü/Bekliyor/Basıldı süzgeci; her satırda renkli
  ibare (yeşil basıldı, amber dolu-bekliyor, taralı henüz dolmadı).
- Çift yönlü gezinme: sayfadaki kareye tıkla → iş detayı (Baskı sekmesi);
  Print sekmesindeki karede "sayfaya git" → o kopyanın sayfası.
- Basım geri alınabilir (`geri-al`): sayaçlar da geri döner.

**.etdx üretimi.** Vault'taki [[etdx-gen]] aracı kullanılır
(`~/OLCAY/tools/etdx-gen/etdx_gen.py`): 6 görsel A4'e 100.80×76.76 mm,
2 sütun × 3 satır dizilir. Panelden tek düğme: dosya yoksa üretir, sonra indirir.

**Ölçü ve düzen (Olcay'ın Epson'da ölçtüğü hedef, 2026-07-24):**
tüm fotoğraflar **76,7 × 100,8 mm**; sol üst köşeler x: 3,5 / 106, y: 12 / 106 / 200.
Sabitler `FOTO_MM / ORIGIN_MM / GAP_MM` (src/sayfa.js).

**İki tuzak birden:**
1. Epson mm'i 0,1 kademede **yukarı** yuvarlıyor → hedef bir kademe altından
   verilir (100,79 → ekranda 100,8).
2. Epson fotoğraf ölçüsünü **originalsize × scale** ile gösteriyor, **kırpmayı
   hesaba katmıyor**. etdx-gen ise hedefi tutturmak için görseli kırpıp
   scale'i büyütüyor; sonuç ekranda şişik görünüyordu (101,7). Bu yüzden
   üretimden sonra her fotoğrafın **kırpması tam görsele çekilip scale hedeften
   yeniden hesaplanıyor** — böylece Epson'un gösterdiği = gerçek baskı ölçüsü.

## İş kartı göstergeleri ve süzgeç
Kuyruktaki her iş iki ikonlu sayaç taşır (hover'da tooltip):
- `▦ 5/7` — üretim: kaç görsel tamamlandı
- `⎙ 3/5` — baskı: kaç kopya basıldı / kaç kopya seçildi

Durum süzgeci bu ikisini tek eksende birleştirir:
**Üretimde** (üretim sürüyor) → **Seçim yok** (üretim bitti, seçim yapılmadı)
→ **Basılıyor** (seçim var, kopyalar bitmedi) → **Basıldı** (hepsi basıldı).

## Prompt listesi göçü
`prompts.json` platform alanına sürücü adı yazılmışsa (ör. eski listelerdeki
`chatgpt-codex`) doğrulama onu **o sürücüyü kullanan platforma eşler**;
liste bozulmaz. Doğrulama yine de patlarsa panel listeyi HAM haliyle
gösterir — bozuk kayıt ekranda düzeltilip kaydedilebilsin diye. (Boş liste
döndürmek kullanıcıyı çıkmaza sokar.)

## Yazma disiplini
- Dil: Türkçe (log mesajları, doküman, CLI çıktısı).
- Sade ESM JavaScript, harici bağımlılık minimum (sadece `playwright`).
- Yeni platform eklemek = `src/adapters/` altına bir dosya + `adapters/index.js`
  kaydı. Runner'a dokunulmaz.
