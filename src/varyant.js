/**
 * Çıktı varyantları: her job klasöründe üç alt klasör.
 *
 *   uretim/  ham üretim (adapter'ların yazdığı dosyalar)
 *   demo/    müşteriye gösterilecek damgalı hal (çapraz "DEMO", %20 opaklık)
 *   baski/   baskıya hazırlanmış hal (kapsam sonra tanımlanacak)
 *
 * Dosya adları üç klasörde de AYNIdır — `task.files` yalnız dosya adını
 * tutar, varyant klasörü ayrı bir boyuttur. Böylece bir görselin üç hali
 * tek isimle takip edilir.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { ROOT } from './paths.js';

export const VARYANTLAR = ['uretim', 'demo', 'baski'];

/**
 * Baskı şablonları: her ikisi de dikey tuval (898×1181); fark logo yönünde.
 * - dikey.png  → "VOKU" altta yatay okunur (girdi zaten dikeydi)
 * - yatay.png  → "VOKU" sol kenarda dik; ürün çevrilince okunur
 *                (girdi yataydı, job açılırken döndürülmüştü)
 */
/**
 * Baskı tuvali (piksel). Epson en-boy oranını koruduğu için baskı genişliği
 * doğrudan bu orandan doğuyor: yükseklik 100,79 mm'ye ayarlanınca
 * 899/1181 oranı 76,72 mm veriyor → Epson ekranında **76,7 × 100,8**.
 * (898 px ile 76,64 çıkıp ekranda 76,6 görünüyordu.)
 */
export const BASKI_TUVALI = [899, 1181];

const BASKI_SABLONLARI = {
  dikey: path.join(ROOT, 'assets', 'baski', 'dikey.png'),
  yatay: path.join(ROOT, 'assets', 'baski', 'yatay.png'),
};
export const VARYANT_ETIKET = { uretim: 'Üretim', demo: 'Demo', baski: 'Baskı' };

export function varyantDizini(job, varyant = 'uretim') {
  if (!VARYANTLAR.includes(varyant)) throw new Error(`Bilinmeyen varyant: ${varyant}`);
  return path.join(job.outputDir, varyant);
}

export function varyantlariHazirla(outputDir) {
  for (const v of VARYANTLAR) fs.mkdirSync(path.join(outputDir, v), { recursive: true });
}

