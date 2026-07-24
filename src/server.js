import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, OUTPUT_DIR } from './paths.js';
import { ayarlariYukle, promptlariYukle, promptlariKaydet, promptDosyaYolu } from './config.js';
import { jobOlustur, waLinki, kaynakNormalize } from './job.js';
import {
  jobOku,
  jobListele,
  jobYolu,
  jobYaz,
  manifestYaz,
  durumuHesapla,
  baskiOzetiCikar,
  baskiKaydi,
  olaylar,
} from './store.js';
import { jobuCalistir } from './runner.js';
import { varyantSayilari, taskVaryantDurumu, onizlemeYolu } from './varyant.js';
import { odaOzeti, sayfaBul, sayfayiBas, basimiGeriAl, etdxUret } from './sayfa.js';
import { contextAc, sayfaAl } from './browser.js';
import { adaptorAl } from './adapters/index.js';
import { botuBaslat, telegramAyarlariniYukle } from './telegram.js';
import { erisimAyarlariniYukle, girebilirMi, cerezKur, KAPI_SAYFASI } from './erisim.js';
import { disErisimDurumu } from './tunel.js';
import { dosyayiGoster, tarayicidaAc } from './platform.js';
import { log, logAbone } from './logger.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/** Panel süreç durumu: hangi job koşuyor, hangi login penceresi açık. */
const durum = {
  kosanJoblar: new Set(),
  loginContextleri: new Map(), // platform → { ctx, baslangic }   (tarayıcılı giriş)
  girisSurecleri: new Map(), // platform → { surec, satirlar, url } (süreçli giriş)
  durdurucular: new Map(), // jobId → AbortController
  dogrulama: new Map(), // platform → { hazir, kontrol, mesaj }
  telegram: null, // { durum(), durdur() } — bot açıksa
};

const sseIstemcileri = new Set();

function yayinla(tip, veri) {
  const paket = `data: ${JSON.stringify({ tip, veri })}\n\n`;
  for (const res of sseIstemcileri) {
    res.write(paket);
  }
}

olaylar.on('job', (job) => yayinla('job', jobOzet(job)));
logAbone((satir) => yayinla('log', satir));

function jobOzet(job) {
  return {
    id: job.id,
    createdAt: job.createdAt,
    phone: job.phone,
    waLink: waLinki(job.phone),
    fakeId: job.fakeId,
    note: job.note,
    kaynak: kaynakNormalize(job.kaynak),
    kaynakBilgi: job.kaynakBilgi || null,
    status: durumuHesapla(job),
    kosuyor: durum.kosanJoblar.has(job.id),
    outputDir: job.outputDir,
    inputFile: job.inputImage ? path.basename(job.inputImage) : null,
    inputDonduruldu: Boolean(job.inputDonduruldu),
    inputBoyut: job.inputBoyut || null,
    varyantlar: varyantSayilari(job),
    tasks: job.tasks.map((t) => ({
      id: t.id,
      promptId: t.promptId,
      platform: t.platform,
      prompt: t.prompt,
      status: t.status,
      attempts: t.attempts,
      files: t.files,
      error: t.error,
      varyantVar: taskVaryantDurumu(job, t),
      baski: (t.files || []).map((d) => baskiKaydi(job, d)),
    })),
    baskiOzet: baskiOzetiCikar(job),
  };
}

