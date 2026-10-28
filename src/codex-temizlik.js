/**
 * Codex profil temizliği — hesap başına onlarca GB birikmesin.
 *
 * Codex ürettiği her görseli ÜÇ kez saklar ve kendiliğinden hiç silmez:
 *  - generated_images/<thread>/*.png (ham PNG),
 *  - sessions/YYYY/MM/DD/rollout-*.jsonl (giriş fotoğrafı + çıktı, base64),
 *  - thread_history_N.sqlite (aynı görsel yine base64, imageGeneration öğesi).
 * Voku çıktıyı iş klasörüne zaten kopyalıyor; bunlar kopyadan ibaret.
 * Canlı kurulumda .profiles 121 GB'a çıkmıştı (2026-10-28).
 *
 * Kural: yaşayan sohbetin (bellekteki sohbet havuzu) oturum dosyası ve
 * sqlite satırları korunur, geri kalan her şey yaşına göre silinir. Yanlışlıkla
 * silinen bir oturum zarar vermez: adapter devam edemediği sohbetin yerine
 * yenisini açar (tek seferlik önbellek kaybı). Yalnız voku'nun kendi
 * profillerine (.profiles/<ad>/.codex) dokunulur, kullanıcının ~/.codex'ine değil.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { ROOT } from './paths.js';
import { log } from './logger.js';
import { yasayanSohbetler, bostaykenKilitle } from './adapters/chatgpt-codex.js';

const PROFIL_KOKU = path.join(ROOT, '.profiles');
// Bir Codex turu en çok ~10 dk sürer: 2 saatlik pay süren turun dosyasına
// (henüz havuza yazılmamış ilk tur oturumu dahil) asla dokunmaz.
const YAS_ESIGI = 2 * 60 * 60 * 1000;
const OTURUM_KALIBI = /^rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const GORSEL_KALIBI = /\.(png|jpe?g|webp)$/i;
const SQLITE_KALIBI = /^(thread_history|logs)_\d+\.sqlite$/;

let suren = null;
let sonSonuc = null;
const uyarilanlar = new Set(); // aynı hata her turda log'u doldurmasın

/** Son temizliğin karnesi (debug ucu için). */
export function sonTemizlik() {
  return sonSonuc;
}

/** voku'nun Codex profilleri: .profiles/<ad>/.codex */
function codexKokleri() {
  let adlar;
  try {
    adlar = fs.readdirSync(PROFIL_KOKU);
  } catch {
    return [];
  }
  return adlar
    .map((ad) => path.join(PROFIL_KOKU, ad, '.codex'))
    .filter((d) => fs.existsSync(d));
}

async function* dosyalar(dizin) {
  let girisler;
  try {
    girisler = await fs.promises.readdir(dizin, { withFileTypes: true });
  } catch {
    return;
  }
  for (const g of girisler) {
    const tam = path.join(dizin, g.name);
    if (g.isDirectory()) yield* dosyalar(tam);
    else if (g.isFile()) yield tam;
  }
}

export async function dizinBoyutu(dizin) {
  let bayt = 0;
  let adet = 0;
  for await (const f of dosyalar(dizin)) {
    try {
      bayt += (await fs.promises.stat(f)).size;
      adet += 1;
    } catch {
      /* arada silinmiş */
    }
  }
  return { bayt, adet };
}

/** Eşikten eski ve filtreye uyan dosyaları siler, boşalan alt klasörleri kaldırır. */
async function eskileriSil(dizin, silinsinMi) {
  const sinir = Date.now() - YAS_ESIGI;
  let bayt = 0;
  let adet = 0;
  for await (const f of dosyalar(dizin)) {
    try {
      const st = await fs.promises.stat(f);
      if (st.mtimeMs > sinir || !silinsinMi(path.basename(f))) continue;
      await fs.promises.rm(f, { force: true });
      bayt += st.size;
      adet += 1;
    } catch {
      /* Windows'ta açık dosya silinemez — sonraki tura kalır */
    }
  }
  await bosKlasorleriSil(dizin, sinir, true);
  return { bayt, adet };
}

async function bosKlasorleriSil(dizin, sinir, kok = false) {
  let girisler;
  try {
    girisler = await fs.promises.readdir(dizin, { withFileTypes: true });
  } catch {
    return;
  }
  for (const g of girisler) {
    if (g.isDirectory()) await bosKlasorleriSil(path.join(dizin, g.name), sinir);
  }
  if (kok) return;
  try {
    const st = await fs.promises.stat(dizin);
    // Bugünün klasörüne Codex az sonra yazabilir — taze klasör kalır.
    if (st.mtimeMs <= sinir && !(await fs.promises.readdir(dizin)).length) {
      await fs.promises.rmdir(dizin);
    }
  } catch {
    /* yarış: arada dolmuş/silinmiş */
  }
}

