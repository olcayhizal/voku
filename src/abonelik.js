/**
 * Abonelik — imzalı lisans doğrulama.
 *
 * Lisans paketi ({veri, imza}) sağlayıcının gist'inde durur; panel günde
 * birkaç kez çekip AŞAĞIDAKİ AÇIK ANAHTARLA doğrular. Paket Ed25519 ile
 * imzalıdır: içeriği değiştiren herkes imzayı bozar, panel kabul etmez.
 * Ağ yokken son doğrulanmış paket diskten kullanılır — internet kesintisi
 * çalışmayı durdurmaz, yalnız bitiş tarihi belirleyicidir.
 *
 * Süre dolunca panel yeni iş açmayı/başlatmayı durdurur; mevcut işler ve
 * dosyalar görüntülenebilir kalır (veri rehin alınmaz).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './paths.js';
import { log } from './logger.js';

const LISANS_URL =
  'https://gist.githubusercontent.com/olcayhizal/95860229443f8096b0cd16a5a62215ad/raw/voku-lisans.json';

const ACIK_ANAHTAR = crypto.createPublicKey(
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAAejb2K6qK4T3Znryr8IeaHkIuKjUKr+xIjOQgB4Jx/c=
-----END PUBLIC KEY-----`
);

const ONBELLEK_DOSYASI = path.join(CONFIG_DIR, 'abonelik.json');
const GUN_MS = 24 * 60 * 60 * 1000;

let bellek = null; // son doğrulanmış { veri, imza, alindi }

function dogrula(paket) {
  if (!paket || typeof paket.imza !== 'string' || !paket.veri) return false;
  try {
    return crypto.verify(
      null,
      Buffer.from(JSON.stringify(paket.veri)),
      ACIK_ANAHTAR,
      Buffer.from(paket.imza, 'base64')
    );
  } catch {
    return false;
  }
}

function diskineYaz(paket) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(ONBELLEK_DOSYASI, JSON.stringify(paket, null, 2) + '\n');
  } catch {
    /* diske yazılamazsa bellek yeter */
  }
}

function diskinden() {
  try {
    const paket = JSON.parse(fs.readFileSync(ONBELLEK_DOSYASI, 'utf8'));
    return dogrula(paket) ? paket : null;
  } catch {
    return null;
  }
}

/** Lisansı ağdan tazeler; başarısızsa eldeki (bellek/disk) korunur. */
export async function lisansTazele() {
  try {
    const yanit = await fetch(`${LISANS_URL}?t=${Date.now()}`, {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    if (!yanit.ok) throw new Error(`lisans ${yanit.status}`);
    const paket = await yanit.json();
    if (!dogrula(paket)) throw new Error('lisans imzası geçersiz');
    bellek = { ...paket, alindi: new Date().toISOString() };
    diskineYaz(bellek);
    return durum();
  } catch (e) {
    if (!bellek) bellek = diskinden();
    log.warn(`Abonelik kontrolü yapılamadı (${String(e?.message || e).slice(0, 60)}) — ${bellek ? 'son doğrulanmış lisansla devam' : 'lisans bulunamadı'}`);
    return durum();
  }
}

/** Panel için anlık abonelik durumu (yalnız bellek/disk — ağa çıkmaz). */
export function durum() {
  if (!bellek) bellek = diskinden();
  if (!bellek) {
    // Hiç lisans görülmedi (ilk kurulum + ağ yok): kilitleme ama uyar.
    return { bilinmiyor: true, aktif: true, kalanGun: null, bitis: null, odemeler: [], mesaj: null };
  }
  const v = bellek.veri;
  const kalanMs = new Date(v.bitis).getTime() - Date.now();
  return {
    bilinmiyor: false,
    aktif: kalanMs > 0,
    kalanGun: Math.max(0, Math.ceil(kalanMs / GUN_MS)),
    bitis: v.bitis,
    baslangic: v.baslangic || null,
    haftalikTL: v.haftalikTL ?? null,
    odemeler: Array.isArray(v.odemeler) ? v.odemeler : [],
    mesaj: v.mesaj || null,
    sonKontrol: bellek.alindi || null,
  };
}

/** İş açma/başlatma izni — süre dolduysa false. */
export function aktifMi() {
  return durum().aktif;
}