function json(res, kod, govde) {
  const g = JSON.stringify(govde);
  res.writeHead(kod, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(g);
}

async function govdeOku(req, limitMb = 40) {
  const parcalar = [];
  let boyut = 0;
  for await (const p of req) {
    boyut += p.length;
    if (boyut > limitMb * 1024 * 1024) throw new Error(`Gövde çok büyük (>${limitMb}MB).`);
    parcalar.push(p);
  }
  if (!parcalar.length) return {};
  return JSON.parse(Buffer.concat(parcalar).toString('utf8'));
}

/** Oturum profili var mı, ne zaman kaydedildi? */
function oturumDurumu(platform) {
  const adaptor = adaptorAl(platform.adapter || platform.ad);
  const surecKaydi = durum.girisSurecleri.get(platform.ad);
  const ortak = {
    ad: platform.ad,
    url: platform.url,
    enabled: platform.enabled !== false,
    adapter: platform.adapter || platform.ad,
    girisTipi: adaptor.girisTipi || 'tarayici',
    dogrulama: durum.dogrulama.get(platform.ad) || null,
    girisSuruyor: Boolean(surecKaydi),
    girisUrl: surecKaydi?.url || null,
    girisCikti: surecKaydi ? surecKaydi.satirlar.slice(-8).join('') : null,
    ipucu: adaptor.girisKomutu?.(platform)?.ipucu || null,
  };

  // Sürücü kendi giriş durumunu biliyorsa (Codex) onu kullan.
  if (typeof adaptor.girisDurumu === 'function') {
    return { ...ortak, ...adaptor.girisDurumu(platform), pencereAcik: false };
  }

  const profil = platform.profileDir;
  const damga = path.join(profil, '.voku-login.json');
  const varMi = fs.existsSync(path.join(profil, 'Default')) || fs.existsSync(damga);
  let sonGiris = null;
  if (fs.existsSync(damga)) {
    try {
      sonGiris = JSON.parse(fs.readFileSync(damga, 'utf8')).sonGiris;
    } catch {
      /* damga bozuksa yok say */
    }
  }
  return {
    ...ortak,
    profilVar: varMi,
    sonGiris,
    pencereAcik: durum.loginContextleri.has(platform.ad),
  };
}

function durumPaketi(ayarlar) {
  return {
    platformlar: Object.values(ayarlar.platforms).map(oturumDurumu),
    joblar: jobListele().map(jobOzet).reverse(),
    telegram: durum.telegram ? durum.telegram.durum() : { acik: false, hata: 'Bot bu panelde açık değil.' },
    promptDosyasi: path.relative(ROOT, promptDosyaYolu()),
    ayarlar: {
      maxAttempts: ayarlar.maxAttempts,
      headless: ayarlar.headless,
      parallelPlatforms: ayarlar.parallelPlatforms,
      generationTimeoutMs: ayarlar.generationTimeoutMs,
    },
  };
}

async function jobuArkaPlandaCalistir(job, ayarlar) {
  if (durum.kosanJoblar.has(job.id)) return;
  durum.kosanJoblar.add(job.id);
  const kontrolcu = new AbortController();
  durum.durdurucular.set(job.id, kontrolcu);
  yayinla('kosu', { id: job.id, kosuyor: true });
  try {
    await jobuCalistir(job, ayarlar, { signal: kontrolcu.signal });
  } catch (e) {
    log.err(`${job.id} çalıştırılamadı: ${e?.message || e}`);
  } finally {
    durum.kosanJoblar.delete(job.id);
    durum.durdurucular.delete(job.id);
    yayinla('kosu', { id: job.id, kosuyor: false });
    yayinla('job', jobOzet(jobOku(job.id)));
  }
}

/** Çalışan job'ı durdurur; biten task'lar korunur, kalanlar bekliyor olur. */
function jobuDurdur(jobId) {
  const kontrolcu = durum.durdurucular.get(jobId);
  if (!kontrolcu) throw new Error('Bu iş şu an çalışmıyor.');
  kontrolcu.abort();
  log.warn(`${jobId} durduruluyor — süren üretimler kesiliyor`);
  return { ok: true };
}

/**
 * Süreçli giriş (Codex): `codex login` alt süreç olarak koşar, çıktısı
 * panele canlı akar, URL yakalanır. Süreç kendi bitince otomatik doğrulanır.
 */
async function surecliGirisBaslat(platformAdi, platform, adaptor, ayarlar) {
  if (durum.girisSurecleri.has(platformAdi)) return { zatenAcik: true };

  const { komut, argumanlar } = adaptor.girisKomutu(platform);
  const surec = spawn(komut, argumanlar, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const kayit = { surec, satirlar: [], url: null };
  durum.girisSurecleri.set(platformAdi, kayit);
  log.info(`[${platformAdi}] giriş başlatıldı: ${komut} ${argumanlar.join(' ')}`);

  // Program yoksa ChildProcess 'error' fırlatır; yakalanmazsa Node bunu
  // işlenmemiş olay sayıp TÜM paneli düşürür. Eksik bir CLI yüzünden kuyruk
  // ve Telegram botu ölmemeli — hata karta yazılır, panel ayakta kalır.
  surec.on('error', (e) => {
    durum.girisSurecleri.delete(platformAdi);
    const mesaj =
      e.code === 'ENOENT'
        ? `"${komut}" bulunamadı. Codex CLI kurulu değil ya da PATH'te değil — kurmak için: npm install -g @openai/codex (kurduktan sonra paneli yeniden başlat).`
        : e.message;
    log.err(`[${platformAdi}] giriş başlatılamadı: ${mesaj}`);
    yayinla('giris', { platform: platformAdi, metin: `${mesaj}\n` });
    yayinla('giris', { platform: platformAdi, bitti: true, kod: -1 });
    durum.dogrulama.set(platformAdi, {
      hazir: false,
      kontrol: new Date().toISOString(),
      mesaj,
    });
    yayinla('platform', oturumDurumu(platform));
  });

  const isle = (veri) => {
    const metin = String(veri);
    kayit.satirlar.push(metin);
    if (kayit.satirlar.length > 40) kayit.satirlar.shift();
    if (!kayit.url) {
      const bulunan = metin.match(/https?:\/\/\S+/);
      if (bulunan) kayit.url = bulunan[0].replace(/[.,)\]]+$/, '');
    }
    yayinla('giris', { platform: platformAdi, metin, url: kayit.url });
    const temiz = metin.trim();
    if (temiz) log.info(`[${platformAdi}] ${temiz.slice(0, 200)}`);
  };
  surec.stdout.on('data', isle);
  surec.stderr.on('data', isle);

  surec.on('close', async (kod) => {
    durum.girisSurecleri.delete(platformAdi);
    if (kod === 0) log.ok(`[${platformAdi}] giriş tamamlandı`);
    else log.warn(`[${platformAdi}] giriş süreci kapandı (kod ${kod})`);
    yayinla('giris', { platform: platformAdi, bitti: true, kod });
    const sonuc = await oturumDogrula(platformAdi, ayarlar).catch((e) => ({
      hazir: false,
      kontrol: new Date().toISOString(),
      mesaj: String(e?.message || e),
    }));
    yayinla('platform', { ...oturumDurumu(platform), dogrulama: sonuc });
  });

  return { zatenAcik: false, surecli: true };
}

