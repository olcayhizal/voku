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
};

export function ayarlariYukle(dosya) {
  const p = dosya ? path.resolve(dosya) : path.join(CONFIG_DIR, 'settings.json');
  if (!fs.existsSync(p)) throw new Error(`Ayar dosyası yok: ${p}`);
  const ham = JSON.parse(fs.readFileSync(p, 'utf8'));
  const s = { ...VARSAYILAN, ...ham };
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
  }
  return s;
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
    const tek = { ad: 'varsayılan', concurrency: varsayilanCon };
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
    if (plt.adapter === 'gemini-http') {
      const port = Number(h.port) || sonrakiPort;
      sonrakiPort = port + 1;
      // Her Gemini hesabı ayrı Google oturumu → ayrı tarayıcı profili.
      return {
        ad,
        concurrency: con,
        port,
        envAdi: h.envAdi || ad,
        profileDir: mutlak(h.profileDir || path.join('.profiles', `gemini-${ad}`)),
      };
    }
    return {
      ad,
      concurrency: con,
      codexHome: mutlak(h.codexHome || path.join('.profiles', `chatgpt-${ad}`, '.codex')),
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
