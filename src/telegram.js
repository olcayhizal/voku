/**
 * Telegram köprüsü — botu bir iş kaynağı olarak bağlar.
 *
 * Kural: **bota gelen her fotoğraf bir job'dır.** Fotoğrafın yanında
 * (caption olarak ya da ayrı mesajda) gelen telefon/isim/not o job'ın
 * künyesine yazılır. İş bitince demo (damgalı) kareler **tek seferde**,
 * albüm halinde aynı sohbete geri düşer.
 *
 * Toplama penceresi: fotoğraf gelir gelmez job açılmaz — `toplamaMs` kadar
 * beklenir. Kullanıcı fotoğrafı atıp numarayı arkasından yazıyor; ikisini
 * ayrı job saymak künyeyi bozardı. Metin gelince pencere `metinSonrasiMs`e
 * kısalır (yazmayı bitirdiğinde beklemesin). Metin fotoğraftan ÖNCE gelirse
 * `bilgiOmruMs` boyunca saklanır, ilk fotoğrafa iliştirilir.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { CONFIG_DIR, JOBS_DIR } from './paths.js';
import { jobOlustur, telefonuNormalize } from './job.js';
import { jobOku, jobListele, jobYaz, durumuHesapla, olaylar } from './store.js';
import { promptlariYukle } from './config.js';
import { varyantDizini } from './varyant.js';
import { jobuCalistir } from './runner.js';
import { log } from './logger.js';

const API = 'https://api.telegram.org';

const DURUM_METNI = {
  done: 'tamam',
  failed: 'hata',
  partial: 'kısmi',
  running: 'çalışıyor',
  pending: 'bekliyor',
};

const VARSAYILAN = {
  enabled: true,
  token: null,
  /** Boş liste = herkes iş açabilir. Dolu liste = yalnız bu chat id'ler. */
  izinliChatler: [],
  /** Fotoğraf sonrası bilgi bekleme süresi. */
  toplamaMs: 20000,
  /** Metin geldikten sonra kalan bekleme (yazmayı bitirdi say). */
  metinSonrasiMs: 3000,
  /** Fotoğraftan önce gelen metnin raf ömrü. */
  bilgiOmruMs: 300000,
  /** Kareleri iş bitince otomatik gönder. */
  demoGonder: true,
  /**
   * Teslim edilecek varyantın varsayılanı. Mesajda "demo" geçerse damgalı
   * hal gönderilir; geçmezse buradaki varyant. Müşteriye giden asıl iş ham
   * üretim, damgalı hal ayrıca istenen bir şey.
   */
  varsayilanVaryant: 'uretim',
  /** Mesajda bu kelime geçerse demo (damgalı) hal gönderilir. */
  demoAnahtari: 'demo',
  /** true → sıkıştırmasız belge olarak gönder (albüm önizlemesi olmaz). */
  belgeOlarak: false,
  /** Fotoğraf gönderiminde uzun kenar sınırı (Telegram 10MB/foto sınırı). */
  gonderimUzunKenar: 2000,
};

export function telegramAyarYolu() {
  return path.join(CONFIG_DIR, 'telegram.json');
}

/* ------------------------------------------------------------------ */
/* dinleme kilidi                                                      */
/* ------------------------------------------------------------------ */
/**
 * Bir token'ı aynı anda tek süreç dinleyebilir. Telegram bunu kendi
 * dayatmaz — **son bağlanan kazanır**, öteki 409 alır. İki voku örneği
 * (panel + CLI) körlemesine tekrar denerse hattı sırayla birbirinden
 * kaparlar. Kilit dosyası bu sırayı belirler: sahibi canlı ve kalbi atıyorsa
 * öteki örnek bekler, sahibi ölünce hat devralınır.
 */
const KILIT_YOLU = path.join(JOBS_DIR, '.telegram.lock');
const KILIT_OMRU_MS = 120000; // getUpdates turu ~50 sn — iki tur payı

function kilitOku() {
  try {
    return JSON.parse(fs.readFileSync(KILIT_YOLU, 'utf8'));
  } catch {
    return null;
  }
}