async function loginBaslat(platformAdi, ayarlar) {
  const platform = ayarlar.platforms[platformAdi];
  if (!platform) throw new Error(`Bilinmeyen platform: ${platformAdi}`);
  const adaptor = adaptorAl(platform.adapter || platformAdi);
  if (adaptor.girisTipi === 'surec') {
    return surecliGirisBaslat(platformAdi, platform, adaptor, ayarlar);
  }
  if (durum.loginContextleri.has(platformAdi)) {
    return { zatenAcik: true };
  }
  const ctx = await contextAc(platform, ayarlar, { headless: false });
  const page = await sayfaAl(ctx);
  await page.goto(platform.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  durum.loginContextleri.set(platformAdi, { ctx, baslangic: Date.now() });
  log.info(`[${platformAdi}] giriş penceresi açıldı`);
  return { zatenAcik: false };
}

/** Süren giriş sürecini iptal eder ("Vazgeç"). */
function surecliGirisIptal(platformAdi) {
  const kayit = durum.girisSurecleri.get(platformAdi);
  if (!kayit) throw new Error('Süren giriş yok.');
  kayit.surec.kill('SIGTERM');
  durum.girisSurecleri.delete(platformAdi);
  log.warn(`[${platformAdi}] giriş iptal edildi`);
  return { ok: true };
}

async function loginBitir(platformAdi, ayarlar) {
  if (durum.girisSurecleri.has(platformAdi)) {
    // Süreçli girişte "tamamladım" yok — süreç kendi biter; buraya düşerse iptal.
    return surecliGirisIptal(platformAdi);
  }
  const kayit = durum.loginContextleri.get(platformAdi);
  if (!kayit) throw new Error('Açık giriş penceresi yok.');
  const platform = ayarlar.platforms[platformAdi];
  const adaptor = adaptorAl(platform.adapter || platformAdi);

  // Sürücü çerez istiyorsa (HTTP köprüsü) pencere kapanmadan önce al.
  if (typeof adaptor.cerezleriSenkronla === 'function') {
    try {
      const cerezler = await kayit.ctx.cookies([
        'https://gemini.google.com',
        'https://google.com',
      ]);
      await adaptor.cerezleriSenkronla(cerezler, platform);
    } catch (e) {
      log.warn(`[${platformAdi}] çerez senkronu başarısız: ${e.message}`);
    }
  }

  await kayit.ctx.close().catch(() => {});
  durum.loginContextleri.delete(platformAdi);
  fs.mkdirSync(platform.profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(platform.profileDir, '.voku-login.json'),
    JSON.stringify({ sonGiris: new Date().toISOString() }, null, 2)
  );
  log.ok(`[${platformAdi}] oturum kaydedildi`);
}

/** Oturumu headless açıp adapter'ın arayüzü tanıyıp tanımadığını sınar. */
async function oturumDogrula(platformAdi, ayarlar) {
  const platform = ayarlar.platforms[platformAdi];
  if (!platform) throw new Error(`Bilinmeyen platform: ${platformAdi}`);
  if (durum.loginContextleri.has(platformAdi)) {
    throw new Error('Giriş penceresi açıkken doğrulama yapılamaz. Önce girişi tamamla.');
  }
  const adaptor = adaptorAl(platform.adapter || platformAdi);
  const sel = ayarlar.selectors[platformAdi] || {};
  let ctx;
  try {
    if (adaptor.tarayiciGerekli === false) {
      // Tarayıcısız sürücü (Codex): tarayıcı açmadan kendi hazırlık kontrolü.
      await adaptor.hazirla(null, platform, sel, ayarlar);
      const sonuc = {
        hazir: true,
        kontrol: new Date().toISOString(),
        mesaj: `${adaptor.ad} sürücüsü hazır — tarayıcı gerekmiyor.`,
      };
      durum.dogrulama.set(platformAdi, sonuc);
      return sonuc;
    }
    // Headless AÇILMAZ: ChatGPT/Gemini headless Chrome'u bot kontrolüne sokuyor
    // ("Bir dakika lütfen…"), oturum açık olsa bile arayüz gelmiyor.
    ctx = await contextAc(platform, ayarlar, { headless: ayarlar.headless });
    const page = await sayfaAl(ctx);
    await adaptor.hazirla(page, platform, sel, ayarlar);
    const sonuc = { hazir: true, kontrol: new Date().toISOString(), mesaj: 'Oturum açık, arayüz tanındı.' };
    durum.dogrulama.set(platformAdi, sonuc);
    return sonuc;
  } catch (e) {
    const sonuc = {
      hazir: false,
      kontrol: new Date().toISOString(),
      mesaj: String(e?.message || e),
    };
    durum.dogrulama.set(platformAdi, sonuc);
    return sonuc;
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
}

function dosyaServisEt(res, dosyaYolu) {
  if (!fs.existsSync(dosyaYolu) || !fs.statSync(dosyaYolu).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Bulunamadı');
  }
  const uzanti = path.extname(dosyaYolu).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[uzanti] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(dosyaYolu).pipe(res);
}

/** Çıktı klasörü dışına çıkmayı engeller (varyant alt klasörleri dahil). */
function guvenliCiktiYolu(job, ...parcalar) {
  const hedef = path.resolve(job.outputDir, ...parcalar);
  const kok = path.resolve(job.outputDir) + path.sep;
  if (!hedef.startsWith(kok)) throw new Error('Geçersiz dosya yolu.');
  return hedef;
}

async function apiIstek(req, res, url, ayarlar, erisim = null) {
  const yol = url.pathname;
  const parcalar = yol.split('/').filter(Boolean); // ['api', ...]

  // --- durum + canlı akış ---
  if (yol === '/api/state' && req.method === 'GET') {
    const paket = durumPaketi(ayarlar);
    // Dış erişim durumu ngrok'un kendi API'sinden gelir; panele girebilen
    // herkes bağlantıyı da görür (ekiple paylaşılan tek anahtar).
    const d = await disErisimDurumu();
    paket.disErisim =
      d.acik && erisim?.erisimToken
        ? { ...d, paylasimLinki: `${d.adres}/?anahtar=${erisim.erisimToken}` }
        : d;
    return json(res, 200, paket);
  }

  if (yol === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': voku\n\n');
    sseIstemcileri.add(res);
    const kalp = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(kalp);
      sseIstemcileri.delete(res);
    });
    return;
  }

  // --- baskı odası ---
  if (yol === '/api/baski-odasi' && req.method === 'GET') {
    return json(res, 200, odaOzeti());
  }

  // /api/sayfa/<id>/<eylem>
  if (parcalar[1] === 'sayfa' && parcalar[2]) {
    const sayfaId = decodeURIComponent(parcalar[2]);
    const eylem = parcalar[3];
    try {
      if (eylem === 'bas' && req.method === 'POST') {
        const sonuc = sayfayiBas(sayfaId);
        return json(res, 200, { ...odaOzeti(), ...sonuc });
      }
      if (eylem === 'geri-al' && req.method === 'POST') {
        basimiGeriAl(sayfaId);
        return json(res, 200, odaOzeti());
      }
      if (eylem === 'etdx' && req.method === 'POST') {
        const sonuc = await etdxUret(sayfaId);
        return json(res, 200, { ...odaOzeti(), etdx: path.basename(sonuc.yol) });
      }
      if (eylem === 'etdx' && req.method === 'GET') {
        const sayfa = sayfaBul(sayfaId);
        if (!sayfa?.etdx) return json(res, 404, { hata: 'Bu sayfanın .etdx dosyası henüz üretilmedi.' });
        const yolTam = path.join(ROOT, sayfa.etdx);
        if (!fs.existsSync(yolTam)) return json(res, 404, { hata: 'Dosya bulunamadı.' });
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${sayfaId}.etdx"`,
          // Boyut bilinsin ki tarayıcı/panel ilerleme gösterebilsin.
          'content-length': fs.statSync(yolTam).size,
        });
        return fs.createReadStream(yolTam).pipe(res);
      }
    } catch (e) {
      return json(res, 400, { hata: String(e?.message || e) });
    }
    return json(res, 404, { hata: 'Bilinmeyen sayfa eylemi' });
  }

  // --- promptlar ---
  if (yol === '/api/prompts' && req.method === 'GET') {
    try {
      return json(res, 200, { prompts: promptlariYukle(null, ayarlar), hata: null });
    } catch (e) {
      // Liste doğrulamadan geçmese bile HAM halini gönder: panelde düzenlenip
      // kaydedilebilsin. Boş liste dönmek kullanıcıyı çıkmaza sokuyor.
      let ham = [];
      try {
        const dosya = JSON.parse(fs.readFileSync(promptDosyaYolu(), 'utf8'));
        const liste = Array.isArray(dosya) ? dosya : dosya.prompts;
        ham = (liste || []).map((p, i) => ({
          id: String(p.id ?? `p${i + 1}`),
          platform: String(p.platform || ''),
          count: Number(p.count) > 0 ? Number(p.count) : 1,
          prompt: String(p.prompt || ''),
          sira: i + 1,
        }));
      } catch {
        /* dosya okunamıyorsa boş liste + hata mesajı kalır */
      }
      return json(res, 200, { prompts: ham, hata: String(e?.message || e) });
    }
  }

  if (yol === '/api/prompts' && req.method === 'PUT') {
    const govde = await govdeOku(req);
    try {
      const kaydedilen = promptlariKaydet(govde.prompts, ayarlar);
      log.ok(`Prompt listesi kaydedildi (${kaydedilen.length} prompt)`);
      return json(res, 200, { prompts: kaydedilen });
    } catch (e) {
      return json(res, 400, { hata: String(e?.message || e) });
    }
  }

  // --- oturumlar ---
  if (parcalar[1] === 'login' && parcalar[2]) {
    const platformAdi = parcalar[2];
    const eylem = parcalar[3];
    if (req.method !== 'POST') return json(res, 405, { hata: 'POST bekleniyor' });
    try {
      if (eylem === 'start') return json(res, 200, await loginBaslat(platformAdi, ayarlar));
      if (eylem === 'finish') {
        await loginBitir(platformAdi, ayarlar);
        return json(res, 200, { ok: true, platform: oturumDurumu(ayarlar.platforms[platformAdi]) });
      }
      if (eylem === 'cancel') return json(res, 200, surecliGirisIptal(platformAdi));
      if (eylem === 'verify') {
        const sonuc = await oturumDogrula(platformAdi, ayarlar);
        return json(res, 200, sonuc);
      }
      return json(res, 404, { hata: 'Bilinmeyen eylem' });
    } catch (e) {
      return json(res, 400, { hata: String(e?.message || e) });
    }
  }

  // --- joblar ---
  if (yol === '/api/jobs' && req.method === 'POST') {
    const govde = await govdeOku(req);
    try {
      if (!govde.imageBase64) throw new Error('Fotoğraf gerekli.');
      const uzanti = path.extname(govde.imageName || '') || '.jpg';
      const gecici = path.join(os.tmpdir(), `voku-input-${Date.now()}${uzanti}`);
      fs.writeFileSync(gecici, Buffer.from(govde.imageBase64.split(',').pop(), 'base64'));

      const promptlar = promptlariYukle(null, ayarlar);
      const job = await jobOlustur({
        imagePath: gecici,
        phone: govde.phone || null,
        prompts: promptlar,
        note: govde.note || null,
        kaynak: 'panel',
      });
      fs.rmSync(gecici, { force: true });
      job.sourceImage = govde.imageName || null;
      jobYaz(job);
      log.ok(`Job oluşturuldu: ${job.id} (${job.tasks.length} task)`);

      if (govde.runNow) jobuArkaPlandaCalistir(job, ayarlar);
      return json(res, 201, jobOzet(job));
    } catch (e) {
      return json(res, 400, { hata: String(e?.message || e) });
    }
  }

  if (parcalar[1] === 'jobs' && parcalar[2]) {
    const jobId = decodeURIComponent(parcalar[2]);
    let job;
    try {
      job = jobOku(jobId);
    } catch (e) {
      return json(res, 404, { hata: String(e?.message || e) });
    }
    const eylem = parcalar[3];

    if (!eylem && req.method === 'GET') return json(res, 200, jobOzet(job));

    if (!eylem && req.method === 'DELETE') {
      fs.rmSync(job.outputDir, { recursive: true, force: true });
      fs.rmSync(jobYolu(job.id), { force: true });
      log.warn(`Job silindi: ${job.id}`);
      return json(res, 200, { ok: true });
    }

    if (eylem === 'stop' && req.method === 'POST') {
      try {
        return json(res, 200, jobuDurdur(job.id));
      } catch (e) {
        return json(res, 409, { hata: String(e?.message || e) });
      }
    }

    if (eylem === 'run' && req.method === 'POST') {
      if (durum.kosanJoblar.has(job.id)) return json(res, 409, { hata: 'Bu iş zaten çalışıyor.' });
      jobuArkaPlandaCalistir(job, ayarlar);
      return json(res, 202, { ok: true });
    }

    if (eylem === 'retry' && req.method === 'POST') {
      const govde = await govdeOku(req);
      let sayac = 0;
      for (const t of job.tasks) {
        const secili = govde.taskId ? t.id === govde.taskId : govde.all ? true : t.status === 'failed';
        if (!secili) continue;
        t.status = 'pending';
        t.attempts = 0;
        t.error = null;
        sayac++;
      }
      job.status = durumuHesapla(job);
      jobYaz(job);
      manifestYaz(job);
      log.info(`${job.id}: ${sayac} task yeniden sıraya alındı`);
      if (govde.run !== false) jobuArkaPlandaCalistir(job, ayarlar);
      return json(res, 200, jobOzet(job));
    }

    // Baskı seçimi / basıldı işareti: { dosya, secili?, basildi? }
    if (eylem === 'secim' && req.method === 'POST') {
      const govde = await govdeOku(req);
      const gecerli = job.tasks.some((t) => (t.files || []).includes(govde.dosya));
      if (!gecerli) return json(res, 400, { hata: `Bu işe ait olmayan dosya: ${govde.dosya}` });

      job.baskiSecim = job.baskiSecim || {};
      const kayit = job.baskiSecim[govde.dosya] || { secili: false, adet: 1, basildi: false };
      const simdi = new Date().toISOString();

      if ('adet' in govde) {
        // Adet 0'a inince seçim tamamen kalkar; üst sınır kazara tıklamaya karşı.
        const yeni = Math.min(99, Math.max(0, Math.floor(Number(govde.adet) || 0)));
        kayit.adet = Math.max(1, yeni);
        kayit.secili = yeni > 0;
        if (!kayit.secili) {
          kayit.adet = 1;
          kayit.basildi = false;
          kayit.basiliAdet = 0;
          kayit.basildiAt = null;
          kayit.seciliAt = null;
        } else {
          // Adet azaltılırsa basılı sayacı adedin üstünde kalmasın.
          kayit.basiliAdet = Math.min(Number(kayit.basiliAdet) || 0, kayit.adet);
          kayit.basildi = kayit.basiliAdet >= kayit.adet;
          if (!kayit.seciliAt) kayit.seciliAt = simdi;
        }
      }

      if ('secili' in govde) {
        kayit.secili = Boolean(govde.secili);
        kayit.seciliAt = kayit.secili ? simdi : null;
        if (kayit.secili && !kayit.adet) kayit.adet = 1;
        // Seçimden çıkarılan dosyanın "basıldı" işareti anlamını yitirir.
        if (!kayit.secili) {
          kayit.adet = 1;
          kayit.basildi = false;
          kayit.basiliAdet = 0;
          kayit.basildiAt = null;
        }
      }
      if ('basildi' in govde) {
        // Bayrak ile sayaç birlikte hareket etmeli: "basıldı" tüm kopyaları,
        // "basılmadı" sıfırı gösterir. Yoksa baskı odası kuyruğu ile
        // Print sekmesi birbirini tutmaz.
        kayit.basildi = Boolean(govde.basildi);
        kayit.basiliAdet = kayit.basildi ? Math.max(1, Number(kayit.adet) || 1) : 0;
        kayit.basildiAt = kayit.basildi ? simdi : null;
      }
      job.baskiSecim[govde.dosya] = kayit;
      jobYaz(job);
      manifestYaz(job);
      return json(res, 200, jobOzet(job));
    }

    if (eylem === 'reveal' && req.method === 'POST') {
      dosyayiGoster(job.outputDir);
      return json(res, 200, { ok: true });
    }

    // /file/<ad>                → job kökü (input fotoğrafı, manifest)
    // /file/<varyant>/<ad>      → uretim | demo | baski klasörü
    // ?b=k|o                    → küçük/orta önizleme (jpeg, disk cache)
    if (eylem === 'file' && parcalar[4] && req.method === 'GET') {
      try {
        const bolumler = parcalar.slice(4).map((p) => decodeURIComponent(p));
        const boy = url.searchParams.get('b');
        if (boy && bolumler.length === 2) {
          // Önizleme üretilemezse (bozuk dosya) ham hali servis edilir —
          // panelde boş kare göstermektense büyük dosya yeğdir.
          try {
            return dosyaServisEt(res, await onizlemeYolu(job, bolumler[0], bolumler[1], boy));
          } catch (e) {
            log.warn(`Önizleme üretilemedi (${job.id}/${bolumler.join('/')}): ${e.message}`);
          }
        }
        // 'kok' sanal bir varyant (job klasörünün kendisi) — ham yola çevrilir.
        const hamYol = bolumler[0] === 'kok' ? bolumler.slice(1) : bolumler;
        return dosyaServisEt(res, guvenliCiktiYolu(job, ...hamYol));
      } catch (e) {
        return json(res, 400, { hata: String(e?.message || e) });
      }
    }
  }

  return json(res, 404, { hata: `Bilinmeyen uç: ${yol}` });
}

