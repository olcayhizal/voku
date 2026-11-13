/**
 * Hızlı oda — işe bağlı olmayan görselleri doğrudan baskıya sokar.
 *
 * Baskı odası yalnız işlerin seçili baskı dosyalarını sayfaya dizer. Hızlı
 * odada ise panele sürüklenen herhangi bir görsel listeye girer, sırası
 * sürükle-bırak ile ayarlanır ve her 6'lık dilim bir A4 .etdx olarak alınır
 * (slot sırası = liste sırası: soldan sağa, yukarıdan aşağı).
 *
 * Kalıcı: `hizli-oda/liste.json` (panel yeniden başlasa da liste durur).
 *   orijinal/<id>.<uzantı>   yüklenen ham dosya (EXIF yönü düzeltilmiş)
 *   onizleme/<id>.jpg        panel küçük resmi
 *   baski/<id>-<mod>.png     899×1181 baskı tuvali (mod: h = hazırla, d = düz)
 *   etdx/                    üretilen .etdx dosyaları
 *
 * "Hazırla" açıkken görsel işlerdeki baskı hattından geçer (VOKU şablonu +
 * transfer aynası, yatay görsel 90° çevrilir). Kapalıyken yalnız tuvale
 * oturtulur — logo/ayna önceden uygulanmış dosyalar için.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { ROOT } from './paths.js';
import { baskiUret, BASKI_TUVALI } from './varyant.js';
import { etdxDosyasiYaz, GRUP_BOYUTU } from './sayfa.js';
import { log } from './logger.js';

const DIZIN = path.join(ROOT, 'hizli-oda');
const KAYIT = path.join(DIZIN, 'liste.json');
const ALT = {
  orijinal: path.join(DIZIN, 'orijinal'),
  onizleme: path.join(DIZIN, 'onizleme'),
  baski: path.join(DIZIN, 'baski'),
  etdx: path.join(DIZIN, 'etdx'),
};
const IZINLI_UZANTI = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.tif', '.tiff', '.avif']);

for (const d of Object.values(ALT)) fs.mkdirSync(d, { recursive: true });

function oku() {
  if (!fs.existsSync(KAYIT)) return { hazirla: true, kalemler: [] };
  try {
    const v = JSON.parse(fs.readFileSync(KAYIT, 'utf8'));
    return { hazirla: v.hazirla !== false, kalemler: Array.isArray(v.kalemler) ? v.kalemler : [] };
  } catch (e) {
    log.warn(`hizli-oda/liste.json okunamadı (${e.message}) — boş liste`);
    return { hazirla: true, kalemler: [] };
  }
}

function yaz(veri) {
  const gecici = `${KAYIT}.tmp`;
  fs.writeFileSync(gecici, JSON.stringify(veri, null, 2));
  fs.renameSync(gecici, KAYIT);
  return veri;
}

export function hizliOdaOzeti() {
  const v = oku();
  return {
    hazirla: v.hazirla,
    grupBoyutu: GRUP_BOYUTU,
    kalemler: v.kalemler.map(({ id, ad, genislik, yukseklik, eklendi }) => ({
      id, ad, genislik, yukseklik, eklendi,
    })),
  };
}

function kalemBul(v, id) {
  const k = v.kalemler.find((x) => x.id === id);
  if (!k) throw new Error(`Hızlı odada böyle görsel yok: ${id}`);
  return k;
}

/** Ham görseli listeye ekler (sona). EXIF yönü burada düzeltilir. */
export async function gorselEkle(ad, veri) {
  const temizAd = path.basename(String(ad || 'gorsel')).slice(0, 120);
  let uzanti = path.extname(temizAd).toLowerCase();
  if (!IZINLI_UZANTI.has(uzanti)) uzanti = '.png';
  if (!veri?.length) throw new Error('Boş dosya.');

  let bilgi;
  try {
    bilgi = await sharp(veri).metadata();
  } catch {
    throw new Error(`${temizAd}: görsel okunamadı (desteklenmeyen biçim).`);
  }
  if (!bilgi.width || !bilgi.height) throw new Error(`${temizAd}: görsel boyutu okunamadı.`);

  const id = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  // Telefon fotoğrafı yan yatmasın: yönü piksele işle, PNG olarak sakla.
  const { data, info } = await sharp(veri).rotate().png().toBuffer({ resolveWithObject: true });
  const dosya = `${id}.png`;
  fs.writeFileSync(path.join(ALT.orijinal, dosya), data);
  // Önizleme baskıdaki yönle: yatay görsel tuvale 90° çevrilerek oturur,
  // panelde de öyle görünsün (yoksa dikey karede ortası kırpılmış görünürdü).
  const onizlemeKaynak = info.width > info.height ? await sharp(data).rotate(90).toBuffer() : data;
  await sharp(onizlemeKaynak)
    .resize({ width: 420, height: 420, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toFile(path.join(ALT.onizleme, `${id}.jpg`));

  const v = oku(); // async iş sürerken liste değişmiş olabilir — tazeden oku
  v.kalemler.push({
    id,
    ad: temizAd,
    dosya,
    genislik: info.width,
    yukseklik: info.height,
    eklendi: new Date().toISOString(),
  });
  yaz(v);
  return hizliOdaOzeti();
}

/** Yeni sıra: id listesi. Listede olmayan id atlanır, unutulan kalem sona eklenir. */
export function siraKaydet(idler) {
  const v = oku();
  const harita = new Map(v.kalemler.map((k) => [k.id, k]));
  const yeni = [];
  for (const id of Array.isArray(idler) ? idler : []) {
    if (harita.has(id)) {
      yeni.push(harita.get(id));
      harita.delete(id);
    }
  }
  v.kalemler = [...yeni, ...harita.values()];
  yaz(v);
  return hizliOdaOzeti();
}

export function ayarKaydet({ hazirla }) {
  const v = oku();
  v.hazirla = hazirla !== false;
  yaz(v);
  return hizliOdaOzeti();
}

function kalemDosyalariniSil(k) {
  const adaylar = [
    path.join(ALT.orijinal, k.dosya),
    path.join(ALT.onizleme, `${k.id}.jpg`),
    path.join(ALT.baski, `${k.id}-h.png`),
    path.join(ALT.baski, `${k.id}-d.png`),
  ];
  for (const f of adaylar) fs.rmSync(f, { force: true });
}

export function gorselSil(id) {
  const v = oku();
  const k = kalemBul(v, id);
  v.kalemler = v.kalemler.filter((x) => x.id !== id);
  yaz(v);
  kalemDosyalariniSil(k);
  return hizliOdaOzeti();
}

export function hepsiniTemizle() {
  const v = oku();
  for (const k of v.kalemler) kalemDosyalariniSil(k);
  for (const f of fs.readdirSync(ALT.etdx)) fs.rmSync(path.join(ALT.etdx, f), { force: true });
  v.kalemler = [];
  yaz(v);
  return hizliOdaOzeti();
}

export function onizlemeYolu(id) {
  const v = oku();
  kalemBul(v, id);
  return path.join(ALT.onizleme, `${id}.jpg`);
}

/** Kalemin baskı tuvali hali — yoksa üretir (mod değişince ayrı dosya). */
async function baskiHali(k, hazirla) {
  const mod = hazirla ? 'h' : 'd';
  const hedef = path.join(ALT.baski, `${k.id}-${mod}.png`);
  if (fs.existsSync(hedef)) return hedef;
  const kaynak = path.join(ALT.orijinal, k.dosya);
  if (!fs.existsSync(kaynak)) throw new Error(`${k.ad}: orijinal dosya kaybolmuş — sil ve yeniden yükle.`);

  if (hazirla) {
    // İşlerdeki baskı hattının aynısı: yatay görsel çevrilir, şablon + ayna.
    await baskiUret(kaynak, hedef, { yatayIs: true });
  } else {
    const [width, height] = BASKI_TUVALI;
    const bilgi = await sharp(kaynak).metadata();
    const cevir = bilgi.width > bilgi.height;
    const tampon = cevir ? await sharp(kaynak).rotate(90).toBuffer() : kaynak;
    await sharp(tampon).resize(width, height, { fit: 'cover', position: 'centre' }).png().toFile(hedef);
  }
  return hedef;
}

/**
 * Bir sayfanın (0 tabanlı, 6'lık dilim) .etdx'ini üretir.
 * @returns {Promise<{yol: string, ad: string, adet: number}>}
 */
export async function hizliEtdxUret(sayfaNo) {
  const v = oku();
  const no = Math.max(0, Math.floor(Number(sayfaNo) || 0));
  const dilim = v.kalemler.slice(no * GRUP_BOYUTU, (no + 1) * GRUP_BOYUTU);
  if (!dilim.length) throw new Error(`${no + 1}. sayfada görsel yok.`);

  const gorseller = [];
  for (const k of dilim) gorseller.push(await baskiHali(k, v.hazirla));

  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const ad = `hizli-${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}-${p(d.getHours())}${p(d.getMinutes())}-s${no + 1}.etdx`;
  const yol = path.join(ALT.etdx, ad);
  await etdxDosyasiYaz(gorseller, yol);
  log.ok(`Hızlı oda: ${ad} üretildi (${dilim.length} görsel${v.hazirla ? ', şablon + ayna' : ', düz'})`);
  return { yol, ad, adet: dilim.length };
}