function surecYasiyorMu(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function kilitBendeMi() {
  const k = kilitOku();
  if (!k || k.pid === process.pid) return true;
  if (!surecYasiyorMu(k.pid)) return true; // sahibi ölmüş
  return Date.now() - new Date(k.at).getTime() > KILIT_OMRU_MS; // kalbi durmuş
}

function kilidiTazele() {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.writeFileSync(KILIT_YOLU, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
}

function kilidiBirak() {
  if (kilitOku()?.pid === process.pid) fs.rmSync(KILIT_YOLU, { force: true });
}

/**
 * Ayarlar `config/telegram.json`'dan okunur (git'e girmez — token orada).
 * `VOKU_TELEGRAM_TOKEN` ortam değişkeni dosyadaki token'ı ezer.
 */
export function telegramAyarlariniYukle() {
  const p = telegramAyarYolu();
  let ham = {};
  if (fs.existsSync(p)) {
    try {
      ham = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      log.warn(`telegram.json okunamadı (${e.message}) — bot kapalı sayılıyor.`);
      return { ...VARSAYILAN, enabled: false, hata: e.message };
    }
  }
  const s = { ...VARSAYILAN, ...ham };
  if (process.env.VOKU_TELEGRAM_TOKEN) s.token = process.env.VOKU_TELEGRAM_TOKEN;
  // Örnek dosyadan kopyalanmış ama doldurulmamış token'ı gerçek sanma:
  // yeni kurulumda "Not Found" yerine ne yapılacağını söyleyen uyarı çıksın.
  if (s.token && /^(BOTFATHER_TOKEN|<.*>|degistir|token)$/i.test(String(s.token).trim())) {
    s.token = null;
    s.tokenDoldurulmadi = true;
  }
  s.izinliChatler = (s.izinliChatler || []).map(Number).filter(Number.isFinite);
  return s;
}

/* ------------------------------------------------------------------ */
/* metinden künye çıkarma                                              */
/* ------------------------------------------------------------------ */

// TR cep numarası: 0555 111 22 33 / +90 555 111 22 33 / 5551112233
const TEL_KALIBI = /(?:\+?9[\s.-]?0|0)?[\s.-]?\(?5\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}/;

/**
 * Serbest metinden telefon ve not ayrıştırır.
 * Telefon çıkarıldıktan sonra kalan her şey nottur (isim, kampanya, açıklama).
 */
export function kunyeCikar(metin) {
  const ham = String(metin || '').trim();
  if (!ham) return { telefon: null, not: null };
  const bulunan = ham.match(TEL_KALIBI);
  let telefon = null;
  let kalan = ham;
  if (bulunan) {
    telefon = telefonuNormalize(bulunan[0]);
    // Numara 10/11 haneye oturmuyorsa telefon sayma — nota kalsın.
    if (telefon && (telefon.length < 10 || telefon.length > 11)) telefon = null;
    if (telefon) kalan = ham.replace(bulunan[0], ' ');
  }
  const not = kalan
    .replace(/\s+/g, ' ')
    // Numara metnin ortasından çıkınca ayraçlar üst üste biner: "kampanya · · acele"
    .replace(/([,;:·•|\-–—])\s*(?=[,;:·•|\-–—])/g, '')
    .replace(/^[\s,;:·•|\-–—]+|[\s,;:·•|\-–—]+$/g, '')
    .trim();
  return { telefon, not: not || null };
}

/* ------------------------------------------------------------------ */
/* bot                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Botu başlatır (long polling).
 * @param {{ ayarlar: object, telegram?: object, calistir?: (job) => Promise,
 *          bildir?: (durum) => void }} p
 *   `calistir` verilmezse job'lar doğrudan runner ile koşulur; panel kendi
 *   sarmalayıcısını geçirir (kuyruk durumu ve "Durdur" düğmesi çalışsın diye).
 *   `bildir` hat durumu değişince çağrılır — panel lambası canlı kalsın diye.
 */
export function botuBaslat({ ayarlar, telegram, calistir, bildir } = {}) {
  const tg = telegram || telegramAyarlariniYukle();
  const durum = {
    acik: false,
    bot: null, // { id, username }
    hata: null,
    sonMesaj: null,
    acilanIs: 0,
    teslimEdilen: 0,
  };

  if (!tg.enabled) {
    durum.hata = 'Kapalı (config/telegram.json > enabled: false).';
    return { durum: () => ({ ...durum, ayar: kamuAyar() }), durdur: () => {} };
  }
  if (!tg.token) {
    durum.hata = tg.tokenDoldurulmadi
      ? 'Bot token\'ı doldurulmamış: config/telegram.json içindeki "token" alanına BotFather\'dan aldığın anahtarı yaz.'
      : 'Token yok — config/telegram.json içine token yaz veya VOKU_TELEGRAM_TOKEN ver.';
    log.warn(`Telegram: ${durum.hata}`);
    return { durum: () => ({ ...durum, ayar: kamuAyar() }), durdur: () => {} };
  }

  function kamuAyar() {
    return {
      enabled: tg.enabled,
      izinliChatler: tg.izinliChatler,
      toplamaMs: tg.toplamaMs,
      demoGonder: tg.demoGonder,
      belgeOlarak: tg.belgeOlarak,
      tokenVar: Boolean(tg.token),
    };
  }

  /** Hat durumu değişti — panel lambası SSE ile güncellensin. */
  function durumDegisti() {
    try {
      bildir?.({ ...durum, ayar: kamuAyar() });
    } catch {
      /* panel yayını başarısızsa bot işine devam eder */
    }
  }

  let durduruldu = false;
  let offset = 0;
  const taslaklar = new Map(); // chatId → { fotolar, metinler, zamanlayici, kullanici }
  const bekleyenBilgi = new Map(); // chatId → { metin, at }
  const teslimKilidi = new Set(); // jobId
  let zincir = Promise.resolve(); // job'lar sırayla koşar — kota tek kuyruktan yanar

  /* ---------------- API ---------------- */
  async function tgIstek(metot, govde, { form, zamanAsimiMs = 65000 } = {}) {
    const kontrolcu = new AbortController();
    const sayac = setTimeout(() => kontrolcu.abort(), zamanAsimiMs);
    try {
      const yanit = await fetch(`${API}/bot${tg.token}/${metot}`, {
        method: 'POST',
        signal: kontrolcu.signal,
        ...(form
          ? { body: form }
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(govde || {}),
            }),
      });
      const veri = await yanit.json().catch(() => ({}));
      if (!veri.ok) {
        const hata = new Error(veri.description || `Telegram ${metot} başarısız (${yanit.status})`);
        hata.kod = veri.error_code || yanit.status;
        throw hata;
      }
      return veri.result;
    } finally {
      clearTimeout(sayac);
    }
  }

  const mesajYolla = (chatId, metin, ek = {}) =>
    tgIstek('sendMessage', {
      chat_id: chatId,
      text: metin,
      disable_web_page_preview: true,
      ...ek,
    }).catch((e) => log.warn(`Telegram mesaj gönderilemedi: ${e.message}`));

  /** file_id → geçici dosya. */
  async function dosyayiIndir(fileId, adIpucu = 'foto') {
    const bilgi = await tgIstek('getFile', { file_id: fileId });
    const uzanti = path.extname(bilgi.file_path || '') || '.jpg';
    const yanit = await fetch(`${API}/file/bot${tg.token}/${bilgi.file_path}`);
    if (!yanit.ok) throw new Error(`Dosya indirilemedi (${yanit.status})`);
    const hedef = path.join(os.tmpdir(), `voku-tg-${adIpucu}-${fileId.slice(-8)}${uzanti}`);
    fs.writeFileSync(hedef, Buffer.from(await yanit.arrayBuffer()));
    return hedef;
  }

  /* ---------------- mesaj işleme ---------------- */

  function izinliMi(chatId) {
    return !tg.izinliChatler.length || tg.izinliChatler.includes(Number(chatId));
  }

  function kullaniciAdi(from) {
    if (!from) return null;
    if (from.username) return `@${from.username}`;
    return [from.first_name, from.last_name].filter(Boolean).join(' ') || `id ${from.id}`;
  }

  /** Mesajdaki görseli bulur: photo (en büyük boy) veya görsel document. */
  function gorselCikar(msg) {
    if (Array.isArray(msg.photo) && msg.photo.length) {
      const en = msg.photo.reduce((a, b) => ((b.file_size || 0) > (a.file_size || 0) ? b : a));
      return { fileId: en.file_id, ad: `${en.file_unique_id}.jpg` };
    }
    const d = msg.document;
    if (d && (String(d.mime_type || '').startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(d.file_name || ''))) {
      return { fileId: d.file_id, ad: d.file_name || `${d.file_unique_id}.jpg` };
    }
    return null;
  }

  function taslakAl(chatId, msg) {
    let t = taslaklar.get(chatId);
    if (!t) {
      t = { fotolar: [], metinler: [], zamanlayici: null, kullanici: kullaniciAdi(msg.from), chatId };
      taslaklar.set(chatId, t);
      // Fotoğraftan önce gelmiş, ömrü dolmamış bilgi varsa bu işe iliştirilir.
      const eski = bekleyenBilgi.get(chatId);
      if (eski && Date.now() - eski.at < tg.bilgiOmruMs) t.metinler.push(eski.metin);
      bekleyenBilgi.delete(chatId);
    }
    return t;
  }

  function sureyiKur(taslak, ms) {
    clearTimeout(taslak.zamanlayici);
    taslak.zamanlayici = setTimeout(() => {
      taslaklar.delete(taslak.chatId);
      taslagiIsle(taslak).catch((e) => {
        log.err(`Telegram taslağı işlenemedi: ${e.message}`);
        mesajYolla(taslak.chatId, `İş açılamadı: ${e.message}`);
      });
    }, ms);
  }

  async function mesajIsle(msg) {
    if (!msg || !msg.chat) return;
    const chatId = msg.chat.id;
    durum.sonMesaj = new Date().toISOString();
    durumDegisti(); // panelde hat canlılığı anında görünsün

    if (!izinliMi(chatId)) {
      log.warn(`Telegram: izinsiz sohbet ${chatId} (${kullaniciAdi(msg.from)}) — yok sayıldı`);
      await mesajYolla(chatId, 'Bu bot kapalı bir hat. Erişim için sistem sahibine chat id ile başvur: ' + chatId);
      return;
    }

    const metin = (msg.text || msg.caption || '').trim();

    // --- komutlar ---
    if (metin.startsWith('/')) {
      const komut = metin.split(/[\s@]/)[0].toLowerCase();
      if (komut === '/start' || komut === '/yardim' || komut === '/help') {
        return mesajYolla(
          chatId,
          'voku hattı açık.\n\n' +
            'Fotoğrafı gönder — her fotoğraf bir iş olur.\n' +
            'Yanına telefon numarası, isim ya da not yaz (aynı mesajda veya hemen ardından).\n' +
            'Üretim bitince kareler tek albüm halinde buraya düşer.\n' +
            'Damgasız üretim gelir; DEMO damgalı istiyorsan mesaja "demo" yaz.\n\n' +
            '/durum  son işler\n' +
            '/iptal  bekleyen fotoğrafı at\n' +
            '/id     bu sohbetin kimliği'
        );
      }
      if (komut === '/id') return mesajYolla(chatId, `chat id: ${chatId}`);
      if (komut === '/iptal') {
        const t = taslaklar.get(chatId);
        // Fotoğraf beklemeden gelmiş bilgi de temizlenir — yoksa raftaki eski
        // numara sonraki fotoğrafa yapışıyor.
        const bilgiVardi = bekleyenBilgi.delete(chatId);
        if (!t) {
          return mesajYolla(chatId, bilgiVardi ? 'Bekleyen bilgi atıldı.' : 'Bekleyen bir şey yok.');
        }
        clearTimeout(t.zamanlayici);
        taslaklar.delete(chatId);
        return mesajYolla(chatId, 'Bekleyen fotoğraf atıldı.');
      }
      if (komut === '/durum') {
        const isler = jobListele()
          .filter((j) => String(j.kaynakBilgi?.chatId) === String(chatId))
          .slice(-5)
          .reverse();
        if (!isler.length) return mesajYolla(chatId, 'Bu sohbetten açılmış iş yok.');
        const satirlar = isler.map((j) => {
          const tamam = j.tasks.filter((t) => t.status === 'done').length;
          return `${j.id} · ${tamam}/${j.tasks.length} kare · ${DURUM_METNI[durumuHesapla(j)] || durumuHesapla(j)}`;
        });
        return mesajYolla(chatId, satirlar.join('\n'));
      }
      // Bilinmeyen komut: metin gibi işlenmesin, künyeye "/xyz" düşmesin.
      return mesajYolla(chatId, 'Bilinmeyen komut. /yardim');
    }

    const gorsel = gorselCikar(msg);

    if (gorsel) {
      const t = taslakAl(chatId, msg);
      t.fotolar.push({ ...gorsel, mesajId: msg.message_id });
      if (metin) t.metinler.push(metin);
      // Aynı albümdeki fotoğraflar peş peşe gelir; her biri süreyi tazeler.
      sureyiKur(t, metin ? tg.metinSonrasiMs : tg.toplamaMs);
      return;
    }

    if (!metin) return; // sticker, ses, konum… — bu hatta işi yok

    const t = taslaklar.get(chatId);
    if (t) {
      t.metinler.push(metin);
      sureyiKur(t, tg.metinSonrasiMs);
      return;
    }

    // Fotoğraf yok: bilgiyi rafa koy, ilk fotoğrafa iliştirilecek.
    bekleyenBilgi.set(chatId, { metin, at: Date.now() });
    const { telefon } = kunyeCikar(metin);
    await mesajYolla(
      chatId,
      telefon
        ? `Numara alındı (${telefon}). Şimdi fotoğrafı gönder, iş açılsın.`
        : 'Not alındı. Şimdi fotoğrafı gönder, iş açılsın.'
    );
  }

  /**
   * Hangi hal teslim edilecek? Mesajda "demo" geçiyorsa damgalı hal,
   * geçmiyorsa ham üretim — asıl iş üretimdir, demo ayrıca istenir.
   */
  function teslimVaryanti(metin) {
    const anahtar = String(tg.demoAnahtari || 'demo').toLocaleLowerCase('tr');
    return String(metin || '').toLocaleLowerCase('tr').includes(anahtar)
      ? 'demo'
      : tg.varsayilanVaryant === 'demo'
        ? 'demo'
        : 'uretim';
  }

  /** Toplama penceresi kapandı: fotoğraf başına bir job aç, sıraya koy. */
  async function taslagiIsle(taslak) {
    const hamMetin = taslak.metinler.join(' · ');
    const varyant = teslimVaryanti(hamMetin);
    const { telefon, not } = kunyeCikar(hamMetin);
    const promptlar = promptlariYukle(null, ayarlar);
    const acilan = [];

    for (const foto of taslak.fotolar) {
      let gecici;
      try {
        gecici = await dosyayiIndir(foto.fileId, 'input');
        const job = await jobOlustur({
          imagePath: gecici,
          phone: telefon,
          prompts: promptlar,
          note: not || taslak.kullanici,
          kaynak: 'telegram',
          yatayEsigi: ayarlar.girdiYatayOrani,
          kaynakBilgi: {
            chatId: taslak.chatId,
            mesajId: foto.mesajId,
            kullanici: taslak.kullanici,
            dosyaAdi: foto.ad,
            alindiAt: new Date().toISOString(),
            teslimVaryanti: varyant,
            teslimAt: null,
          },
        });
        job.sourceImage = `telegram:${foto.ad}`;
        jobYaz(job);
        acilan.push(job);
        durum.acilanIs++;
        durumDegisti();
        log.ok(`Telegram → job ${job.id} (${job.tasks.length} task, ${taslak.kullanici})`);
      } catch (e) {
        log.err(`Telegram job açılamadı: ${e.message}`);
        await mesajYolla(taslak.chatId, `Bu fotoğraf için iş açılamadı: ${e.message}`);
      } finally {
        if (gecici) fs.rmSync(gecici, { force: true });
      }
    }

    if (!acilan.length) return;

    const kunye = [telefon ? `tel ${telefon}` : 'numara yok', not].filter(Boolean).join(' · ');
    await mesajYolla(
      taslak.chatId,
      `${acilan.length > 1 ? `${acilan.length} iş açıldı` : 'İş açıldı'} — ${kunye}\n` +
        acilan.map((j) => `${j.id} · ${j.tasks.length} kare`).join('\n') +
        `\n\nÜretim başladı. Bitince ${varyant === 'demo' ? 'DEMO damgalı' : 'damgasız üretim'} kareler buraya düşecek.` +
        (varyant === 'demo' ? '' : '\n(Damgalı istersen mesaja "demo" yaz.)')
    );

    // Sırayla koş: paralel job'lar ChatGPT/Gemini kotasını aynı anda yakar.
    for (const job of acilan) {
      zincir = zincir
        .then(() => (calistir ? calistir(job) : jobuCalistir(job, ayarlar)))
        .catch((e) => log.err(`${job.id} çalıştırılamadı: ${e?.message || e}`));
    }
  }

  /* ---------------- teslim ---------------- */

  /**
   * İstenen varyantı toplar; o dosya yoksa öteki varyanta düşer —
   * çıktısız bırakmaktansa damgası farklı olanı göndermek yeğdir.
   */
  function teslimDosyalari(job, varyant = 'uretim') {
    const istenen = varyantDizini(job, varyant);
    const yedek = varyantDizini(job, varyant === 'demo' ? 'uretim' : 'demo');
    const liste = [];
    let yedekten = 0;
    for (const t of job.tasks) {
      if (t.status !== 'done') continue;
      for (const dosya of t.files || []) {
        const a = path.join(istenen, dosya);
        const b = path.join(yedek, dosya);
        if (fs.existsSync(a)) liste.push({ yol: a, ad: dosya });
        else if (fs.existsSync(b)) {
          liste.push({ yol: b, ad: dosya });
          yedekten++;
        }
      }
    }
    if (yedekten) log.warn(`${job.id}: ${yedekten} kare ${varyant} halinde yok, öteki varyanttan gönderiliyor`);
    return liste;
  }

  /** Telegram foto sınırına sığsın diye jpeg'e indirger (belge modunda dokunmaz). */
  async function gonderimeHazirla(dosya) {
    if (tg.belgeOlarak) return { ...dosya, gecici: false };
    try {
      const hedef = path.join(os.tmpdir(), `voku-tg-out-${Date.now()}-${dosya.ad.replace(/\.\w+$/, '')}.jpg`);
      await sharp(dosya.yol)
        .rotate()
        .resize({
          width: tg.gonderimUzunKenar,
          height: tg.gonderimUzunKenar,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 88 })
        .toFile(hedef);
      return { yol: hedef, ad: dosya.ad.replace(/\.\w+$/, '.jpg'), gecici: true };
    } catch (e) {
      log.warn(`Telegram gönderim hazırlığı başarısız (${e.message}) — dosya olduğu gibi gidiyor`);
      return { ...dosya, gecici: false };
    }
  }

  /** Tek albüm = en fazla 10 öğe; başlık yalnız ilk öğede görünür. */
  async function albumYolla(chatId, dosyalar, baslik) {
    const form = new FormData();
    const media = [];
    dosyalar.forEach((d, i) => {
      const alan = `f${i}`;
      form.append(alan, new Blob([fs.readFileSync(d.yol)]), d.ad);
      media.push({
        type: tg.belgeOlarak ? 'document' : 'photo',
        media: `attach://${alan}`,
        ...(i === 0 && baslik ? { caption: baslik } : {}),
      });
    });
    form.append('chat_id', String(chatId));
    form.append('media', JSON.stringify(media));
    await tgIstek('sendMediaGroup', null, { form, zamanAsimiMs: 180000 });
  }

  /**
   * İş bitmişse demo kareleri tek seferde teslim eder.
   * Job her diske yazıldığında çağrılır; `kaynakBilgi.teslimAt` damgası ve
   * bellekteki kilit ile bir işi iki kez göndermez.
   */
  async function belkiTeslimEt(ozet) {
    const chatId = ozet?.kaynakBilgi?.chatId;
    if (!chatId || ozet.kaynak !== 'telegram') return;
    if (ozet.kaynakBilgi.teslimAt) return;
    if (teslimKilidi.has(ozet.id)) return;
    // Bekleyen/koşan task varsa iş bitmemiştir (durdurulan iş de burada kalır).
    if (ozet.tasks.some((t) => t.status === 'pending' || t.status === 'running')) return;

    teslimKilidi.add(ozet.id);
    try {
      const job = jobOku(ozet.id);
      if (job.kaynakBilgi?.teslimAt) return;

      // Varyant iş açılırken mesajdan belirlendi; eski işlerde alan yok → demo.
      const varyant = job.kaynakBilgi?.teslimVaryanti === 'uretim' ? 'uretim' : 'demo';
      const dosyalar = tg.demoGonder ? teslimDosyalari(job, varyant) : [];
      const hatali = job.tasks.filter((t) => t.status === 'failed').length;
      const kunye = [job.phone ? `tel ${job.phone}` : null, job.note].filter(Boolean).join(' · ');

      if (!dosyalar.length) {
        await mesajYolla(
          chatId,
          `${job.id} — kare üretilemedi${hatali ? ` (${hatali} hata)` : ''}. Panelden yeniden denenebilir.`
        );
      } else {
        const baslik =
          `${job.id}${kunye ? ` · ${kunye}` : ''}\n` +
          `${dosyalar.length} ${varyant === 'demo' ? 'demo (damgalı)' : 'üretim'} kare` +
          `${hatali ? ` · ${hatali} kare üretilemedi` : ''}`;
        // Hazırlık toplu yapılır; albümler 10'arlı bölünür ama başlık ilk albümde.
        const hazir = [];
        for (const d of dosyalar) hazir.push(await gonderimeHazirla(d));
        try {
          for (let i = 0; i < hazir.length; i += 10) {
            const parca = hazir.slice(i, i + 10);
            if (parca.length === 1) {
              const form = new FormData();
              form.append('chat_id', String(chatId));
              form.append(
                tg.belgeOlarak ? 'document' : 'photo',
                new Blob([fs.readFileSync(parca[0].yol)]),
                parca[0].ad
              );
              if (i === 0) form.append('caption', baslik);
              await tgIstek(tg.belgeOlarak ? 'sendDocument' : 'sendPhoto', null, {
                form,
                zamanAsimiMs: 180000,
              });
            } else {
              await albumYolla(chatId, parca, i === 0 ? baslik : null);
            }
          }
        } finally {
          for (const h of hazir) if (h.gecici) fs.rmSync(h.yol, { force: true });
        }
      }

      const guncel = jobOku(ozet.id);
      guncel.kaynakBilgi = {
        ...(guncel.kaynakBilgi || {}),
        teslimAt: new Date().toISOString(),
        teslimAdet: dosyalar.length,
        teslimVaryanti: varyant,
      };
      jobYaz(guncel);
      durum.teslimEdilen++;
      durumDegisti();
      log.ok(`Telegram teslim: ${job.id} → ${dosyalar.length} ${varyant} karesi`);
    } catch (e) {
      log.err(`Telegram teslim başarısız (${ozet.id}): ${e.message}`);
      await mesajYolla(chatId, `${ozet.id} teslim edilemedi: ${e.message}`);
    } finally {
      teslimKilidi.delete(ozet.id);
    }
  }

  // Teslim job olayına bağlı — işi panelden başlatsan da sonuç sohbete düşer.
  const jobDinleyici = (job) => {
    belkiTeslimEt(job).catch((e) => log.err(`Teslim hatası: ${e.message}`));
  };
  olaylar.on('job', jobDinleyici);

  /* ---------------- polling ---------------- */

  async function dongu() {
    let ardArdaHata = 0;
    while (!durduruldu) {
      // Hattı başka bir voku örneği tutuyorsa sırada bekle — kapanınca devralınır.
      if (!kilitBendeMi()) {
        if (durum.acik) {
          durum.acik = false;
          log.warn('Telegram: hat başka bir voku örneğinde — o kapanınca devralınacak.');
          durum.hata = 'Hattı başka bir voku örneği dinliyor.';
          durumDegisti();
        }
        await new Promise((r) => setTimeout(r, 10000));
        continue;
      }
      kilidiTazele();
      // Kilit bizde: hat açık sayılır. (Onayı ilk getUpdates dönüşünde gelir
      // ama uzun-polling 50 sn sürebiliyor; panel o kadar "kapalı" görmesin.)
      if (!durum.acik) {
        durum.acik = true;
        durum.hata = null;
        log.ok('Telegram: hat devralındı, dinleme sürüyor.');
        durumDegisti();
      }
      try {
        const guncellemeler = await tgIstek(
          'getUpdates',
          { offset, timeout: 50, allowed_updates: ['message'] },
          { zamanAsimiMs: 65000 }
        );
        ardArdaHata = 0;
        if (!durum.acik) {
          // Çakışma ya da geçici hata bitti — hat bu sürece geçti.
          durum.acik = true;
          durum.hata = null;
          log.ok('Telegram: hat devralındı, dinleme sürüyor.');
          durumDegisti();
        }
        for (const u of guncellemeler) {
          offset = u.update_id + 1;
          if (!u.message) continue;
          try {
            await mesajIsle(u.message);
          } catch (e) {
            log.err(`Telegram mesajı işlenemedi: ${e.message}`);
          }
        }
      } catch (e) {
        if (durduruldu) return;
        // 409: aynı token'la başka bir voku örneği (panel + CLI) dinliyor.
        // Pes edilmez — öteki örnek kapanınca hattı bu süreç devralsın diye
        // sessizce beklenip tekrar denenir (ilk çakışmada bir kez loglanır).
        if (e.kod === 409) {
          if (durum.acik) {
            durum.acik = false;
            log.warn('Telegram: bot başka bir yerde dinleniyor — o örnek kapanınca devralınacak.');
          }
          durum.hata = 'Başka bir voku örneği aynı botu dinliyor.';
          await new Promise((r) => setTimeout(r, 15000));
          continue;
        }
        ardArdaHata++;
        durum.hata = e.message;
        log.warn(`Telegram polling hatası (${ardArdaHata}): ${e.message}`);
        await new Promise((r) => setTimeout(r, Math.min(30000, 2000 * ardArdaHata)));
      }
    }
  }

  (async () => {
    try {
      const ben = await tgIstek('getMe', {}, { zamanAsimiMs: 15000 });
      durum.bot = { id: ben.id, username: ben.username, ad: ben.first_name };
      durum.acik = true;
      durum.hata = null;
      durumDegisti();
      log.ok(
        `Telegram botu dinliyor: @${ben.username}` +
          (tg.izinliChatler.length ? ` (izinli: ${tg.izinliChatler.join(', ')})` : ' (herkese açık)')
      );
      // Panel kapalıyken biten işler varsa açılışta teslim edilir.
      for (const j of jobListele()) jobDinleyici(j);
      await dongu();
    } catch (e) {
      durum.acik = false;
      // Telegram 401/404'ü "Unauthorized"/"Not Found" diye döner; kullanan
      // kişi için bu, token'ın yanlış olduğu anlamına gelir.
      durum.hata =
        e.kod === 401 || e.kod === 404
          ? 'Bot token\'ı geçersiz — config/telegram.json içindeki "token" alanını kontrol et.'
          : e.message;
      durumDegisti();
      log.err(`Telegram botu başlatılamadı: ${durum.hata}`);
      // Token reddedildiyse ısrar anlamsız; ağ/geçici hatada dinlemeyi dene.
      if (e.kod !== 401 && e.kod !== 404) await dongu();
    }
  })();

  return {
    durum: () => ({ ...durum, ayar: kamuAyar() }),
    durdur() {
      durduruldu = true;
      durum.acik = false;
      kilidiBirak();
      olaylar.off('job', jobDinleyici);
      for (const t of taslaklar.values()) clearTimeout(t.zamanlayici);
      taslaklar.clear();
    },
  };
}
