/**
 * Hesap havuzu — çoklu ChatGPT/Gemini hesabı arasında limit-farkındalıklı
 * failover.
 *
 * Neden failover, round-robin değil: her hesabın kullanım limiti **pencere
 * bazlı ve bağımsız** yenileniyor (Codex limit dolunca `resets_at` veriyor).
 * İşleri hesaplara eşit dağıtmak (round-robin) hepsini aynı pencerede aynı
 * anda doldurup birlikte kilitler. Bunun yerine bir hesabı sonuna kadar
 * kullan, dolunca `resets_at`'e göre dinlenmeye al, sıradaki taze hesaba geç —
 * ilk hesabın penceresi sen ötekileri tüketirken zaten yenilenmeye başlar.
 *
 * Model: her hesap `concurrency` kadar eşzamanlı slot taşır. `kirala()` failover
 * sırasıyla (listedeki ilk uygun hesap) boş slot verir; bir task limite
 * çarpınca `dinlenmeyeAl()` o hesabı kapatır, worker başka hesap kiralar. Tüm
 * hesaplar dinlenmedeyse task bekler (kaybolmaz), `enErkenAcilis()` ne kadar
 * bekleneceğini söyler.
 *
 * Cooldown diske yazılır (`jobs/.havuz.json`): panel yeniden başlasa da bir
 * hesabın "şu saate kadar dinlenmede" bilgisi kaybolmaz, boşuna limit yenmez.
 */
import fs from 'node:fs';
import path from 'node:path';
import { JOBS_DIR } from './paths.js';

const DURUM_DOSYASI = path.join(JOBS_DIR, '.havuz.json');

// platformAdi → { hesapAdi → { slot, dinlenmeSonu, sonHata } }
const durum = new Map();

function diskeYaz() {
  // Yalnız cooldown kalıcı olmalı; slot runtime bilgisi (süreçle ölür).
  const kalici = {};
  for (const [platform, hesaplar] of durum) {
    for (const [ad, h] of Object.entries(hesaplar)) {
      if (h.dinlenmeSonu && h.dinlenmeSonu > Date.now()) {
        (kalici[platform] ??= {})[ad] = { dinlenmeSonu: h.dinlenmeSonu, sonHata: h.sonHata || null };
      }
    }
  }
  try {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
    fs.writeFileSync(DURUM_DOSYASI, JSON.stringify(kalici, null, 2));
  } catch {
    /* diske yazılamıyorsa cooldown yalnız bu süreç için geçerli olur */
  }
}

function diskeGeriYukle() {
  let ham = {};
  try {
    ham = JSON.parse(fs.readFileSync(DURUM_DOSYASI, 'utf8'));
  } catch {
    return;
  }
  for (const [platform, hesaplar] of Object.entries(ham)) {
    for (const [ad, h] of Object.entries(hesaplar)) {
      if (h.dinlenmeSonu && h.dinlenmeSonu > Date.now()) {
        hesapDurumu(platform, ad).dinlenmeSonu = h.dinlenmeSonu;
        hesapDurumu(platform, ad).sonHata = h.sonHata || null;
      }
    }
  }
}

function hesapDurumu(platformAdi, hesapAdi) {
  if (!durum.has(platformAdi)) durum.set(platformAdi, {});
  const p = durum.get(platformAdi);
  if (!p[hesapAdi]) p[hesapAdi] = { slot: 0, dinlenmeSonu: null, sonHata: null };
  return p[hesapAdi];
}

function dinlenmedeMi(d) {
  if (!d.dinlenmeSonu) return false;
  if (d.dinlenmeSonu <= Date.now()) {
    // Pencere doldu: hesap yeniden uygun, damga temizlenir.
    d.dinlenmeSonu = null;
    d.sonHata = null;
    return false;
  }
  return true;
}

function kiralanabilir(platformAdi, h) {
  const d = hesapDurumu(platformAdi, h.ad);
  if (h.aktif === false || dinlenmedeMi(d)) return null;
  const kapasite = Math.max(1, Number(h.concurrency) || 1);
  if (d.slot >= kapasite) return null;
  return d;
}

/**
 * Failover sırasıyla uygun ilk hesabı kiralar (slot++). Yoksa null.
 *
 * `yedek: true` hesaplar (fal) ancak asıl hesapların HİÇBİRİ kullanılabilir
 * değilken (hepsi dinlenmede/pasif) devreye girer — asıl hesapların slotları
 * yalnızca dolu ise beklenir, yedeğe kaçılmaz (fal ücretli).
 * @param {Array<{ad, concurrency, aktif?, yedek?}>} hesaplar sıralı hesap listesi
 */
