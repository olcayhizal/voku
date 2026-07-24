/**
 * Panel erişimi — sahip / misafir.
 *
 * Panel yerelde kimlik doğrulamasız çalışır (kendi makinen, 127.0.0.1).
 * Bir tünelin (ngrok, Cloudflare, ssh -R) arkasına konduğunda ise iş silen,
 * prompt değiştiren, hatta senin makinende Finder/Chrome açtıran uçlar
 * dışarıya açılmış olur. Bu yüzden koruma **panelin kendisinde** durur,
 * tünel sağlayıcısında değil: tünel değişse de kural aynı kalır.
 *
 * Roller:
 *   sahip   — her şeyi yapar. Yerel (loopback, proxy başlığı olmayan) istekler
 *             ve sahip anahtarıyla gelenler.
 *   misafir — yalnız okur. Kuyruk, kareler, ışık kutusu görünür; yazan her
 *             uç (POST/PUT/DELETE) 403 döner.
 *   yok     — anahtarsız uzak istek; 401.
 *
 * Anahtarlar `config/erisim.json` içinde tutulur (git dışı). Dosya yoksa
 * ilk açılışta üretilir — panel korumasız açılmasın diye.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG_DIR } from './paths.js';
import { log } from './logger.js';

const DOSYA = path.join(CONFIG_DIR, 'erisim.json');

export function erisimAyarlariniYukle() {
  let ham = {};
  if (fs.existsSync(DOSYA)) {
    try {
      ham = JSON.parse(fs.readFileSync(DOSYA, 'utf8'));
    } catch (e) {
      log.warn(`erisim.json okunamadı (${e.message}) — yeni anahtar üretiliyor.`);
    }
  }
  const s = {
    // Yerel istekler anahtarsız sahiptir; kapatmak istersen false yap.
    yerelSahip: ham.yerelSahip !== false,
    misafirToken: ham.misafirToken || crypto.randomBytes(16).toString('hex'),
    // Sahip anahtarı isteğe bağlı: uzaktan tam yetkiyle girmek istersen doldur.
    sahipToken: ham.sahipToken || null,
  };
  if (!fs.existsSync(DOSYA) || !ham.misafirToken) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(DOSYA, JSON.stringify(s, null, 2) + '\n');
  }
  return s;
}

/** Misafir anahtarını yeniler — paylaşılan bağlantı sızarsa bu tek adım yeter. */
export function misafirAnahtariniYenile() {
  const s = erisimAyarlariniYukle();
  s.misafirToken = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(DOSYA, JSON.stringify(s, null, 2) + '\n');
  return s.misafirToken;
}

function cerezOku(req, ad) {
  const ham = req.headers.cookie;
  if (!ham) return null;
  for (const parca of ham.split(';')) {
    const [k, ...v] = parca.trim().split('=');
    if (k === ad) return decodeURIComponent(v.join('='));
  }
  return null;
}

/**
 * İstek gerçekten bu makineden mi geliyor?
 * Loopback yetmez: tünel ajanı da 127.0.0.1'den bağlanır. Ama proxy'ler
 * `x-forwarded-for` ekler — o başlık varsa istek dışarıdan gelmiştir.
 */
function yerelMi(req) {
  if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['forwarded']) {
    return false;
  }
  const adres = req.socket?.remoteAddress || '';
  return adres === '127.0.0.1' || adres === '::1' || adres === '::ffff:127.0.0.1';
}

export const COOKIE_ADI = 'voku_anahtar';

/** İsteğin rolünü belirler: 'sahip' | 'misafir' | null */
export function roluBelirle(req, url, erisim) {
  if (erisim.yerelSahip && yerelMi(req)) return 'sahip';
  const anahtar = url.searchParams.get('anahtar') || cerezOku(req, COOKIE_ADI);
  if (!anahtar) return null;
  if (erisim.sahipToken && anahtar === erisim.sahipToken) return 'sahip';
  if (erisim.misafirToken && anahtar === erisim.misafirToken) return 'misafir';
  return null;
}

/** Adresteki anahtarı çereze taşır — sonraki isteklerde bağlantı çıplak kalsın. */
export function cerezKur(res, anahtar) {
  res.setHeader(
    'set-cookie',
    `${COOKIE_ADI}=${encodeURIComponent(anahtar)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`
  );
}

export const KAPI_SAYFASI = `<!doctype html>
<html lang="tr"><head><meta charset="utf-8" />
<title>voku — kapalı hat</title>
<style>
  body { background:#0e1216; color:#ede8de; font:14px -apple-system, system-ui, sans-serif;
         display:grid; place-items:center; height:100vh; margin:0; }
  div { text-align:center; max-width:34ch; }
  b { display:block; font-size:19px; letter-spacing:.08em; text-transform:uppercase; margin-bottom:10px; }
  p { color:#98a4ad; line-height:1.6; }
</style></head>
<body><div><b>voku</b><p>Bu panel kapalı bir hattır. Erişim için sana verilen anahtarlı bağlantıyı kullan.</p></div></body></html>`;