/** Diskte oturum dosyası kalan sohbetler — sqlite'ta yalnız bunlar tutulur. */
async function oturumuOlanlar(home) {
  const kimlikler = new Set();
  for (const alt of ['sessions', 'archived_sessions']) {
    for await (const f of dosyalar(path.join(home, alt))) {
      const m = path.basename(f).match(OTURUM_KALIBI);
      if (m) kimlikler.add(m[1].toLowerCase());
    }
  }
  return kimlikler;
}

/** Ölü sohbet satırlarını siler + VACUUM. Uzun sürebilir: worker'da koşar. */
function sqliteSikistir(dosya, tutulacaklar) {
  return new Promise((coz, reddet) => {
    const isci = new Worker(new URL('./codex-temizlik-isci.js', import.meta.url), {
      workerData: { dosya, tutulacaklar: [...tutulacaklar] },
      execArgv: [], // ana sürecin bayrakları (--input-type vb.) worker'ı düşürmesin
    });
    isci.once('message', (m) => (m.hata ? reddet(new Error(m.hata)) : coz(m)));
    isci.once('error', reddet);
    // Mesajdan sonra gelen çıkış etkisizdir (söz zaten çözüldü).
    isci.once('exit', (kod) => reddet(new Error(`worker mesajsız çıktı (${kod})`)));
  });
}

async function hesabiTemizle(home) {
  const yasayan = new Set([...yasayanSohbetler()].map((k) => k.toLowerCase()));
  const once = await dizinBoyutu(home);
  const gorsel = await eskileriSil(path.join(home, 'generated_images'), (ad) => GORSEL_KALIBI.test(ad));
  const oturumFiltre = (ad) => {
    const m = ad.match(OTURUM_KALIBI);
    return Boolean(m) && !yasayan.has(m[1].toLowerCase());
  };
  const oturum = await eskileriSil(path.join(home, 'sessions'), oturumFiltre);
  const arsiv = await eskileriSil(path.join(home, 'archived_sessions'), oturumFiltre);

  const sonuc = {
    profil: path.basename(path.dirname(home)),
    gorsel: gorsel.adet,
    oturum: oturum.adet + arsiv.adet,
    sqliteSatir: 0,
  };
  const sqlitelar = fs.readdirSync(home).filter((ad) => SQLITE_KALIBI.test(ad));
  if (sqlitelar.length) {
    const tutulacaklar = new Set([...(await oturumuOlanlar(home)), ...yasayan]);
    const kilitli = await bostaykenKilitle(home, async () => {
      let satir = 0;
      for (const ad of sqlitelar) {
        try {
          satir += (await sqliteSikistir(path.join(home, ad), tutulacaklar)).satir;
        } catch (e) {
          sonuc.sqliteHata = e.message;
        }
      }
      return satir;
    });
    if (kilitli === null) sonuc.sqliteErtelendi = true; // üretim sürüyor
    else sonuc.sqliteSatir = kilitli;
  }
  const sonra = await dizinBoyutu(home);
  return { ...sonuc, onceBayt: once.bayt, sonraBayt: sonra.bayt };
}

function gb(bayt) {
  return `${(bayt / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
}

/** Tüm voku Codex profillerini temizler. Aynı anda tek tur koşar. */
export function codexTemizle() {
  if (suren) return suren;
  suren = (async () => {
    const baslangic = Date.now();
    const hesaplar = [];
    for (const home of codexKokleri()) {
      try {
        hesaplar.push(await hesabiTemizle(home));
      } catch (e) {
        hesaplar.push({ profil: path.basename(path.dirname(home)), hata: e.message });
      }
    }
    const once = hesaplar.reduce((t, h) => t + (h.onceBayt || 0), 0);
    const sonra = hesaplar.reduce((t, h) => t + (h.sonraBayt || 0), 0);
    sonSonuc = { zaman: new Date().toISOString(), sureSn: Math.round((Date.now() - baslangic) / 1000), onceBayt: once, sonraBayt: sonra, hesaplar };
    if (once - sonra > 50 * 1024 ** 2) {
      log.info(`Codex disk temizliği: ${gb(once)} → ${gb(sonra)} (${hesaplar.length} profil)`);
    }
    for (const h of hesaplar) {
      const mesaj = h.hata || h.sqliteHata;
      if (mesaj && !uyarilanlar.has(mesaj)) {
        uyarilanlar.add(mesaj);
        log.warn(`Codex temizliği ${h.profil}: ${mesaj}`);
      }
    }
    // Üretim süren hesabın sqlite'ı ertelendi: 3 saati beklemeden 10 dk sonra yine dene.
    if (hesaplar.some((h) => h.sqliteErtelendi)) {
      setTimeout(() => codexTemizle().catch(() => {}), 10 * 60 * 1000).unref?.();
    }
    return sonSonuc;
  })().finally(() => {
    suren = null;
  });
  return suren;
}
