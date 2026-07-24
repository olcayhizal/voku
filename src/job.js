import fs from 'node:fs';
import path from 'node:path';
import { OUTPUT_DIR } from './paths.js';
import { jobVarMi, jobYaz, manifestYaz } from './store.js';
import { varyantlariHazirla, girdiyiHazirla } from './varyant.js';
import { log } from './logger.js';

/** 05551112233 / +90 555 111 22 33 → 05551112233 */
export function telefonuNormalize(ham) {
  if (!ham) return null;
  let s = String(ham).replace(/\D/g, '');
  if (!s) return null;
  if (s.startsWith('90') && s.length === 12) s = '0' + s.slice(2);
  if (s.length === 10 && !s.startsWith('0')) s = '0' + s;
  return s;
}

/**
 * Normalize telefondan WhatsApp bağlantısı: `wa.me/90XXXXXXXXXX`.
 * Numara TR biçiminde (0 + 10 hane) değilse null döner — panel butonu
 * göstermez, bozuk linke tıklatmaktansa hiç göstermemek yeğdir.
 */
export function waLinki(telefon) {
  const s = String(telefon || '').replace(/\D/g, '');
  let onHane = null;
  if (s.length === 11 && s.startsWith('0')) onHane = s.slice(1);
  else if (s.length === 12 && s.startsWith('90')) onHane = s.slice(2);
  else if (s.length === 10) onHane = s;
  // Abone numarası 0 ile başlamaz; bu eleme sahte iş kodlarını (000…) da tutar.
  if (!onHane || onHane.startsWith('0')) return null;
  return `https://wa.me/90${onHane}`;
}

/** Telefon yoksa 000 ile başlayan 11 haneli sahte id. */
export function sahteIdUret() {
  let n = '';
  for (let i = 0; i < 8; i++) n += Math.floor(Math.random() * 10);
  return '000' + n;
}

/** DD-MM-YYYY */
export function tarihEtiketi(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
}

/** Çakışmayan job id + klasör adı üretir: DD-MM-YYYY-<telefon|000XXXXXXXX> */
export function jobIdUret(telefon) {
  const tarih = tarihEtiketi();
  for (let deneme = 0; deneme < 50; deneme++) {
    const ek = telefon || sahteIdUret();
    const id = `${tarih}-${ek}`;
    const klasor = path.join(OUTPUT_DIR, id);
    if (!jobVarMi(id) && !fs.existsSync(klasor)) return id;
    if (telefon) {
      // Aynı gün aynı numaraya ikinci job → sonuna sıra ekle
      for (let i = 2; i < 100; i++) {
        const id2 = `${tarih}-${ek}-${i}`;
        if (!jobVarMi(id2) && !fs.existsSync(path.join(OUTPUT_DIR, id2))) return id2;
      }
      throw new Error('Aynı gün/numara için job sırası doldu.');
    }
  }
  throw new Error('Benzersiz job id üretilemedi.');
}

/** İş kaynakları: panelden yüklenen fotoğraf mı, Telegram botundan mı geldi. */
export const KAYNAKLAR = ['panel', 'telegram'];

/**
 * Eski joblarda `kaynak` alanı yok — bunlar panelden/CLI'dan açılmıştı,
 * `panel` sayılır. Bilinmeyen değer de panele düşer (rozet boş kalmasın).
 */
export function kaynakNormalize(deger) {
  const k = String(deger || '').toLowerCase();
  return KAYNAKLAR.includes(k) ? k : 'panel';
}

/**
 * Yeni job oluşturur.
 * @param {{ imagePath: string, phone?: string, prompts: Array, note?: string,
 *          kaynak?: string, kaynakBilgi?: object }} p
 */
export async function jobOlustur({ imagePath, phone, prompts, note, kaynak, kaynakBilgi }) {
  const foto = path.resolve(imagePath);
  if (!fs.existsSync(foto)) throw new Error(`Fotoğraf bulunamadı: ${foto}`);

  const telefon = telefonuNormalize(phone);
  const id = jobIdUret(telefon);
  const outputDir = path.join(OUTPUT_DIR, id);
  fs.mkdirSync(outputDir, { recursive: true });
  varyantlariHazirla(outputDir); // uretim / demo / baski

  // Input fotoğrafı çıktı klasörüne alınır — kaynak sonradan silinse de job
  // çalışır. Yatay fotoğraf burada dikeye çevrilir; üretim hep dikey başlar.
  const inputKopya = path.join(outputDir, `input${path.extname(foto) || '.jpg'}`);
  let girdi;
  try {
    girdi = await girdiyiHazirla(foto, inputKopya);
    if (girdi.dondu) {
      log.info(`${id}: yatay fotoğraf saat yönünde 90° döndürüldü → ${girdi.genislik}×${girdi.yukseklik}`);
    }
  } catch (e) {
    // Görsel işlenemiyorsa (bozuk/desteklenmeyen format) ham kopya ile devam et.
    log.warn(`${id}: girdi fotoğrafı işlenemedi (${e.message}) — olduğu gibi kopyalanıyor`);
    fs.copyFileSync(foto, inputKopya);
    girdi = { dondu: false, genislik: null, yukseklik: null };
  }

  const tasks = [];
  for (const p of prompts) {
    for (let n = 1; n <= p.count; n++) {
      const suffix = p.count > 1 ? `-${n}` : '';
      tasks.push({
        id: `${String(p.sira).padStart(2, '0')}-${p.id}${suffix}`,
        promptId: p.id,
        platform: p.platform,
        prompt: p.prompt,
        status: 'pending',
        attempts: 0,
        files: [],
        error: null,
        startedAt: null,
        finishedAt: null,
      });
    }
  }

  const job = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    phone: telefon,
    fakeId: telefon ? null : id.split('-').pop(),
    note: note || null,
    kaynak: kaynakNormalize(kaynak),
    kaynakBilgi: kaynakBilgi || null,
    sourceImage: foto,
    inputImage: inputKopya,
    inputDonduruldu: girdi.dondu,
    inputBoyut: girdi.genislik ? { genislik: girdi.genislik, yukseklik: girdi.yukseklik } : null,
    outputDir,
    status: 'pending',
    tasks,
  };

  jobYaz(job);
  manifestYaz(job);
  return job;
}
