import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CONFIG_DIR } from './paths.js';

const VARSAYILAN = {
  headless: false,
  slowMo: 0,
  maxAttempts: 3,
  retryBackoffMs: 5000,
  generationTimeoutMs: 240000,
  navigationTimeoutMs: 60000,
  parallelPlatforms: true,
  platforms: {},
  selectors: {},
  // fal.ai yedek üretim: anahtar panelden girilir, settings.json'da saklanır.
  fal: { apiKey: null, concurrency: 4 },
};

// Platform başına varsayılan fal modeli. Gemini'de Nano Banana 2
// (gemini-3.1-flash, $0.08/kare) tercih edildi — Pro ($0.15) yerine.
const FAL_MODELLERI = {
  'gemini-http': 'fal-ai/nano-banana-2/edit',
  'chatgpt-codex': 'openai/gpt-image-2/edit',
};

const FAL_MODLARI = ['aktif', 'yedek', 'pasif'];

// Hesap üretim motoru (chatgpt): codex = CLI (Codex kotası), web = tarayıcı
// (chatgpt.com görsel hakkı). İki kota bağımsız — hesap eklerken seçilir.
const MOTORLAR = ['codex', 'web'];

export function ayarlariYukle(dosya) {
  const p = dosya ? path.resolve(dosya) : path.join(CONFIG_DIR, 'settings.json');
  if (!fs.existsSync(p)) throw new Error(`Ayar dosyası yok: ${p}`);
  const ham = JSON.parse(fs.readFileSync(p, 'utf8'));
  const s = { ...VARSAYILAN, ...ham };
  s.fal = { ...VARSAYILAN.fal, ...(ham.fal || {}) };
  // Profil yolları köke göre mutlaklaştırılır. Tarayıcısız sürücülerde
  // (Codex) profileDir olmayabilir — o platformda tarayıcı hiç açılmaz.
  for (const [ad, plt] of Object.entries(s.platforms)) {
    plt.ad = ad;
    if (plt.profileDir) {
      plt.profileDir = path.isAbsolute(plt.profileDir)
        ? plt.profileDir
        : path.join(ROOT, plt.profileDir);
    }
    plt.hesaplar = hesaplariNormalize(plt);
    plt.falModel = plt.falModel || FAL_MODELLERI[plt.adapter] || null;
    plt.falMod = FAL_MODLARI.includes(plt.falMod) ? plt.falMod : 'yedek';
  }
  return s;
}

const AYAR_YOLU = path.join(CONFIG_DIR, 'settings.json');

/** settings.json'u okur (ham, normalize etmeden). */
function hamAyarOku() {
  return JSON.parse(fs.readFileSync(AYAR_YOLU, 'utf8'));
}

function hamAyarYaz(ham) {
  fs.writeFileSync(AYAR_YOLU, JSON.stringify(ham, null, 2) + '\n');
}

/**
 * Tek-hesap ayarı ilk kez listeye dönüşürken "varsayılan" hesap, platformun
 * mevcut oturum yollarını (düz `.env`, profil, codexHome) açıkça devralır —
 * yoksa normalize `.profiles/<plt>-varsayılan` türetir ve eski oturum
 * "kaybolmuş" görünür.
 */
function tekHesabiSomutlastir(plt) {
  if (Array.isArray(plt.hesaplar) && plt.hesaplar.length) return;
  const tek = { ad: 'varsayılan' };
  if (plt.adapter === 'gemini-http') {
    tek.port = portCikar(plt.baseUrl);
    tek.envAdi = null; // köprü dizinindeki düz .env — mevcut çerezler korunur
    if (plt.profileDir) tek.profileDir = plt.profileDir;
  } else {
    tek.codexHome = plt.codexHome || null; // null → Codex'in kendi varsayılanı
  }
  plt.hesaplar = [tek];
}

/**
 * Panelden hesap ekler: settings.json'a yazar VE çalışan `ayarlar` objesinin
 * o platformunun hesap listesini yeniden normalize eder (panel yeniden
 * başlamadan havuz yeni hesabı görsün).
 */
