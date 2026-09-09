import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, OUTPUT_DIR } from './paths.js';
import { ayarlariYukle, promptlariYukle, promptlariKaydet, promptDosyaYolu, hesapEkle, hesapSil, hesapAyarla, falAnahtarKaydet, falModKaydet } from './config.js';
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
import { jobuCalistir, taskiFalIleCalistir } from './runner.js';
import { varyantSayilari, taskVaryantDurumu, onizlemeYolu } from './varyant.js';
import { odaOzeti, sayfaBul, sayfayiBas, basimiGeriAl, etdxUret } from './sayfa.js';
import { contextAc, sayfaAl } from './browser.js';
import { adaptorAl } from './adapters/index.js';
import * as falAdaptoru from './adapters/fal.js';
import * as codexAdaptoru from './adapters/chatgpt-codex.js';
import { botuBaslat, telegramAyarlariniYukle } from './telegram.js';
import { erisimAyarlariniYukle, girebilirMi, cerezKur, KAPI_SAYFASI } from './erisim.js';
import { disErisimDurumu } from './tunel.js';
import { guncellemeAyarlari, guncellemeVarMi, guncelle, yerelSurum } from './guncelleme.js';
import { lisansTazele, durum as abonelikDurumu, aktifMi as abonelikAktifMi } from './abonelik.js';
import { havuzOzeti, uygunHesapVar, dinlenmeyiKaldir } from './havuz.js';
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
  loginContextleri: new Map(), // "plt::hesap" → { ctx, baslangic }  (tarayıcılı giriş)
  girisSurecleri: new Map(), // "plt::hesap" → { surec, satirlar, url } (süreçli giriş)
  durdurucular: new Map(), // jobId → AbortController
  dogrulama: new Map(), // "plt::hesap" → { hazir, kontrol, mesaj }
  telegram: null, // { durum(), durdur() } — bot açıksa
};

/** Oturum haritalarında hesabı ayırt eden anahtar. */
function hesapAnahtar(platformAdi, hesapAd) {
  return `${platformAdi}::${hesapAd || 'varsayılan'}`;
}

/** Platformun hesabını ad ile bulur; ad yoksa/tek hesapsa ilkini verir. */
function hesapBul(platform, hesapAd) {
  const liste = platform.hesaplar || [];
  if (!hesapAd) return liste[0];
  return liste.find((h) => h.ad === hesapAd) || null;
}

// Girdisi silinmiş eski işlerin önizleme uyarısı her tazelemede tekrar
// basılmasın — yol başına bir kez logla.
const onizlemeUyarilari = new Set();

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
      hesap: t.hesap || null,
      limitBekliyor: Boolean(t.limitBekliyor),
      limitAcilis: t.limitAcilis || null,
      varyantVar: taskVaryantDurumu(job, t),
      baski: (t.files || []).map((d) => baskiKaydi(job, d)),
    })),
    baskiOzet: baskiOzetiCikar(job),
  };
}

