/**
 * fal.ai sürücüsü — web oturumlarının ücretli API yedeği.
 *
 * Her platform kendi fal modelini kullanır (`platform.falModel`): ChatGPT →
 * openai/gpt-image-2/edit, Gemini → fal-ai/nano-banana-pro/edit (köprünün
 * kullandığı gemini-3-pro-image'ın API hali). Girdi fotoğrafı fal storage'a
 * bir kez yüklenir (job başına cache), üretim queue API ile yapılır.
 *
 * Havuzda `yedek: true` sanal hesap olarak durur: web hesaplarının hepsi
 * limitte/pasifken devreye girer ("gerekirse kullan" modu). `aktif` modda
 * normal hesap gibi failover sırasının sonunda yer alır.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bekle } from '../browser.js';
import { log } from '../logger.js';

export const ad = 'fal';
export const tarayiciGerekli = false;
export const girisTipi = 'anahtar';

const KUYRUK_KOKU = 'https://queue.fal.run';
const BAKIYE_URL = 'https://rest.alpha.fal.ai/billing/user_balance';
const YUKLEME_URL = 'https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

function anahtar(ayarlar) {
  const k = ayarlar?.fal?.apiKey;
  if (!k) {
    const e = new Error('fal API anahtarı tanımlı değil — Oturumlar sekmesinden gir.');
    e.limitDolu = true;
    e.sebep = 'oturum';
    throw e;
  }
  return k;
}

async function falIstek(url, apiKey, secenek = {}) {
  const yanit = await fetch(url, {
    ...secenek,
    headers: {
      authorization: `Key ${apiKey}`,
      'content-type': 'application/json',
      ...(secenek.headers || {}),
    },
  });
  if (!yanit.ok) {
    let detay = '';
    try {
      detay = await yanit.text();
    } catch {
      /* gövde okunamadıysa durum kodu yeter */
    }
    const e = new Error(`fal ${yanit.status}: ${detay.slice(0, 200) || yanit.statusText}`);
    e.durumKodu = yanit.status;
    throw e;
  }
  return yanit.json();
}

/* ---------------- bakiye ---------------- */
// Panel header'ı için: 5 dk cache'li; üretim sonrası zorla tazelenir.
const bakiye = { deger: null, zaman: 0, hata: null };
const BAKIYE_CACHE_MS = 5 * 60 * 1000;

export function sonBakiye() {
  return { deger: bakiye.deger, zaman: bakiye.zaman || null, hata: bakiye.hata };
}

export async function bakiyeTazele(ayarlar, zorla = false) {
  const apiKey = ayarlar?.fal?.apiKey;
  if (!apiKey) return sonBakiye();
  if (!zorla && bakiye.zaman && Date.now() - bakiye.zaman < BAKIYE_CACHE_MS) return sonBakiye();
  try {
    const yanit = await fetch(BAKIYE_URL, { headers: { authorization: `Key ${apiKey}` } });
    if (!yanit.ok) throw new Error(`bakiye okunamadı (${yanit.status})`);
    const deger = Number(await yanit.text());
    if (!Number.isFinite(deger)) throw new Error('bakiye sayı değil');
    bakiye.deger = deger;
    bakiye.zaman = Date.now();
    bakiye.hata = null;
  } catch (e) {
    bakiye.hata = String(e?.message || e);
  }
  return sonBakiye();
}

/* ---------------- girdi yükleme ---------------- */
// Aynı fotoğraf job içindeki her task için yeniden yüklenmesin.
const yuklenen = new Map(); // imagePath → { url, mtime }

async function gorseliYukle(imagePath, apiKey) {
  const mtime = fs.statSync(imagePath).mtimeMs;
  const eski = yuklenen.get(imagePath);
  if (eski && eski.mtime === mtime) return eski.url;

  const uzanti = path.extname(imagePath).toLowerCase();
  const tip = MIME[uzanti] || 'image/jpeg';
  const { file_url, upload_url } = await falIstek(YUKLEME_URL, apiKey, {
    method: 'POST',
    body: JSON.stringify({ content_type: tip, file_name: path.basename(imagePath) }),
  });
  const govde = fs.readFileSync(imagePath);
  const yanit = await fetch(upload_url, {
    method: 'PUT',
    headers: { 'content-type': tip },
    body: govde,
  });
  if (!yanit.ok) throw new Error(`fal yükleme başarısız (${yanit.status})`);
  yuklenen.set(imagePath, { url: file_url, mtime });
  return file_url;
}

/* ---------------- havuz entegrasyonu ---------------- */
/**
 * Platformun havuzuna eklenecek sanal fal hesabı. Anahtar yoksa veya mod
 * pasifse null — havuza katılmaz.
 */