/** Çapraz, tekrarlı DEMO damgası (SVG). Boyut görsele göre ölçeklenir. */
function damgaSvg(genislik, yukseklik) {
  const yazi = Math.max(18, Math.round(Math.min(genislik, yukseklik) / 9));
  const adimX = Math.round(yazi * 6.2);
  const adimY = Math.round(yazi * 3.4);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${genislik}" height="${yukseklik}">
  <defs>
    <pattern id="damga" width="${adimX}" height="${adimY}" patternUnits="userSpaceOnUse"
             patternTransform="rotate(-32)">
      <text x="0" y="${yazi}" font-family="Helvetica, Arial, sans-serif"
            font-size="${yazi}" font-weight="700" letter-spacing="${Math.round(yazi * 0.18)}"
            fill="#ffffff" fill-opacity="0.2"
            stroke="#000000" stroke-opacity="0.08" stroke-width="${Math.max(1, yazi / 26)}">DEMO</text>
    </pattern>
  </defs>
  <rect width="100%" height="100%" fill="url(#damga)"/>
</svg>`;
}

/**
 * Panel önizlemeleri: kontak baskısı ve film şeridi ham PNG yüklemesin.
 *
 * Kare başına birkaç MB'lık PNG yerelde sorun değil ama panel bir tünel
 * üzerinden (ngrok/Cloudflare) dışarı açıldığında hem yavaş hem kotayı
 * yakan bir yük. Önizlemeler jpeg olarak bir kez üretilip job klasöründe
 * `.onizleme/` altında saklanır; kaynak dosya değişirse (watermark temizliği,
 * demo yeniden basımı) tarih damgasından anlaşılır ve yeniden üretilir.
 */
const ONIZLEME_BOYU = { k: 480, o: 1400 };

export async function onizlemeYolu(job, varyant, dosya, boy = 'k') {
  const genislik = ONIZLEME_BOYU[boy];
  if (!genislik) throw new Error(`Bilinmeyen önizleme boyu: ${boy}`);
  // 'kok' = job klasörünün kendisi (girdi fotoğrafı) — kuyruk kartındaki
  // 38 px'lik küçük resim için ham telefon fotoğrafı indirilmesin.
  const kaynak =
    varyant === 'kok'
      ? path.join(job.outputDir, dosya)
      : path.join(varyantDizini(job, varyant), dosya);
  if (!fs.existsSync(kaynak)) throw new Error(`Dosya yok: ${dosya}`);

  const klasor = path.join(job.outputDir, '.onizleme');
  const hedef = path.join(klasor, `${varyant}-${boy}-${dosya.replace(/\.\w+$/, '')}.jpg`);
  const kaynakZaman = fs.statSync(kaynak).mtimeMs;
  if (fs.existsSync(hedef) && fs.statSync(hedef).mtimeMs >= kaynakZaman) return hedef;

  fs.mkdirSync(klasor, { recursive: true });
  await sharp(kaynak)
    .resize({ width: genislik, height: genislik, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: boy === 'k' ? 78 : 86 })
    .toFile(hedef);
  return hedef;
}

/** Üretim görselinden damgalı demo hali üretir. */
export async function demoUret(kaynakYol, hedefYol) {
  const gorsel = sharp(kaynakYol);
  const { width, height } = await gorsel.metadata();
  if (!width || !height) throw new Error('Görsel boyutu okunamadı.');
  fs.mkdirSync(path.dirname(hedefYol), { recursive: true });
  await gorsel
    .composite([{ input: Buffer.from(damgaSvg(width, height)), top: 0, left: 0 }])
    .toFile(hedefYol);
  return hedefYol;
}

/**
 * Baskıya hazır hal: şablon tuvaline oturtulmuş, logolu, aynalanmış çıktı.
 *
 * 1. Üretim görseli şablon tuvaline **cover** ile yerleşir — en-boy oranı
 *    korunur (eğilme/büzülme yok), taşan kısım kırpılır (boşluk kalmaz).
 *    Kırpma merkezden (`centre`): seri baskılarda kadrajın işten işe aynı
 *    kalması, içerik odaklı `attention` kırpmasına tercih edildi.
 * 2. Şablon (VOKU logosu) üstüne bindirilir.
 * 3. Transfer baskı için ayna alınır; eksen ürünün yönüne göre değişir:
 *    - dikey iş  → dikey eksende yansıma (sol ↔ sağ)
 *    - döndürülmüş (yatay) iş → yatay eksende yansıma (üst ↔ alt)
 *
 * Kaynak **üretim** klasörüdür; demo damgası baskıya karışmaz.
 */
export async function baskiUret(kaynakYol, hedefYol, { dondurulmus = false, kirpma = 'centre' } = {}) {
  const sablonYolu = BASKI_SABLONLARI[dondurulmus ? 'yatay' : 'dikey'];
  if (!fs.existsSync(sablonYolu)) {
    throw new Error(`Baskı şablonu yok: ${path.relative(ROOT, sablonYolu)}`);
  }
  const sablon = await sharp(sablonYolu).toBuffer();
  const sablonBilgi = await sharp(sablonYolu).metadata();

  // Tuval boyutu baskı ölçüsünü belirler: Epson en-boy oranını koruduğu için
  // yükseklik 100,8 mm'ye ayarlandığında genişlik doğrudan bu orandan çıkıyor.
  // 898 px → 76,64 (ekranda 76,6), 899 px → 76,72 (ekranda 76,7 ✓).
  // Şablon 898 px; 1 px fark logoyu görünür biçimde kaydırmaz.
  const [width, height] = BASKI_TUVALI;

  const zemin = await sharp(kaynakYol)
    .resize(width, height, { fit: 'cover', position: kirpma })
    .toBuffer();

  const sablonKatman =
    sablonBilgi.width === width && sablonBilgi.height === height
      ? sablon
      : await sharp(sablon)
          .resize(width, height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .toBuffer();

  // DİKKAT: sharp işlemleri çağrı sırasına göre değil, sabit bir boru hattı
  // sırasına göre uygular — composite, flip/flop'tan SONRA gelir. Aynı zincirde
  // yazılırsa ayna yalnız zemine işler, logo düz kalır. Bu yüzden birleştirme
  // önce buffer'a alınır, ayna ayrı bir aşamada uygulanır.
  const birlesikBuf = await sharp(zemin)
    .composite([{ input: sablonKatman, top: 0, left: 0 }])
    .png()
    .toBuffer();

  const son = sharp(birlesikBuf);
  fs.mkdirSync(path.dirname(hedefYol), { recursive: true });
  await (dondurulmus ? son.flip() : son.flop()).png().toFile(hedefYol);
  return hedefYol;
}

/**
 * Bir task'ın üretim dosyalarından eksik varyantları tamamlar:
 * demo (damgalı) ve baski (şablonlu + aynalı).
 */
export async function taskVaryantlariniUret(job, task, { yenidenUret = false } = {}) {
  const uretilen = [];
  for (const dosya of task.files || []) {
    const kaynak = path.join(varyantDizini(job, 'uretim'), dosya);
    if (!fs.existsSync(kaynak)) continue;

    const demoHedef = path.join(varyantDizini(job, 'demo'), dosya);
    if (yenidenUret || !fs.existsSync(demoHedef)) {
      await demoUret(kaynak, demoHedef);
      uretilen.push(`demo/${dosya}`);
    }

    const baskiHedef = path.join(varyantDizini(job, 'baski'), dosya);
    if (yenidenUret || !fs.existsSync(baskiHedef)) {
      await baskiUret(kaynak, baskiHedef, { dondurulmus: Boolean(job.inputDonduruldu) });
      uretilen.push(`baski/${dosya}`);
    }
  }
  return uretilen;
}

/**
 * Eski düz yapıyı (görseller job kökünde) uretim/ altına taşır.
 * input.* ve manifest.json kökte kalır.
 */
export function uretimeTasi(job) {
  const kok = job.outputDir;
  if (!fs.existsSync(kok)) return 0;
  varyantlariHazirla(kok);
  let tasinan = 0;
  for (const giris of fs.readdirSync(kok, { withFileTypes: true })) {
    if (giris.isDirectory()) continue;
    if (!/\.(png|jpe?g|webp)$/i.test(giris.name)) continue;
    if (/^input\./i.test(giris.name)) continue;
    fs.renameSync(path.join(kok, giris.name), path.join(kok, 'uretim', giris.name));
    tasinan++;
  }
  return tasinan;
}

/**
 * Girdi fotoğrafını job klasörüne hazırlar.
 * Önce EXIF yönü uygulanır (telefon fotoğrafları çoğu zaman dönük saklanır),
 * sonra kare/dikey hale getirilir: **yatay görsel (genişlik > yükseklik)
 * saat yönünde 90° döndürülür.** Üretim böylece hep dikey çerçeveden başlar.
 *
 * @returns {Promise<{dondu: boolean, genislik: number, yukseklik: number}>}
 */
export async function girdiyiHazirla(kaynakYol, hedefYol) {
  const { data, info } = await sharp(kaynakYol)
    .rotate() // EXIF orientation
    .toBuffer({ resolveWithObject: true });

  if (info.width <= info.height) {
    fs.writeFileSync(hedefYol, data);
    return { dondu: false, genislik: info.width, yukseklik: info.height };
  }

  const cikti = await sharp(data).rotate(90).toBuffer({ resolveWithObject: true });
  fs.writeFileSync(hedefYol, cikti.data);
  return { dondu: true, genislik: cikti.info.width, yukseklik: cikti.info.height };
}

/** Bir task'ın hangi varyantlarda dosyası hazır? (panel kareleri için) */
export function taskVaryantDurumu(job, task) {
  const durum = {};
  for (const v of VARYANTLAR) {
    durum[v] =
      (task.files || []).length > 0 &&
      task.files.every((d) => fs.existsSync(path.join(job.outputDir, v, d)));
  }
  return durum;
}

/** Panelin sekmeleri için: hangi varyantta kaç dosya var. */
export function varyantSayilari(job) {
  const sayim = {};
  for (const v of VARYANTLAR) {
    const dizin = path.join(job.outputDir, v);
    sayim[v] = fs.existsSync(dizin)
      ? fs.readdirSync(dizin).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).length
      : 0;
  }
  return sayim;
}
