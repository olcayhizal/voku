# voku

Bir input fotoğraftan yola çıkıp, ChatGPT ve Google Gemini **web üyelikleri**
üzerinden (API anahtarı değil, oturum açılmış hesap) prompt listesindeki her
prompt için görsel üreten **job tabanlı** üretim hattı.

- **İş kaynağı iki tane:** panelden yüklenen fotoğraf ya da Telegram botuna
  gelen fotoğraf. Bota gelen her fotoğraf bir iştir; yanındaki telefon/isim
  künyeye yazılır, üretim bitince kareler tek albüm halinde sohbete döner.
- **Panel** (`http://127.0.0.1:4173`) kuyruğu, kontak baskısını, prompt
  listesini, oturumları ve baskı odasını tek ekranda toplar.
- **Çıktı üç varyant:** `uretim/` ham, `demo/` damgalı, `baski/` şablonlu ve
  aynalı (transfer baskı için).

## Kurulum

**Windows:** [install.cmd](https://raw.githubusercontent.com/olcayhizal/voku/main/install.cmd)
dosyasını indir ve çift tıkla — Git ve Node.js yoksa kurar, projeyi çeker,
bağımlılıkları yükler, masaüstüne kısayol koyar. Başka bir şey gerekmez.

**macOS:**

```bash
git clone https://github.com/olcayhizal/voku.git ~/voku && cd ~/voku
npm install
npm i -g @openai/codex     # ChatGPT motoru
```

Sonra `VOKU.command` dosyasını çift tıkla.

## Günlük kullanım

Kontrol paneli (`VOKU.command` / `VOKU.cmd`) her şeyi yönetir: panel ve
Telegram botunu başlat-durdur, dış erişimi (tünel) aç-kapat, misafir
bağlantısını üret, güncelle.

Komut satırını tercih edersen:

```bash
node src/cli.js panel        # panel + Telegram botu
node src/cli.js prompts      # prompt listesini doğrula
node src/cli.js status       # kuyruk
node src/cli.js guncelle     # GitHub'daki sürümü çek
```

## Yapılandırma

Gerçek yapılandırma dosyaları git'e girmez; örneklerinden kopyalanır:

| dosya | ne için |
|---|---|
| `config/settings.json` | platformlar, sürücüler, zaman aşımları |
| `config/prompts.json` | prompt listesi (`prompts.example.json`'dan) |
| `config/telegram.json` | bot token'ı (`telegram.example.json`'dan) |
| `config/erisim.json` | panel misafir anahtarı (ilk açılışta üretilir) |

## Gereksinimler

- Node.js 20+
- ChatGPT motoru için [Codex CLI](https://github.com/openai/codex) ve bir
  ChatGPT aboneliği (oturum bir kez panelden açılır)
- Gemini motoru için Go ile derlenen yerel köprü (`tools/`) ve bir Google
  hesabı
- Dış erişim için (isteğe bağlı) [ngrok](https://ngrok.com)

## Notlar

Bu araç kişisel bir üretim hattıdır; hesap oturumlarınla çalışır, API
anahtarı kullanmaz. Gemini köprüsü ve watermark temizleyicisi üçüncü taraf
projelerdir ve ilgili servislerin kullanım koşulları açısından gri alandadır
— ticari kullanımdan önce bunu değerlendir.

<!-- surum: 0.1.1 -->