export function kirala(platformAdi, hesaplar) {
  const asil = hesaplar.filter((h) => !h.yedek);
  for (const h of asil) {
    const d = kiralanabilir(platformAdi, h);
    if (!d) continue;
    // Rotasyonlu hesaplar (web): "birini sonuna kadar kullan" yerine
    // uygun olanlar arasında en uzun süredir boşta durana ver — kayan
    // pencere limitleri iki hesapta dengeli dolsun.
    if (h.rotasyon) {
      const adaylar = asil
        .filter((x) => x.rotasyon)
        .map((x) => ({ hesap: x, d: kiralanabilir(platformAdi, x) }))
        .filter((a) => a.d)
        .sort((a, b) => (a.d.sonKullanim || 0) - (b.d.sonKullanim || 0));
      const secim = adaylar[0];
      secim.d.slot += 1;
      secim.d.sonKullanim = Date.now();
      return secim.hesap;
    }
    d.slot += 1;
    d.sonKullanim = Date.now();
    return h;
  }
  const asilUygunVar = asil.some(
    (h) => h.aktif !== false && !dinlenmedeMi(hesapDurumu(platformAdi, h.ad))
  );
  if (asilUygunVar) return null; // asıl hesap var ama slotları dolu — bekle
  for (const h of hesaplar.filter((x) => x.yedek)) {
    const d = kiralanabilir(platformAdi, h);
    if (d) {
      d.slot += 1;
      return h;
    }
  }
  return null;
}

export function birak(platformAdi, hesapAdi) {
  const d = hesapDurumu(platformAdi, hesapAdi);
  d.slot = Math.max(0, d.slot - 1);
}

/** Hesabı `resetsAt` (ms epoch) zamanına kadar dinlenmeye alır. */
export function dinlenmeyeAl(platformAdi, hesapAdi, resetsAt, sonHata) {
  const d = hesapDurumu(platformAdi, hesapAdi);
  // Reset okunamadıysa (null) muhafazakâr bir varsayılan: 1 saat.
  d.dinlenmeSonu = resetsAt && resetsAt > Date.now() ? resetsAt : Date.now() + 60 * 60 * 1000;
  d.sonHata = sonHata || null;
  diskeYaz();
}

/**
 * Tüm hesaplar dinlenmedeyse en erken açılış zamanı (ms), uygun hesap varsa
 * null. Pasif hesaplar kendiliğinden açılmaz — hepsi pasifse (veya liste
 * boşsa) `Infinity` döner: bekleyerek çözülmez, kullanıcı aksiyonu gerekir.
 */
export function enErkenAcilis(platformAdi, hesaplar) {
  let enErken = Infinity;
  for (const h of hesaplar) {
    if (h.aktif === false) continue;
    const d = hesapDurumu(platformAdi, h.ad);
    if (!dinlenmedeMi(d)) return null; // uygun hesap var, beklemeye gerek yok
    if (d.dinlenmeSonu < enErken) enErken = d.dinlenmeSonu;
  }
  return enErken;
}

/**
 * Hesabın dinlenmesini elle kaldırır — başarılı "Sına" çağırır. Limit
 * tespiti sezgisel olduğu için (geçici 500'ler kota sanılabiliyor) kullanıcıya
 * bir serbest bırakma vanası gerekir; hesap gerçekten limitliyse ilk üretim
 * denemesi cezayı yeniden koyar (kendini düzeltir).
 */
export function dinlenmeyiKaldir(platformAdi, hesapAdi) {
  const d = hesapDurumu(platformAdi, hesapAdi);
  const vardi = Boolean(d.dinlenmeSonu);
  d.dinlenmeSonu = null;
  d.sonHata = null;
  if (vardi) diskeYaz();
  return vardi;
}

/** O platformda şu an kiralanabilir (dinlenmede olmayan) hesap var mı? */
export function uygunHesapVar(platformAdi, hesaplar) {
  return enErkenAcilis(platformAdi, hesaplar) === null;
}

/** Panel için: her hesabın anlık durumu. */
export function havuzOzeti(platformAdi, hesaplar) {
  return hesaplar.map((h) => {
    const d = hesapDurumu(platformAdi, h.ad);
    const dinlenmede = dinlenmedeMi(d);
    return {
      ad: h.ad,
      aktif: h.aktif !== false,
      aktifSlot: d.slot,
      kapasite: Math.max(1, Number(h.concurrency) || 1),
      dinlenmede,
      dinlenmeSonu: dinlenmede ? d.dinlenmeSonu : null,
      sonHata: dinlenmede ? d.sonHata : null,
    };
  });
}

diskeGeriYukle();