export function hesapEkle(ayarlar, platformAdi, hesapAd, motor) {
  const ad = String(hesapAd || '').trim();
  if (!ad) throw new Error('Hesap adı boş olamaz.');
  if (!/^[\w.-]{1,32}$/.test(ad)) throw new Error('Hesap adı yalnız harf/rakam/.-_ olabilir (en çok 32).');

  const ham = hamAyarOku();
  const plt = ham.platforms?.[platformAdi];
  if (!plt) throw new Error(`Bilinmeyen platform: ${platformAdi}`);
  if (motor !== undefined && motor !== null && !MOTORLAR.includes(motor)) {
    throw new Error(`Geçersiz motor: ${motor} (codex/web olmalı).`);
  }
  if (motor === 'web' && plt.adapter !== 'chatgpt-codex') {
    throw new Error(`${platformAdi} web motorunu desteklemiyor.`);
  }

  tekHesabiSomutlastir(plt);
  if (plt.hesaplar.some((h) => h.ad === ad)) throw new Error(`"${ad}" hesabı zaten var.`);
  plt.hesaplar.push(motor === 'web' ? { ad, motor: 'web' } : { ad });
  hamAyarYaz(ham);

  ayarlar.platforms[platformAdi].hesaplar = hesaplariNormalize({ ...plt, ad: platformAdi });
  return ayarlar.platforms[platformAdi].hesaplar.find((h) => h.ad === ad);
}

/**
 * Panelden hesap ayarı değiştirir (şimdilik yalnız eşzamanlılık).
 * settings.json'a yazar VE çalışan ayarı yeniden normalize eder — süren
 * platform kuyruğu eski değeriyle biter, yeni işler yeni değeri kullanır.
 */
export function hesapAyarla(ayarlar, platformAdi, hesapAd, degisiklik) {
  const ham = hamAyarOku();
  const plt = ham.platforms?.[platformAdi];
  if (!plt) throw new Error(`Bilinmeyen platform: ${platformAdi}`);
  tekHesabiSomutlastir(plt);
  const h = plt.hesaplar.find((x) => x.ad === hesapAd);
  if (!h) throw new Error(`"${hesapAd}" hesabı yok.`);

  if (degisiklik.concurrency !== undefined) {
    const c = Math.floor(Number(degisiklik.concurrency));
    if (!Number.isFinite(c) || c < 1) {
      throw new Error('Eşzamanlı üretim en az 1 olmalı.');
    }
    h.concurrency = c;
  }
  if (degisiklik.aktif !== undefined) {
    h.aktif = Boolean(degisiklik.aktif);
  }

  hamAyarYaz(ham);
  ayarlar.platforms[platformAdi].hesaplar = hesaplariNormalize({ ...plt, ad: platformAdi });
  return ayarlar.platforms[platformAdi].hesaplar.find((x) => x.ad === hesapAd);
}

/** Panelden hesap siler (en az bir hesap kalmalı). */
export function hesapSil(ayarlar, platformAdi, hesapAd) {
  const ham = hamAyarOku();
  const plt = ham.platforms?.[platformAdi];
  if (!plt) throw new Error(`Bilinmeyen platform: ${platformAdi}`);
  const liste = Array.isArray(plt.hesaplar) ? plt.hesaplar : [];
  if (liste.length <= 1) throw new Error('Son hesap silinemez — en az bir hesap kalmalı.');
  const kalan = liste.filter((h) => h.ad !== hesapAd);
  if (kalan.length === liste.length) throw new Error(`"${hesapAd}" hesabı yok.`);
  plt.hesaplar = kalan;
  hamAyarYaz(ham);
  ayarlar.platforms[platformAdi].hesaplar = hesaplariNormalize({ ...plt, ad: platformAdi });
}

/** fal API anahtarını kaydeder (settings.json + çalışan ayar). */
export function falAnahtarKaydet(ayarlar, apiKey) {
  const anahtar = String(apiKey || '').trim();
  if (!/^[\w-]+:[\w-]+$/.test(anahtar)) {
    throw new Error('Geçersiz fal anahtarı — "id:secret" biçiminde olmalı.');
  }
  const ham = hamAyarOku();
  ham.fal = { ...(ham.fal || {}), apiKey: anahtar };
  hamAyarYaz(ham);
  ayarlar.fal = { ...VARSAYILAN.fal, ...ham.fal };
  return ayarlar.fal;
}