/** YYYY-MM-DD (sunucu yerel günü) — panelin tarih süzgeciyle aynı eksen. */
function gunAnahtari(d) {
  const t = new Date(d);
  const p = (x) => String(x).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

/**
 * Kuyruk sayfası: süzgeçler + sayfalama SUNUCUDA koşar. Panel açılışta tüm
 * kuyruğu (aylar boyu iş × task detayı) çekiyordu — tünel üzerinden ciddi
 * bant genişliği ve açılış süresi. Artık sayfa sayfa: süzgeçler ham job
 * alanlarında uygulanır, maliyetli jobOzet yalnız dönen dilime çalışır
 * (tek istisna: baskı durumu süzgeci özet ister, o da ucuz baskiOzetiCikar
 * ile ham job üzerinden hesaplanır).
 */
function jobSayfasi(sorgu = {}) {
  const limit = Math.max(0, Math.min(500, Number(sorgu.limit ?? 25) || 0));
  const offset = Math.max(0, Number(sorgu.offset) || 0);
  let liste = jobListele().reverse(); // yeniden eskiye

  if (sorgu.kaynak && sorgu.kaynak !== 'tumu') {
    liste = liste.filter((j) => kaynakNormalize(j.kaynak) === sorgu.kaynak);
  }

  const tarihTipi = sorgu.tarih || 'tumu';
  if (tarihTipi !== 'tumu') {
    const bugun = new Date();
    const dun = new Date(bugun);
    dun.setDate(dun.getDate() - 1);
    liste = liste.filter((j) => {
      const gun = gunAnahtari(j.createdAt);
      if (tarihTipi === 'bugun') return gun === gunAnahtari(bugun);
      if (tarihTipi === 'dun') return gun === gunAnahtari(dun);
      // aralık: uçlar dahil, biri boşsa o yön sınırsız
      if (sorgu.bas && gun < sorgu.bas) return false;
      if (sorgu.bit && gun > sorgu.bit) return false;
      return true;
    });
  }

  if (sorgu.q) {
    const parcalar = String(sorgu.q).toLocaleLowerCase('tr').split(/\s+/).filter(Boolean);
    liste = liste.filter((j) => {
      const havuz = [
        j.id, j.phone, j.fakeId, j.note, kaynakNormalize(j.kaynak),
        j.kaynakBilgi?.kullanici,
        ...(j.tasks || []).map((t) => `${t.promptId} ${t.prompt}`),
      ].filter(Boolean).join(' ').toLocaleLowerCase('tr');
      return parcalar.every((p) => havuz.includes(p));
    });
  }

  if (sorgu.is && sorgu.is !== 'tumu') {
    liste = liste.filter((j) => {
      const oz = baskiOzetiCikar(j) || { secili: 0, kopya: 0, basiliKopya: 0 };
      const uretimBitti = (j.tasks || []).every((t) => t.status === 'done');
      if (sorgu.is === 'uretimde') return !uretimBitti;
      if (sorgu.is === 'basiliyor') return oz.secili > 0 && oz.basiliKopya < oz.kopya;
      if (sorgu.is === 'basildi') return oz.kopya > 0 && oz.basiliKopya >= oz.kopya;
      return true;
    });
  }

  const toplam = liste.length; // süzgeç sonrası toplam (sayaç için)
  // Cursor: canlı kuyrukta offset kayar (yeni iş düşünce sayfa atlar) —
  // "şu tarihten eskiler" istenirse dilim oradan başlar.
  if (sorgu.oncesi) {
    liste = liste.filter((j) => String(j.createdAt) < String(sorgu.oncesi));
  }
  const joblar = liste.slice(offset, offset + limit).map(jobOzet);
  return { joblar, toplam, dahaVar: offset + joblar.length < liste.length };
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

/** Bir hesabın oturum durumu (giriş yapılmış mı, giriş süreci akıyor mu). */
function oturumDurumu(platform, hesap) {
  const adaptor = adaptorAl(platform.adapter || platform.ad);
  const anahtar = hesapAnahtar(platform.ad, hesap?.ad);
  const surecKaydi = durum.girisSurecleri.get(anahtar);
  const webHesabi = hesap?.motor === 'web';
  const ortak = {
    hesap: hesap?.ad || 'varsayılan',
    motor: hesap?.motor || null,
    // Web motorlu hesap Codex değil tarayıcı penceresiyle giriş yapar.
    girisTipi: webHesabi ? 'tarayici' : adaptor.girisTipi || 'tarayici',
    dogrulama: durum.dogrulama.get(anahtar) || null,
    girisSuruyor: Boolean(surecKaydi),
    girisUrl: surecKaydi?.url || null,
    girisCikti: surecKaydi ? surecKaydi.satirlar.slice(-8).join('') : null,
    ipucu: webHesabi ? null : adaptor.girisKomutu?.(platform, hesap)?.ipucu || null,
  };

  // Sürücü kendi giriş durumunu biliyorsa (Codex) onu kullan.
  if (!webHesabi && typeof adaptor.girisDurumu === 'function') {
    return {
      ...ortak,
      ...adaptor.girisDurumu(platform, hesap),
      // Kalan Codex hakkı (wham/usage, periyodik tazelenen cache'ten).
      limit: adaptor.limitOku ? adaptor.limitOku(hesap) : null,
      pencereAcik: false,
    };
  }

  const profil = hesap?.profileDir || platform.profileDir;
  const damga = profil ? path.join(profil, '.voku-login.json') : null;
  const varMi = profil && (fs.existsSync(path.join(profil, 'Default')) || fs.existsSync(damga));
  let sonGiris = null;
  if (damga && fs.existsSync(damga)) {
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
    pencereAcik: durum.loginContextleri.has(anahtar),
  };
}

// platformDurumu/falOzeti panel dışında da (SSE callback'leri) çağrılıyor;
// çalışan ayar nesnesine modül düzeyinde erişim gerekiyor.
let sunucuAyarlar = null;

/** Header rozeti için fal özeti: anahtar + bakiye. */
function falOzeti() {
  const b = falAdaptoru.sonBakiye();
  return {
    anahtarVar: Boolean(sunucuAyarlar?.fal?.apiKey),
    bakiye: b.deger,
    bakiyeZamani: b.zaman,
    bakiyeHatasi: b.hata,
    dusuk: b.deger !== null && b.deger < 5,
  };
}

/** Bir platformun tüm hesaplarının oturum + havuz durumunu birleştirir. */
function platformDurumu(platform) {
  const adaptor = adaptorAl(platform.adapter || platform.ad);
  const havuz = havuzOzeti(platform.ad, platform.hesaplar || []);
  const oturumlar = (platform.hesaplar || []).map((h) => {
    const o = oturumDurumu(platform, h);
    const hv = havuz.find((x) => x.ad === h.ad) || {};
    return { ...o, ...hv };
  });

  // fal oturumu: mod + (havuza katılıyorsa) sanal hesabın anlık durumu.
  const falSanal = sunucuAyarlar ? falAdaptoru.sanalHesap(sunucuAyarlar, platform) : null;
  const falDurum = falSanal ? havuzOzeti(platform.ad, [falSanal])[0] : null;
  // Uyarı: web hesaplarının hiçbiri şu an kullanılamıyor (pasif/limitte) ve
  // fal devrede — bu platformdaki her üretim ücretli fal API'sine gider.
  const webUygun = havuz.some((h) => h.aktif && !h.dinlenmede);
  const fal = {
    mod: platform.falMod || 'yedek',
    model: platform.falModel || null,
    anahtarVar: Boolean(sunucuAyarlar?.fal?.apiKey),
    durum: falDurum,
    uyari: Boolean(falSanal) && !webUygun,
  };

  return {
    // Bar lambası tek-oturum alanlarını (pencereAcik/dogrulama/profilVar)
    // ilk hesaptan okur — önce yayılır, sonra platform alanları ezer.
    ...oturumlar[0],
    ad: platform.ad,
    url: platform.url,
    enabled: platform.enabled !== false,
    adapter: platform.adapter || platform.ad,
    girisTipi: adaptor.girisTipi || 'tarayici',
    cokluHesap: (platform.hesaplar || []).length > 1,
    oturumlar,
    hesaplar: havuz,
    fal,
  };
}

function durumPaketi(ayarlar, islerLimit = 25) {
  // isler=0: yalnız platform/rozet durumu istenir (sessiz tazeleme) —
  // kuyruk /api/jobs'tan sayfa sayfa gelir, tam döküm artık yok.
  const sayfa = jobSayfasi({ limit: islerLimit });
  return {
    platformlar: Object.values(ayarlar.platforms).map(platformDurumu),
    joblar: sayfa.joblar,
    jobToplam: sayfa.toplam,
    telegram: durum.telegram ? durum.telegram.durum() : { acik: false, hata: 'Bot bu panelde açık değil.' },
    fal: falOzeti(),
    abonelik: abonelikDurumu(),
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
  // Merkezi kilit: uçlardaki kontrollere ek olarak limit bekçisi ve bot
  // yolu da buradan geçer — süre dolmuşken hiçbir yol üretim başlatamaz.
  if (!abonelikAktifMi()) {
    log.warn(`${job.id} başlatılmadı — bakım desteği süresi dolmuş.`);
    return;
  }
  if (durum.kosanJoblar.has(job.id)) return;
  // Çağıranın elindeki kopya bayat olabilir (iş bu arada elle koşulup
  // bitmiş olabilir) — diskten taze oku, bitmiş task'lar yeniden üretilmesin.
  try {
    job = jobOku(job.id);
  } catch {
    /* diskte yoksa eldeki kopyayla devam */
  }
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
async function surecliGirisBaslat(platformAdi, platform, adaptor, ayarlar, hesap) {
  const anahtar = hesapAnahtar(platformAdi, hesap?.ad);
  const etiket = `${platformAdi}/${hesap?.ad || 'varsayılan'}`;
  if (durum.girisSurecleri.has(anahtar)) return { zatenAcik: true };

  const { komut, argumanlar, env } = adaptor.girisKomutu(platform, hesap);
  // Codex, CODEX_HOME dizini önceden yoksa "path does not exist" ile ölüyor.
  if (env?.CODEX_HOME) fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  const surec = spawn(komut, argumanlar, {
    env: { ...process.env, ...(env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const kayit = { surec, satirlar: [], url: null };
  durum.girisSurecleri.set(anahtar, kayit);
  log.info(`[${etiket}] giriş başlatıldı: ${komut} ${argumanlar.join(' ')}`);

  const yay = (veri) =>
    yayinla('giris', { platform: platformAdi, hesap: hesap?.ad || 'varsayılan', ...veri });

  // Program yoksa ChildProcess 'error' fırlatır; yakalanmazsa Node bunu
  // işlenmemiş olay sayıp TÜM paneli düşürür. Panel ayakta kalmalı.
  surec.on('error', (e) => {
    durum.girisSurecleri.delete(anahtar);
    const mesaj =
      e.code === 'ENOENT'
        ? `"${komut}" bulunamadı. Codex CLI kurulu değil ya da PATH'te değil — kurmak için: npm install -g @openai/codex (kurduktan sonra paneli yeniden başlat).`
        : e.message;
    log.err(`[${etiket}] giriş başlatılamadı: ${mesaj}`);
    yay({ metin: `${mesaj}\n` });
    yay({ bitti: true, kod: -1 });
    durum.dogrulama.set(anahtar, { hazir: false, kontrol: new Date().toISOString(), mesaj });
    yayinla('platform', platformDurumu(platform));
  });

  const isle = (veri) => {
    const metin = String(veri);
    kayit.satirlar.push(metin);
    if (kayit.satirlar.length > 40) kayit.satirlar.shift();
    if (!kayit.url) {
      const bulunan = metin.match(/https?:\/\/\S+/);
      if (bulunan) kayit.url = bulunan[0].replace(/[.,)\]]+$/, '');
    }
    yay({ metin, url: kayit.url });
    const temiz = metin.trim();
    if (temiz) log.info(`[${etiket}] ${temiz.slice(0, 200)}`);
  };
  surec.stdout.on('data', isle);
  surec.stderr.on('data', isle);

  surec.on('close', async (kod) => {
    durum.girisSurecleri.delete(anahtar);
    if (kod === 0) log.ok(`[${etiket}] giriş tamamlandı`);
    else log.warn(`[${etiket}] giriş süreci kapandı (kod ${kod})`);
    yay({ bitti: true, kod });
    await oturumDogrula(platformAdi, ayarlar, hesap).catch(() => {});
    yayinla('platform', platformDurumu(platform));
  });

  return { zatenAcik: false, surecli: true };
}

async function loginBaslat(platformAdi, ayarlar, hesapAd) {
  const platform = ayarlar.platforms[platformAdi];
  if (!platform) throw new Error(`Bilinmeyen platform: ${platformAdi}`);
  const hesap = hesapBul(platform, hesapAd);
  if (!hesap) throw new Error(`"${platformAdi}" için "${hesapAd}" hesabı yok.`);
  const anahtar = hesapAnahtar(platformAdi, hesap.ad);
  const adaptor = adaptorAl(platform.adapter || platformAdi);

  if (adaptor.girisTipi === 'surec' && hesap.motor !== 'web') {
    return surecliGirisBaslat(platformAdi, platform, adaptor, ayarlar, hesap);
  }
  if (durum.loginContextleri.has(anahtar)) return { zatenAcik: true };

  // Her hesap kendi tarayıcı profilinde açılır (farklı Google oturumu).
  const profil = hesap.profileDir || platform.profileDir;
  const ctx = await contextAc({ ...platform, profileDir: profil }, ayarlar, { headless: false });
  const page = await sayfaAl(ctx);
  await page.goto(platform.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  durum.loginContextleri.set(anahtar, { ctx, baslangic: Date.now(), hesap });
  log.info(`[${platformAdi}/${hesap.ad}] giriş penceresi açıldı`);
  return { zatenAcik: false };
}

/** Süren giriş sürecini iptal eder ("Vazgeç"). */
function surecliGirisIptal(platformAdi, hesapAd) {
  const anahtar = hesapAnahtar(platformAdi, hesapAd);
  const kayit = durum.girisSurecleri.get(anahtar);
  if (!kayit) throw new Error('Süren giriş yok.');
  kayit.surec.kill('SIGTERM');
  durum.girisSurecleri.delete(anahtar);
  log.warn(`[${platformAdi}/${hesapAd || 'varsayılan'}] giriş iptal edildi`);
  return { ok: true };
}

async function loginBitir(platformAdi, ayarlar, hesapAd) {
  const anahtar = hesapAnahtar(platformAdi, hesapAd);
  if (durum.girisSurecleri.has(anahtar)) {
    return surecliGirisIptal(platformAdi, hesapAd);
  }
  const kayit = durum.loginContextleri.get(anahtar);
  if (!kayit) throw new Error('Açık giriş penceresi yok.');
  const platform = ayarlar.platforms[platformAdi];
  const hesap = kayit.hesap || hesapBul(platform, hesapAd);
  const adaptor = adaptorAl(platform.adapter || platformAdi);

  // Sürücü çerez istiyorsa (HTTP köprüsü) pencere kapanmadan önce al.
  if (typeof adaptor.cerezleriSenkronla === 'function') {
    try {
      // __Secure-1PSIDTS kısa ömürlü ve Google onu giriş anından birkaç saniye
      // sonra set eder — "Girişi tamamladım"a basıldığında henüz olmayabilir.
      // Gemini'yi bir kez taze yükleyip bekleyerek çerezin oluşmasını sağla.
      const sayfa = kayit.ctx.pages()[0];
      if (sayfa) {
        try {
          await sayfa.goto(platform.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
          await sayfa.waitForTimeout(3500);
        } catch {
          /* yükleme takılsa da eldeki çerezle devam et */
        }
      }
      // Argümansız: tüm domainlerdeki çerezler (HttpOnly dahil) — PSIDTS
      // hangi kayıtta olursa olsun yakalanır.
      const cerezler = await kayit.ctx.cookies();
      await adaptor.cerezleriSenkronla(cerezler, platform, hesap);
    } catch (e) {
      log.warn(`[${platformAdi}/${hesap?.ad}] çerez senkronu başarısız: ${e.message}`);
    }
  }

  await kayit.ctx.close().catch(() => {});
  durum.loginContextleri.delete(anahtar);
  const profil = hesap?.profileDir || platform.profileDir;
  fs.mkdirSync(profil, { recursive: true });
  fs.writeFileSync(
    path.join(profil, '.voku-login.json'),
    JSON.stringify({ sonGiris: new Date().toISOString() }, null, 2)
  );
  log.ok(`[${platformAdi}/${hesap?.ad || 'varsayılan'}] oturum kaydedildi`);
}

/** Bir hesabın oturumunu sınar (adapter arayüzü/hazırlığı tanıyor mu). */
async function oturumDogrula(platformAdi, ayarlar, hesap) {
  const platform = ayarlar.platforms[platformAdi];
  if (!platform) throw new Error(`Bilinmeyen platform: ${platformAdi}`);
  const anahtar = hesapAnahtar(platformAdi, hesap?.ad);
  if (durum.loginContextleri.has(anahtar)) {
    throw new Error('Giriş penceresi açıkken doğrulama yapılamaz. Önce girişi tamamla.');
  }
  const adaptor = adaptorAl(platform.adapter || platformAdi);
  const sel = ayarlar.selectors[platformAdi] || {};
  let ctx;
  try {
    if (adaptor.tarayiciGerekli === false) {
      // Tarayıcısız sürücü (Codex/köprü): tarayıcı açmadan hesap hazırlığı.
      await adaptor.hazirla(null, platform, sel, ayarlar, hesap);
      // Sına geçtiyse havuzdaki limit cezası da kalkar: limit tespiti sezgisel,
      // yanlış pozitifte kullanıcı tek tıkla hesabı geri açabilsin. Hesap
      // gerçekten limitliyse ilk üretim cezayı yeniden koyar.
      if (dinlenmeyiKaldir(platformAdi, hesap?.ad || 'varsayılan')) {
        log.ok(`[${platformAdi}/${hesap?.ad || 'varsayılan'}] sınama geçti — limit beklemesi kaldırıldı`);
      }
      const sonuc = {
        hazir: true,
        kontrol: new Date().toISOString(),
        mesaj: `${adaptor.ad} — ${hesap?.ad || 'varsayılan'} hazır.`,
      };
      durum.dogrulama.set(anahtar, sonuc);
      return sonuc;
    }
    const profil = hesap?.profileDir || platform.profileDir;
    ctx = await contextAc({ ...platform, profileDir: profil }, ayarlar, { headless: ayarlar.headless });
    const page = await sayfaAl(ctx);
    await adaptor.hazirla(page, platform, sel, ayarlar, hesap);
    if (dinlenmeyiKaldir(platformAdi, hesap?.ad || 'varsayılan')) {
      log.ok(`[${platformAdi}/${hesap?.ad || 'varsayılan'}] sınama geçti — limit beklemesi kaldırıldı`);
    }
    const sonuc = { hazir: true, kontrol: new Date().toISOString(), mesaj: 'Oturum açık, arayüz tanındı.' };
    durum.dogrulama.set(anahtar, sonuc);
    return sonuc;
  } catch (e) {
    const sonuc = { hazir: false, kontrol: new Date().toISOString(), mesaj: String(e?.message || e) };
    durum.dogrulama.set(anahtar, sonuc);
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
    const islerParam = url.searchParams.get('isler');
    const paket = durumPaketi(ayarlar, islerParam === null ? 25 : Number(islerParam));
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

  // --- debug: uzaktan teşhis uçları ---
  // Maliyet telemetrisi: her Codex turunun karnesi (token, imagegen sayısı,
  // üretilen görsel, süre, turdan sonraki limit yüzdeleri). Kayıt kaynağı:
  // adapters/chatgpt-codex.js > telemetriKaydet → logs/codex-maliyet.jsonl.
  if (yol === '/api/debug/maliyet' && req.method === 'GET') {
    const n = Math.min(2000, Number(url.searchParams.get('n')) || 200);
    let kayitlar = [];
    try {
      kayitlar = fs.readFileSync(path.join(ROOT, 'logs', 'codex-maliyet.jsonl'), 'utf8')
        .trim().split('\n').slice(-n)
        .map((s) => { try { return JSON.parse(s); } catch { return null; } })
        .filter(Boolean);
    } catch { /* henüz kayıt yok */ }
    const ozet = {};
    for (const k of kayitlar) {
      const o = (ozet[k.islem] ||= {
        adet: 0, hatali: 0, tokenIn: 0, tokenOut: 0, imagegen: 0, gorseller: 0, komutlar: 0, sureSn: 0,
      });
      o.adet += 1;
      if (k.hata) o.hatali += 1;
      o.tokenIn += k.tokens?.in || 0;
      o.tokenOut += k.tokens?.out || 0;
      o.imagegen += k.imagegen || 0;
      o.gorseller += k.gorseller || 0;
      o.komutlar += k.komutlar || 0;
      o.sureSn += k.sureSn || 0;
    }
    const son = kayitlar[kayitlar.length - 1] || null;
    return json(res, 200, {
      aciklama: 'Turdan sonraki saatlik/haftalik alanları wham/usage yüzdeleridir; ardışık kayıtların farkı aradaki harcamadır. imagegen = agent kaç kez görsel ürettirdi (asıl kota bunu sayar).',
      toplamKayit: kayitlar.length,
      son: son && { t: son.t, saatlik: son.saatlik, haftalik: son.haftalik },
      ozet,
      kayitlar,
    });
  }

  // Ham panel logu (logs/voku.log) — son n satır, düz metin. Canlı akış için
  // /api/events (SSE) zaten log yayınlar.
  if (yol === '/api/debug/log' && req.method === 'GET') {
    const n = Math.min(5000, Number(url.searchParams.get('n')) || 500);
    let metin = '(log dosyası yok)';
    try {
      const dosya = path.join(ROOT, 'logs', 'voku.log');
      const st = fs.statSync(dosya);
      const boyut = Math.min(st.size, 4 * 1024 * 1024); // dev dosyada sondan oku
      const fd = fs.openSync(dosya, 'r');
      const tampon = Buffer.alloc(boyut);
      fs.readSync(fd, tampon, 0, boyut, st.size - boyut);
      fs.closeSync(fd);
      metin = tampon.toString('utf8').trim().split('\n').slice(-n).join('\n');
    } catch { /* dosya yoksa mesaj kalır */ }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(metin);
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
    // Hesap adı query'de (?hesap=onur); yoksa ilk hesap.
    const hesapAd = url.searchParams.get('hesap') || undefined;
    if (req.method !== 'POST') return json(res, 405, { hata: 'POST bekleniyor' });
    try {
      if (eylem === 'start') return json(res, 200, await loginBaslat(platformAdi, ayarlar, hesapAd));
      if (eylem === 'finish') {
        await loginBitir(platformAdi, ayarlar, hesapAd);
        return json(res, 200, { ok: true, platform: platformDurumu(ayarlar.platforms[platformAdi]) });
      }
      if (eylem === 'cancel') return json(res, 200, surecliGirisIptal(platformAdi, hesapAd));
      if (eylem === 'verify') {
        const hesap = hesapBul(ayarlar.platforms[platformAdi], hesapAd);
        const sonuc = await oturumDogrula(platformAdi, ayarlar, hesap);
        return json(res, 200, sonuc);
      }
      return json(res, 404, { hata: 'Bilinmeyen eylem' });
    } catch (e) {
      return json(res, 400, { hata: String(e?.message || e) });
    }
  }

  // --- hesap havuzu yönetimi ---
  if (parcalar[1] === 'hesap' && parcalar[2]) {
    const platformAdi = parcalar[2];
    try {
      if (req.method === 'POST') {
        const govde = await govdeOku(req);
        const yeni = hesapEkle(ayarlar, platformAdi, govde.ad, govde.motor);
        log.ok(`[${platformAdi}] hesap eklendi: ${yeni.ad}${yeni.motor === 'web' ? ' (web motoru)' : ''}`);
        return json(res, 201, { ok: true, platform: platformDurumu(ayarlar.platforms[platformAdi]) });
      }
      if (req.method === 'DELETE' && parcalar[3]) {
        const hesapAd = decodeURIComponent(parcalar[3]);
        hesapSil(ayarlar, platformAdi, hesapAd);
        log.warn(`[${platformAdi}] hesap silindi: ${hesapAd}`);
        return json(res, 200, { ok: true, platform: platformDurumu(ayarlar.platforms[platformAdi]) });
      }
      // Hesap ayarı: { concurrency?, aktif? }.
      if (req.method === 'PATCH' && parcalar[3]) {
        const hesapAd = decodeURIComponent(parcalar[3]);
        const govde = await govdeOku(req);
        const guncel = hesapAyarla(ayarlar, platformAdi, hesapAd, {
          concurrency: govde.concurrency,
          aktif: govde.aktif,
        });
        log.ok(`[${platformAdi}/${hesapAd}] güncellendi — eşzamanlı: ${guncel.concurrency ?? '-'}, ${guncel.aktif === false ? 'pasif' : 'aktif'}`);
        return json(res, 200, { ok: true, platform: platformDurumu(ayarlar.platforms[platformAdi]) });
      }
    } catch (e) {
      return json(res, 400, { hata: String(e?.message || e) });
    }
    return json(res, 404, { hata: 'Bilinmeyen hesap eylemi' });
  }

  // --- abonelik ---
  if (yol === '/api/abonelik/yenile' && req.method === 'POST') {
    const d = await lisansTazele();
    yayinla('abonelik', d);
    return json(res, 200, d);
  }

  // --- fal.ai yedek üretim ---
  if (parcalar[1] === 'fal') {
    try {
      // Anahtar kaydet + bakiye ile doğrula.
      if (parcalar[2] === 'anahtar' && req.method === 'POST') {
        const govde = await govdeOku(req);
        falAnahtarKaydet(ayarlar, govde.apiKey);
        const b = await falAdaptoru.bakiyeTazele(ayarlar, true);
        if (b.deger === null) {
          return json(res, 400, { hata: `Anahtar kaydedildi ama doğrulanamadı: ${b.hata || 'bakiye okunamadı'}` });
        }
        log.ok(`fal anahtarı kaydedildi — bakiye $${b.deger.toFixed(2)}`);
        yayinla('fal', falOzeti());
        return json(res, 200, { ok: true, fal: falOzeti() });
      }
      // Platform fal modu: aktif | yedek | pasif.
      if (parcalar[2] && req.method === 'PATCH') {
        const platformAdi = decodeURIComponent(parcalar[2]);
        const govde = await govdeOku(req);
        falModKaydet(ayarlar, platformAdi, govde.mod);
        log.ok(`[${platformAdi}] fal modu: ${govde.mod}`);
        return json(res, 200, { ok: true, platform: platformDurumu(ayarlar.platforms[platformAdi]), fal: falOzeti() });
      }
    } catch (e) {
      return json(res, 400, { hata: String(e?.message || e) });
    }
    return json(res, 404, { hata: 'Bilinmeyen fal eylemi' });
  }

  // --- joblar ---
  // Kuyruk sayfası: süzgeçler + offset/limit sunucuda (bkz. jobSayfasi).
  if (yol === '/api/jobs' && req.method === 'GET') {
    const s = url.searchParams;
    return json(res, 200, jobSayfasi({
      offset: s.get('offset'),
      limit: s.get('limit'),
      oncesi: s.get('oncesi') || '',
      q: s.get('q') || '',
      tarih: s.get('tarih') || 'tumu',
      bas: s.get('bas') || '',
      bit: s.get('bit') || '',
      is: s.get('is') || 'tumu',
      kaynak: s.get('kaynak') || 'tumu',
    }));
  }

  if (yol === '/api/jobs' && req.method === 'POST') {
    if (!abonelikAktifMi()) return json(res, 402, { hata: 'Bakım desteği süresi doldu — yeni iş açılamıyor. Ayrıntı: header\'daki gün sayacı.' });
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
        yatayEsigi: ayarlar.girdiYatayOrani,
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
      if (!abonelikAktifMi()) return json(res, 402, { hata: 'Bakım desteği süresi doldu — üretim başlatılamıyor.' });
      if (durum.kosanJoblar.has(job.id)) return json(res, 409, { hata: 'Bu iş zaten çalışıyor.' });
      jobuArkaPlandaCalistir(job, ayarlar);
      return json(res, 202, { ok: true });
    }

    if (eylem === 'retry' && req.method === 'POST') {
      if (!abonelikAktifMi()) return json(res, 402, { hata: 'Bakım desteği süresi doldu — üretim başlatılamıyor.' });
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

    // Tek task'ı fal API ile üret ("fal ile dene" butonu).
    if (eylem === 'fal' && req.method === 'POST') {
      if (!abonelikAktifMi()) return json(res, 402, { hata: 'Bakım desteği süresi doldu — üretim başlatılamıyor.' });
      const govde = await govdeOku(req);
      if (!ayarlar.fal?.apiKey) return json(res, 400, { hata: 'fal API anahtarı tanımlı değil.' });
      if (durum.kosanJoblar.has(job.id)) return json(res, 409, { hata: 'Bu iş zaten çalışıyor — bitince dene.' });
      durum.kosanJoblar.add(job.id);
      yayinla('kosu', { id: job.id, kosuyor: true });
      taskiFalIleCalistir(job, govde.taskId, ayarlar)
        .catch((e) => log.err(`${job.id}/${govde.taskId} fal üretimi: ${e.message}`))
        .finally(() => {
          durum.kosanJoblar.delete(job.id);
          yayinla('kosu', { id: job.id, kosuyor: false });
          yayinla('job', jobOzet(jobOku(job.id)));
          yayinla('fal', falOzeti());
        });
      return json(res, 202, { ok: true });
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
            const anahtar = `${job.id}/${bolumler.join('/')}`;
            if (!onizlemeUyarilari.has(anahtar)) {
              onizlemeUyarilari.add(anahtar);
              log.warn(`Önizleme üretilemedi (${anahtar}): ${e.message} — bu dosya için tekrar uyarılmayacak`);
            }
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
  sunucuAyarlar = ayarlar;
  const erisim = erisimAyarlariniYukle();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // fal bakiyesi: açılışta bir kez, sonra 5 dk'da bir (anahtar varsa).
  // Değişiklik SSE ile yayınlanır — header rozeti elle yenileme istemez.
  const falSayaci = setInterval(() => {
    if (!ayarlar.fal?.apiKey) return;
    falAdaptoru.bakiyeTazele(ayarlar).then(() => yayinla('fal', falOzeti())).catch(() => {});
  }, 5 * 60 * 1000);
  falSayaci.unref?.();

  // Codex kalan hak rozeti: 3 dk'da bir tüm Codex hesapları için tazele.
  const limitSayaci = setInterval(() => {
    for (const plt of Object.values(ayarlar.platforms)) {
      if (plt.adapter !== 'chatgpt-codex') continue;
      Promise.all((plt.hesaplar || []).map((h) => codexAdaptoru.limitTazele(h)))
        .then(() => yayinla('platform', platformDurumu(plt)))
        .catch(() => {});
    }
  }, 3 * 60 * 1000);
  limitSayaci.unref?.();
  for (const plt of Object.values(ayarlar.platforms)) {
    if (plt.adapter !== 'chatgpt-codex') continue;
    Promise.all((plt.hesaplar || []).map((h) => codexAdaptoru.limitTazele(h)))
      .then(() => yayinla('platform', platformDurumu(plt)))
      .catch(() => {});
  }
  if (ayarlar.fal?.apiKey) {
    falAdaptoru.bakiyeTazele(ayarlar, true).then((b) => {
      if (b.deger !== null) log.info(`fal bakiyesi: $${b.deger.toFixed(2)}`);
      yayinla('fal', falOzeti());
    }).catch(() => {});
  }

  // Telegram botu panelle aynı süreçte koşar: aynı kuyruk, aynı runner, aynı
  // canlı akış. Bottan gelen iş de panelden gelen iş gibi "Durdur" edilebilir.
  const tgAyar = telegramAyarlariniYukle();
  if (telegram && tgAyar.enabled && tgAyar.token) {
    durum.telegram = botuBaslat({
      ayarlar,
      telegram: tgAyar,
      calistir: (job) => jobuArkaPlandaCalistir(job, ayarlar),
      bildir: (d) => yayinla('telegram', d),
      izinliMi: () => abonelikAktifMi(),
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

  // --- Abonelik kontrolü: açılışta + 6 saatte bir ---
  lisansTazele().then((d) => {
    if (!d.bilinmiyor) log.info(`Bakım desteği: ${d.aktif ? `${d.kalanGun} gün kaldı` : 'süre doldu'} (bitiş ${String(d.bitis).slice(0, 10)})`);
    yayinla('abonelik', d);
  });
  const abonelikSayaci = setInterval(() => {
    lisansTazele().then((d) => yayinla('abonelik', d)).catch(() => {});
  }, 6 * 60 * 60 * 1000);
  abonelikSayaci.unref?.();

  // --- Güncelleme bekçisi ---
  // "Otomatik güncelleme" açıkken panel periyodik olarak GitHub'ı yoklar;
  // yeni sürüm varsa ve hiçbir iş/giriş koşmuyorsa çekip KENDİNİ yeniden
  // başlatır — kimsenin VOKU menüsünden elle güncellemesi gerekmez.
  const yenidenBaslat = async () => {
    log.ok('Güncelleme uygulandı — panel yeni sürümle yeniden başlıyor…');

    // ÖNCE yeni süreç doğar (port doluysa kendi bekler — listen retry'lı),
    // yaşadığı doğrulanır, ANCAK ONDAN SONRA bu süreç kapanır. Çocuk hemen
    // ölürse restart iptal: panel eski sürümle ayakta kalır — hiçbir durumda
    // panelsiz (dışarıdan 502) kalınmaz.
    // Windows: eski süreç panel.out'u kilitli tutabiliyor (EBUSY) ve bu tek
    // satır tüm restart'ı aylarca kırdı — çıktı yakalamak restart'tan değerli
    // değil, açılamazsa 'ignore' ile devam (logger zaten voku.log'a yazıyor).
    let kayit = 'ignore';
    try {
      fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
      kayit = fs.openSync(path.join(ROOT, 'logs', 'panel.out'), 'a');
    } catch {
      /* kilitliyse çıktısız başlat */
    }
    // Mac'te panel caffeinate ile sarılı başlatılır (uyku engeli) — restart
    // bu sarmalayıcıyı korusun; diğer platformlarda düz node.
    const [komut, onArgumanlar] =
      process.platform === 'darwin'
        ? ['caffeinate', ['-dimsu', process.execPath]]
        : [process.execPath, []];
    const cocuk = spawn(komut, [...onArgumanlar, ...process.argv.slice(1)], {
      cwd: ROOT,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', kayit, kayit],
      env: process.env,
    });
    cocuk.unref();
    const dogdu = await new Promise((coz) => {
      let bitti = false;
      cocuk.once('error', () => { if (!bitti) { bitti = true; coz(false); } });
      cocuk.once('exit', () => { if (!bitti) { bitti = true; coz(false); } });
      setTimeout(() => { if (!bitti) { bitti = true; coz(true); } }, 2500);
    });
    if (!dogdu) {
      log.err('Yeni panel süreci başlatılamadı — yeniden başlatma iptal, panel mevcut sürümle sürüyor.');
      return;
    }

    clearInterval(bekci);
    clearInterval(falSayaci);
    clearInterval(limitSayaci);
    clearInterval(guncellemeBekcisi);
    clearInterval(abonelikSayaci);
    if (durum.telegram) durum.telegram.durdur();
    try { await adaptorAl('chatgpt-tarayici').kapat?.(); } catch { /* açık değildi */ }
    try { adaptorAl('gemini-http').koprulariDurdur?.(); } catch { /* açık değildi */ }
    // SSE bağlantıları sunucuyu açık tutmasın; panel arayüzü kopunca
    // kendiliğinden yeniden bağlanır.
    for (const res of sseIstemcileri) {
      try { res.end(); } catch { /* koptuysa sorun değil */ }
    }
    sunucu.closeAllConnections?.();
    await new Promise((coz) => {
      sunucu.close(() => coz());
      setTimeout(coz, 3000);
    });
    process.exit(0);
  };

  let sonGuncellemeHatasi = null;
  // Bu SÜRECİN doğduğu andaki kod sürümü. Restart yarım kalırsa (örn. eski
  // Windows'larda panel.out EBUSY) pull yapılmış ama süreç eski kodla koşar
  // durumda kalıyordu — sonraki turlar "zaten güncel" deyip geçiyordu.
  // Diskteki HEAD ile karşılaştırıp limboyu her turda yakalar, restart'ı
  // yeniden deneriz.
  let surecSurumu = null;
  yerelSurum().then((v) => { surecSurumu = v; }).catch(() => {});
  const guncellemeAralik = Number(process.env.VOKU_GUNCELLEME_ARALIK_MS) || 15 * 60 * 1000;
  const guncellemeBekcisi = setInterval(async () => {
    if (!guncellemeAyarlari().otomatik) return;
    // Üretim/giriş sürerken güncelleme uygulanmaz — sonraki tura kalır.
    if (durum.kosanJoblar.size || durum.girisSurecleri.size || durum.loginContextleri.size) return;
    try {
      const k = await guncellemeVarMi({ zorla: true });
      if (!k.var) {
        const diskte = await yerelSurum();
        if (surecSurumu && diskte && diskte !== surecSurumu) {
          log.warn('Kod diskte güncel ama panel eski sürümle koşuyor (önceki yeniden başlatma yarım kalmış) — yeniden başlatılıyor…');
          await yenidenBaslat();
        }
        return;
      }
      log.info(`Yeni sürüm bulundu (${k.adet} değişiklik: ${k.sonMesaj || ''}) — uygulanıyor…`);
      const sonuc = await guncelle();
      sonGuncellemeHatasi = null;
      if (sonuc.degisti) await yenidenBaslat();
    } catch (e) {
      const mesaj = String(e?.message || e).split('\n')[0];
      // Aynı hatayı her turda tekrarlama — bir kez logla.
      if (mesaj !== sonGuncellemeHatasi) {
        sonGuncellemeHatasi = mesaj;
        log.warn(`Otomatik güncelleme uygulanamadı: ${mesaj}`);
      }
    }
  }, guncellemeAralik);
  guncellemeBekcisi.unref?.();

  // --- Limit bekçisi ---
  // Tüm hesapları limitte olduğu için pending kalan işler, reset saati gelince
  // "Başlat"ı beklemesin: bekçi periyodik bakar, o platformda uygun hesap
  // açıldıysa işi kendiliğinden başlatır. Kota yeniden dolarsa runner yine
  // pending bırakır, bir sonraki turda tekrar denenir (sonsuz döngü yok:
  // yalnız uygun hesap VARKEN başlatılır).
  const bekci = setInterval(() => {
    for (const job of jobListele()) {
      if (durum.kosanJoblar.has(job.id)) continue;
      const platformlar = new Set(
        job.tasks
          .filter((t) => t.status === 'pending' && t.limitBekliyor)
          .map((t) => t.platform)
      );
      if (!platformlar.size) continue;
      const acilan = [...platformlar].some((pAd) => {
        const plt = ayarlar.platforms[pAd];
        return plt && plt.enabled !== false && uygunHesapVar(pAd, plt.hesaplar || []);
      });
      if (acilan) {
        log.ok(`${job.id}: limit penceresi açıldı — otomatik sürdürülüyor`);
        jobuArkaPlandaCalistir(job, ayarlar);
      }
    }
  }, 60000);
  bekci.unref?.();

  // Restart devri: eski süreç portu bırakmadan yeni süreç doğabilir —
  // EADDRINUSE'da ölmek paneli tamamen düşürür (dışarıdan 502). Bekle-dene.
  let dinlemeDenemesi = 0;
  sunucu.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && dinlemeDenemesi < 15) {
      dinlemeDenemesi += 1;
      log.warn(`Port ${port} henüz boşalmadı — ${dinlemeDenemesi}. bekleme (2sn)`);
      setTimeout(() => sunucu.listen(port, '127.0.0.1'), 2000);
      return;
    }
    log.err(`Panel dinleyemedi: ${e.message}`);
    process.exit(1);
  });
  sunucu.listen(port, '127.0.0.1', () => {
    const adres = `http://127.0.0.1:${port}`;
    log.ok(`Panel açık: ${adres}`);
    log.info(`Paylaşım bağlantısı: <dış-adres>/?anahtar=${erisim.erisimToken}`);
    log.info('Kapatmak için Ctrl+C.');
    if (ac) tarayicidaAc(adres);
  });

  const kapat = async () => {
    clearInterval(bekci);
    clearInterval(abonelikSayaci);
    clearInterval(falSayaci);
    clearInterval(limitSayaci);
    clearInterval(guncellemeBekcisi);
    if (durum.telegram) durum.telegram.durdur();
    // Açık Gemini köprü süreçlerini kapat (çoklu hesapta birden fazla olabilir).
    try {
      await adaptorAl('chatgpt-tarayici').kapat?.();
    } catch {
      /* tarayıcı yedeği hiç açılmadıysa sorun değil */
    }
    try {
      adaptorAl('gemini-http').koprulariDurdur?.();
    } catch {
      /* köprü hiç açılmadıysa sorun değil */
    }
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
