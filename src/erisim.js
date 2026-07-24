/**
 * Panel erişimi — anahtar kapısı.
 *
 * Panel yerelde kimlik doğrulamasız çalışır (kendi makinen, 127.0.0.1).
 * Bir tünelin (ngrok, Cloudflare, ssh -R) arkasına konduğunda ise dışarıdan
 * gelen her istek **anahtar** ister; anahtarsız istek 401 alır ve kapı
 * sayfasını görür. Koruma tünel sağlayıcısında değil panelin kendisinde
 * durur: tünel değişse de kural aynı kalır.
 *
 * Anahtarla giren paneli **tam yetkiyle** kullanır — bağlantı ekip
 * arkadaşlarıyla paylaşılıyor, onlar da iş açıp yürütüyor. Yani anahtarı
 * paylaşmak paneli paylaşmaktır; sızarsa `cli baglanti --yenile` ile
 * anahtar değiştirilir.
 *
 * Anahtar `config/erisim.json` içinde tutulur (git dışı). Dosya yoksa ilk
 * açılışta üretilir — panel korumasız açılmasın diye.
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
    // Yerel istekler anahtarsız girer; kapatmak istersen false yap.
    yerelSahip: ham.yerelSahip !== false,
    // Alan adı eski kurulumlarla uyumlu kalsın: paylaşılmış bağlantılardaki
    // anahtar değişmesin diye `misafirToken` okunmaya devam eder.
    erisimToken:
      ham.erisimToken || ham.misafirToken || crypto.randomBytes(16).toString('hex'),
  };
  s.misafirToken = s.erisimToken; // geriye dönük ad
  if (!fs.existsSync(DOSYA) || !(ham.erisimToken || ham.misafirToken)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(DOSYA, JSON.stringify(s, null, 2) + '\n');
  }
  return s;
}

/** Anahtarı yeniler — paylaşılan bağlantı sızarsa bu tek adım yeter. */
export function anahtariYenile() {
  const s = erisimAyarlariniYukle();
  s.erisimToken = crypto.randomBytes(16).toString('hex');
  s.misafirToken = s.erisimToken;
  fs.writeFileSync(DOSYA, JSON.stringify(s, null, 2) + '\n');
  return s.erisimToken;
}

/** Eski ad — betikler ve dış çağrılar kırılmasın. */
export const misafirAnahtariniYenile = anahtariYenile;

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

/**
 * İstek panele girebilir mi? `true` = tam yetki, `false` = 401.
 * Ayrı bir "yalnız görüntüleme" kipi yok: bağlantı ekiple paylaşılıyor.
 */
export function girebilirMi(req, url, erisim) {
  if (erisim.yerelSahip && yerelMi(req)) return true;
  const anahtar = url.searchParams.get('anahtar') || cerezOku(req, COOKIE_ADI);
  if (!anahtar) return false;
  return anahtar === erisim.erisimToken;
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