/** Platformun fal modunu değiştirir: aktif | yedek | pasif. */
export function falModKaydet(ayarlar, platformAdi, mod) {
  if (!FAL_MODLARI.includes(mod)) {
    throw new Error(`Geçersiz fal modu: ${mod} (aktif/yedek/pasif olmalı).`);
  }
  const ham = hamAyarOku();
  const plt = ham.platforms?.[platformAdi];
  if (!plt) throw new Error(`Bilinmeyen platform: ${platformAdi}`);
  plt.falMod = mod;
  hamAyarYaz(ham);
  ayarlar.platforms[platformAdi].falMod = mod;
  return mod;
}

/**
 * Bir platformun hesap listesini üretir. `hesaplar` tanımlıysa çoklu havuz;
 * yoksa mevcut tek-hesap ayarları tek elemanlı listeye sarılır (geriye uyum —
 * eski settings.json'lar aynen çalışır).
 *
 * ChatGPT hesabı: `{ ad, codexHome }` — Codex oturumu (`auth.json`) bu dizinde;
 * yol köke göre mutlaklaştırılır, boşsa Codex'in kendi varsayılanı kullanılır.
 * Gemini hesabı: `{ ad, port, envAdi }` — her hesap ayrı köprü portu ve ayrı
 * `.env.<envAdi>` (çerezleri farklı Google hesabından).
 */
function hesaplariNormalize(plt) {
  const cocuk = Array.isArray(plt.hesaplar) && plt.hesaplar.length ? plt.hesaplar : null;
  const varsayilanCon = plt.concurrency;

  if (!cocuk) {
    // Tek hesap — mevcut alanlardan türetilir.
    const tek = { ad: 'varsayılan', concurrency: varsayilanCon, aktif: true };
    if (plt.adapter === 'gemini-http') {
      tek.port = portCikar(plt.baseUrl);
      tek.envAdi = null; // köprü dizinindeki düz `.env`
      tek.profileDir = plt.profileDir || null; // mevcut tek profil
    } else {
      tek.codexHome = plt.codexHome ? mutlak(plt.codexHome) : null;
    }
    return [tek];
  }

  let sonrakiPort = 4981;
  return cocuk.map((h, i) => {
    const ad = String(h.ad || `hesap-${i + 1}`);
    const con = Number(h.concurrency) > 0 ? Number(h.concurrency) : varsayilanCon;
    const aktif = h.aktif !== false;
    if (plt.adapter === 'gemini-http') {
      const port = Number(h.port) || sonrakiPort;
      sonrakiPort = port + 1;
      // Her Gemini hesabı ayrı Google oturumu → ayrı tarayıcı profili.
      // envAdi açıkça null yazılmışsa köprü dizinindeki düz `.env` demektir
      // (somutlaştırılmış eski tek-hesap) — ad'a düşürülmez.
      return {
        ad,
        concurrency: con,
        aktif,
        port,
        envAdi: h.envAdi === undefined ? ad : h.envAdi,
        profileDir: mutlak(h.profileDir || path.join('.profiles', `gemini-${ad}`)),
      };
    }
    // Web motorlu hesap: chatgpt.com'u kendi tarayıcı profiliyle kullanır
    // (Codex kotasından ayrı web hakkı). Paralellik aynı pencerede SEKME
    // açarak sağlanır — varsayılan 1, panelden artırılabilir.
    if (h.motor === 'web') {
      return {
        ad,
        concurrency: Number(h.concurrency) > 0 ? Number(h.concurrency) : 1,
        aktif,
        motor: 'web',
        // Web limiti ~3 saatlik kayan pencere: hesaplar dönüşümlü kullanılır
        // ki pencereler dengeli dolsun (Codex'teki "birini bitir" yerine).
        rotasyon: true,
        profileDir: mutlak(h.profileDir || path.join('.profiles', `chatgpt-web-${ad}`)),
      };
    }
    // codexHome açıkça null ise Codex'in kendi varsayılan dizini kullanılır
    // (somutlaştırılmış eski tek-hesap); tanımsızsa hesaba özel profil türetilir.
    return {
      ad,
      concurrency: con,
      aktif,
      motor: 'codex',
      codexHome:
        h.codexHome === undefined
          ? mutlak(path.join('.profiles', `chatgpt-${ad}`, '.codex'))
          : h.codexHome
            ? mutlak(h.codexHome)
            : null,
    };
  });
}