export function paneliBaslat({ port = 4173, ayarlarDosyasi, ac = false, telegram = true } = {}) {
  const ayarlar = ayarlariYukle(ayarlarDosyasi);
  const erisim = erisimAyarlariniYukle();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Telegram botu panelle aynı süreçte koşar: aynı kuyruk, aynı runner, aynı
  // canlı akış. Bottan gelen iş de panelden gelen iş gibi "Durdur" edilebilir.
  const tgAyar = telegramAyarlariniYukle();
  if (telegram && tgAyar.enabled && tgAyar.token) {
    durum.telegram = botuBaslat({
      ayarlar,
      telegram: tgAyar,
      calistir: (job) => jobuArkaPlandaCalistir(job, ayarlar),
      bildir: (d) => yayinla('telegram', d),
    });
  } else if (telegram && tgAyar.enabled && !tgAyar.token) {
    log.warn('Telegram botu kapalı: config/telegram.json içinde token yok.');
  }

  const sunucu = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (!girebilirMi(req, url, erisim)) {
        // Anahtarsız uzak istek: sayfa isteyen kapıyı görür, API 401 alır.
        if (url.pathname.startsWith('/api/')) return json(res, 401, { hata: 'Anahtar gerekli.' });
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(KAPI_SAYFASI);
      }
      // Anahtar adresten geldiyse çereze taşı; bağlantı bir kez kullanılsın yeter.
      if (url.searchParams.get('anahtar')) cerezKur(res, url.searchParams.get('anahtar'));

      if (url.pathname.startsWith('/api/')) return await apiIstek(req, res, url, ayarlar, erisim);
      const istenen = url.pathname === '/' ? '/index.html' : url.pathname;
      const dosya = path.join(PUBLIC_DIR, path.normalize(istenen).replace(/^(\.\.[/\\])+/, ''));
      if (!dosya.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        return res.end();
      }
      return dosyaServisEt(res, dosya);
    } catch (e) {
      log.err(`Sunucu hatası: ${e?.message || e}`);
      if (!res.headersSent) json(res, 500, { hata: String(e?.message || e) });
      else res.end();
    }
  });

  sunucu.listen(port, '127.0.0.1', () => {
    const adres = `http://127.0.0.1:${port}`;
    log.ok(`Panel açık: ${adres}`);
    log.info(`Paylaşım bağlantısı: <dış-adres>/?anahtar=${erisim.erisimToken}`);
    log.info('Kapatmak için Ctrl+C.');
    if (ac) tarayicidaAc(adres);
  });

  const kapat = async () => {
    if (durum.telegram) durum.telegram.durdur();
    for (const [ad, kayit] of durum.loginContextleri) {
      log.info(`[${ad}] giriş penceresi kapatılıyor`);
      await kayit.ctx.close().catch(() => {});
    }
    for (const [ad, kayit] of durum.girisSurecleri) {
      log.info(`[${ad}] giriş süreci sonlandırılıyor`);
      kayit.surec.kill('SIGTERM');
    }
    sunucu.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGINT', kapat);
  process.on('SIGTERM', kapat);

  return sunucu;
}