export function sanalHesap(ayarlar, platform) {
  if (!ayarlar?.fal?.apiKey || !platform?.falModel) return null;
  const mod = platform.falMod || 'yedek';
  if (mod === 'pasif') return null;
  return {
    ad: 'fal',
    saglayici: 'fal',
    yedek: mod === 'yedek',
    aktif: true,
    concurrency: Math.max(1, Number(ayarlar.fal.concurrency) || 4),
  };
}

/* ---------------- adapter arayüzü ---------------- */
export async function hazirla(_page, _platform, _sel, ayarlar) {
  anahtar(ayarlar);
}

function hataCevir(e) {
  // Bakiye bitti: kendiliğinden açılmaz — 1 saat dinlendir, kullanıcı yükleyince
  // Sına/aktifleştirme ile erken açılır. 429: kısa geçici bekleme.
  const mesaj = String(e?.message || e);
  if (e?.durumKodu === 402 || /exhausted|insufficient|balance|locked/i.test(mesaj)) {
    const y = new Error('fal bakiyesi yetersiz — bakiye yükleyin.');
    y.limitDolu = true;
    y.resetsAt = Date.now() + 60 * 60 * 1000;
    return y;
  }
  if (e?.durumKodu === 429) {
    const y = new Error('fal istek sınırına takıldı (geçici).');
    y.limitDolu = true;
    y.resetsAt = Date.now() + 3 * 60 * 1000;
    return y;
  }
  if (e?.durumKodu === 401 || e?.durumKodu === 403) {
    const y = new Error(`fal anahtarı reddedildi (${e.durumKodu}) — anahtarı kontrol et.`);
    y.limitDolu = true;
    y.sebep = 'oturum';
    y.resetsAt = Date.now() + 30 * 60 * 1000;
    return y;
  }
  return e;
}

export async function uret(_page, { imagePath, prompt, outDir, baseName, ayarlar, platform, signal }) {
  const apiKey = anahtar(ayarlar);
  const model = platform.falModel;
  if (!model) throw new Error(`${platform.ad} için fal modeli tanımlı değil.`);

  try {
    const girdiUrl = await gorseliYukle(imagePath, apiKey);
    const istek = await falIstek(`${KUYRUK_KOKU}/${model}`, apiKey, {
      method: 'POST',
      body: JSON.stringify({ prompt, image_urls: [girdiUrl] }),
    });
    log.info(`[fal] ${model} kuyruğa alındı: ${istek.request_id}`);

    // Kuyruk durumunu bekle (status_url fal'dan geliyor).
    const baslangic = Date.now();
    const zamanAsimi = Number(ayarlar.generationTimeoutMs) || 240000;
    let durum = istek;
    while (durum.status !== 'COMPLETED') {
      if (signal?.aborted) throw new Error('durduruldu');
      if (Date.now() - baslangic > zamanAsimi) {
        throw new Error(`fal üretimi zaman aşımına uğradı (${Math.round(zamanAsimi / 1000)}s).`);
      }
      await bekle(2500, signal);
      durum = await falIstek(istek.status_url, apiKey);
    }

    const sonuc = await falIstek(istek.response_url, apiKey);
    const gorseller = sonuc.images || [];
    if (!gorseller.length) throw new Error('fal sonuç döndürdü ama görsel yok.');

    fs.mkdirSync(outDir, { recursive: true });
    const dosyalar = [];
    for (let i = 0; i < gorseller.length; i++) {
      const g = gorseller[i];
      const uzanti = /\.(png|jpe?g|webp)(\?|$)/i.exec(g.url)?.[1]?.replace('jpeg', 'jpg') || 'png';
      const dosyaAdi = `${baseName}-fal${gorseller.length > 1 ? `-${i + 1}` : ''}.${uzanti}`;
      const hedef = path.join(outDir, dosyaAdi);
      const yanit = await fetch(g.url);
      if (!yanit.ok) throw new Error(`fal görseli indirilemedi (${yanit.status})`);
      fs.writeFileSync(hedef, Buffer.from(await yanit.arrayBuffer()));
      const boyut = fs.statSync(hedef).size;
      if (!boyut) throw new Error('fal görseli boş indi.');
      dosyalar.push(dosyaAdi);
    }

    // Üretim para harcadı — header bakiyesi gecikmeden tazelensin.
    bakiyeTazele(ayarlar, true).catch(() => {});
    return dosyalar;
  } catch (e) {
    bakiyeTazele(ayarlar, true).catch(() => {});
    throw hataCevir(e);
  }
}