function mutlak(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

function portCikar(baseUrl) {
  try {
    return Number(new URL(baseUrl || 'http://127.0.0.1:4981').port) || 4981;
  } catch {
    return 4981;
  }
}

/**
 * Prompt listesini yükler ve doğrular.
 * Kabul edilen biçim: { prompts: [...] } veya doğrudan [...]
 * Her kayıt: { id, platform, prompt, count? }
 */
export function promptDosyaYolu(dosya) {
  return dosya ? path.resolve(dosya) : path.join(CONFIG_DIR, 'prompts.json');
}

export function promptlariYukle(dosya, ayarlar) {
  const p = promptDosyaYolu(dosya);
  if (!fs.existsSync(p)) throw new Error(`Prompt dosyası yok: ${p}`);
  const ham = JSON.parse(fs.readFileSync(p, 'utf8'));
  const liste = Array.isArray(ham) ? ham : ham.prompts;
  return promptlariDogrula(liste, ayarlar, p);
}

/** Ham prompt listesini doğrular, normalize eder. Panel kaydetmeden önce de çağırır. */
export function promptlariDogrula(liste, ayarlar, kaynak = 'prompt listesi') {
  if (!Array.isArray(liste) || liste.length === 0) {
    throw new Error(`Prompt listesi boş: ${kaynak}`);
  }

  const gorulen = new Set();
  const bilinen = Object.keys(ayarlar?.platforms || {});

  // Eski listelerde platform yerine sürücü adı yazılmış olabilir
  // (ör. "chatgpt-codex"). Sürücüyü kullanan platforma sessizce eşle.
  const surucuEslemesi = {};
  for (const [ad, plt] of Object.entries(ayarlar?.platforms || {})) {
    if (plt.adapter && !bilinen.includes(plt.adapter)) surucuEslemesi[plt.adapter] = ad;
  }

  return liste.map((kayit, i) => {
    const id = String(kayit.id ?? `p${String(i + 1).padStart(2, '0')}`);
    if (gorulen.has(id)) throw new Error(`Tekrarlanan prompt id: ${id}`);
    gorulen.add(id);

    let platform = String(kayit.platform || '').toLowerCase();
    if (!platform) throw new Error(`Prompt "${id}": platform boş.`);
    if (bilinen.length && !bilinen.includes(platform)) {
      if (surucuEslemesi[platform]) {
        platform = surucuEslemesi[platform];
      } else {
        throw new Error(
          `Prompt "${id}": bilinmeyen platform "${platform}". Tanımlı: ${bilinen.join(', ')}`
        );
      }
    }
    const prompt = String(kayit.prompt || '').trim();
    if (!prompt) throw new Error(`Prompt "${id}": prompt metni boş.`);

    const count = Number.isInteger(kayit.count) && kayit.count > 0 ? kayit.count : 1;
    return { id, platform, prompt, count, sira: i + 1 };
  });
}

/** Doğrulanmış listeyi prompts.json'a yazar (panel "Kaydet"). */
export function promptlariKaydet(liste, ayarlar, dosya) {
  const dogrulanmis = promptlariDogrula(liste, ayarlar);
  const p = promptDosyaYolu(dosya);
  const govde = {
    prompts: dogrulanmis.map(({ id, platform, prompt, count }) => ({
      id,
      platform,
      count,
      prompt,
    })),
  };
  fs.writeFileSync(p, JSON.stringify(govde, null, 2));
  return dogrulanmis;
}
