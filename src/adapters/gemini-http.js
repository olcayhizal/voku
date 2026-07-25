/**
 * Gemini — HTTP köprüsü sürücüsü (tarayıcısız).
 *
 * Üretim, yerelde koşan `gemini-web-to-api` servisi üzerinden gider
 * (tools/gemini-web-to-api, Go). Servis Gemini web oturumunu çerezle konuşur;
 * biz OpenAI-uyumlu chat endpoint'ine referans fotoğrafı data URL olarak
 * gönderip base64 görseli geri alırız. Ölçüm: ~20 sn/görsel (tarayıcı
 * sürücüsünün çok üstünde).
 *
 * Oturum: çerezler `.env` içinde (GEMINI_1PSID / GEMINI_1PSIDTS). Panelden
 * "Giriş yap" tarayıcıyı açar, giriş bitince çerezler profilden `.env`'e
 * senkronlanır (bkz. cerezleriSenkronla).
 *
 * NOT: köprü resmi değil; Google ToS gri alanı ve upstream'in "ticari kullanım
 * yasak" maddesi geçerli. Bilinçli tercih olmadan varsayılan yapılmaz.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from '../paths.js';
import { calistirilabilir, portTutaniOldur } from '../platform.js';
import { log } from '../logger.js';

export const ad = 'gemini-http';
export const tarayiciGerekli = false;
/** Giriş yine tarayıcıda yapılır (Google oturumu), sonra çerez senkronu koşar. */
export const girisTipi = 'tarayici';

const SERVIS_DIZINI = path.join(ROOT, 'tools', 'gemini-web-to-api');
const SERVIS_BINARY = path.join(ROOT, 'tools', calistirilabilir('gemini-api-server'));
const ENV_DOSYASI = path.join(SERVIS_DIZINI, '.env');
const GWR = path.join(ROOT, 'tools', 'gwr', 'bin', 'gwr.mjs');

// Çoklu hesap: her hesap ayrı portta ayrı köprü sürecidir. port → süreç.
const koprular = new Map();

/** Bir hesabın portu (tek hesapta baseUrl'den, çokluda hesap.port). */
function portu(platform, hesap) {
  if (hesap?.port) return String(hesap.port);
  try {
    return new URL((platform?.baseUrl || 'http://127.0.0.1:4981')).port || '4981';
  } catch {
    return '4981';
  }
}

function taban(platform, hesap) {
  return `http://127.0.0.1:${portu(platform, hesap)}`;
}

/** Bir hesabın .env yolu: tek hesapta düz `.env`, çokluda `.env.<envAdi>`. */
function envYolu(hesap) {
  return hesap?.envAdi ? path.join(SERVIS_DIZINI, `.env.${hesap.envAdi}`) : ENV_DOSYASI;
}

async function saglikli(port, timeoutMs = 2500) {
  try {
    const yanit = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return yanit.ok;
  } catch {
    return false;
  }
}

/**
 * Köprünün Gemini'ye GERÇEKTEN bağlı olduğunu kanıtlar: model listesi.
 * `/health` yalnız sürecin ayakta olduğunu söyler — çerez çürükse köprü
 * ayaktadır ama model listesi boş gelir ve üretim "Available models: []"
 * ile patlar. Bu yüzden hazırlık model listesinin DOLMASINI bekler.
 */
async function modelListesi(port, timeoutMs = 2500) {
  try {
    const yanit = await fetch(`http://127.0.0.1:${port}/openai/v1/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!yanit.ok) return [];
    const j = await yanit.json();
    return Array.isArray(j.data) ? j.data : [];
  } catch {
    return [];
  }
}

/** `.env` dosyasını okuyup GEMINI_* değişkenlerini env objesine çıkarır. */
function envDegiskenleri(dosya) {
  const cikti = {};
  if (!fs.existsSync(dosya)) return cikti;
  for (const satir of fs.readFileSync(dosya, 'utf8').split('\n')) {
    const m = satir.match(/^\s*(GEMINI_[A-Z0-9_]+)\s*=\s*(.*)$/);
    // Yalnız DOLU değerleri al: boş değer OS env'e set olup köprünün
    // .env'deki dolu değerini gölgeleyebiliyor.
    if (m && m[2].trim()) cikti[m[1]] = m[2].trim();
  }
  return cikti;
}

/**
 * Portu yeni köprü için boşaltır. Eski/geçersiz köprü (map'te ya da panel
 * restart'tan kalan zombi) portu tutuyorsa yeni bind "address already in use"
 * alır ve eski köprü (eski çerezle) çalışmaya devam eder — çerez güncellense
 * bile "cookies invalid" görülür. Bu yüzden önce kesin boşaltılır.
 */
async function portuBosalt(port) {
  const eski = koprular.get(port);
  if (eski) {
    eski.kill('SIGTERM');
    koprular.delete(port);
  }
  // Health düşene (port boş) kadar bekle; düşmezse portu tutanı zorla kapat.
  for (let i = 0; i < 16; i++) {
    if (!(await saglikli(port))) return;
    if (i === 4) portTutaniOldur(port); // birkaç deneme sonra zorla
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Bir hesabın köprü servisini o hesabın portunda başlatır, sağlıklı olana dek bekler. */
async function servisiBaslat(platform, hesap) {
  const port = portu(platform, hesap);
  // Zaten çalışan köprü: yalnız ayakta değil, Gemini'ye bağlı da olmalı.
  if (koprular.has(port) && (await saglikli(port)) && (await modelListesi(port)).length) return;

  // Sağlıklı değilse (eski çerez) ya da başka süreç tutuyorsa portu boşalt.
  await portuBosalt(port);

  if (!fs.existsSync(SERVIS_BINARY)) {
    throw new Error(
      `Gemini köprüsü derlenmemiş. scripts/motorlari-kur (Windows: .cmd, macOS: .command) ile kur.`
    );
  }
  const env = envYolu(hesap);
  if (!fs.existsSync(env)) {
    throw new Error(
      `Gemini köprüsünün .env dosyası yok (${path.basename(env)}). Panelden "${hesap?.ad || 'Gemini'}" için "Giriş yap" ile oturumu aç.`
    );
  }

  const cerezEnv = envDegiskenleri(env);
  // Teşhis: çerezlerin köprüye gerçekten enjekte edildiğini uzunlukla göster
  // (değerin kendini değil). PSIDTS=0b ise .env'e yazılmamış demektir.
  log.info(
    `[gemini-http] köprü başlatılıyor — ${hesap?.ad || 'varsayılan'} (:${port}) ` +
      `[PSID=${(cerezEnv.GEMINI_1PSID || '').length}b PSIDTS=${(cerezEnv.GEMINI_1PSIDTS || '').length}b]`
  );
  // Köprü cwd'deki düz `.env`'i de okuyabildiği için (godotenv), o dosya
  // varsa YANLIŞ hesabın eski çerezini yükleyip bizim enjeksiyonu
  // gölgeleyebilir. Köprü env'inde GEMINI_COOKIES'i de temizle ki karışmasın.
  const temizProcessEnv = { ...process.env };
  delete temizProcessEnv.GEMINI_1PSID;
  delete temizProcessEnv.GEMINI_1PSIDTS;
  delete temizProcessEnv.GEMINI_COOKIES;
  const surec = spawn(SERVIS_BINARY, [], {
    cwd: SERVIS_DIZINI,
    env: { ...temizProcessEnv, ...cerezEnv, PORT: port },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  koprular.set(port, surec);
  surec.stdout.on('data', () => {});
  surec.stderr.on('data', (d) => log.warn(`[gemini-http:${port}] ${String(d).trim().slice(0, 200)}`));
  surec.on('close', () => {
    if (koprular.get(port) === surec) koprular.delete(port);
  });

  // 1) Süreç ayağa kalksın (/health).
  let ayakta = false;
  for (let i = 0; i < 40; i++) {
    if (await saglikli(port)) { ayakta = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ayakta) {
    throw new Error(`Gemini köprüsü :${port} 20 sn içinde ayağa kalkmadı — ${path.basename(env)} çerezlerine bak.`);
  }

  // 2) Gemini'ye bağlansın (model listesi dolsun). Çerez çürükse liste boş
  //    kalır — hazırlık burada BAŞARISIZ olur, runner hesabı dinlenmeye alıp
  //    başka hesaba geçer. Böylece "Sına" da gerçeği söyler, üretim sürpriz
  //    "Available models: []" görmez.
  for (let i = 0; i < 30; i++) {
    if ((await modelListesi(port)).length) {
      log.ok(`[gemini-http] köprü hazır (:${port}) — ${hesap?.ad || 'varsayılan'}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const e = new Error(
    `Gemini "${hesap?.ad || 'varsayılan'}" oturumu geçersiz: köprü ayakta ama model listesi boş (çerezler ölmüş). Panelden bu hesaba yeniden giriş yap.`
  );
  e.limitDolu = true; // runner failover'a soksun (başka hesaba geç)
  e.sebep = 'oturum';
  e.resetsAt = Date.now() + 30 * 60 * 1000;
  throw e;
}

/** Tüm köprü süreçlerini kapatır (panel kapanışında). */
export function koprulariDurdur() {
  for (const surec of koprular.values()) surec.kill('SIGTERM');
  koprular.clear();
}

/**
 * Gemini tarayıcı profilindeki oturum çerezlerini köprünün .env'ine yazar.
 * Panel "Giriş yap" akışını tamamladığında çağrılır.
 */
export async function cerezleriSenkronla(cerezler, platform, hesap) {
  const bul = (isim) => cerezler.find((c) => c.name === isim)?.value || null;
  const psid = bul('__Secure-1PSID');
  const psidts = bul('__Secure-1PSIDTS');

  if (!psid) {
    const google = cerezler.filter((c) => /google/.test(c.domain || '')).map((c) => c.name);
    throw new Error(
      `Gemini oturumu bulunamadı (__Secure-1PSID yok). Tarayıcıda gemini.google.com'a giriş yapıldığından emin ol. Görülen Google çerezleri: ${google.slice(0, 8).join(', ') || 'hiç'}`
    );
  }
  if (!psidts) {
    // PSID var ama PSIDTS yok: çerez henüz olgunlaşmamış. Eski/boş PSIDTS'i
    // .env'e YAZMA (köprü geçersiz görür) — kullanıcı biraz bekleyip yenilesin.
    throw new Error(
      '__Secure-1PSIDTS çerezi henüz oluşmamış. Açılan Gemini sekmesinde birkaç saniye bekle (bir mesaj yazıp gönder), SONRA "Girişi tamamladım"a bas. Tek Google hesabıyla giriş yaptığından emin ol.'
    );
  }
  log.info(`[gemini-http] çerez alındı — ${hesap?.ad || 'varsayılan'}: PSID+PSIDTS var`);

  const dosya = envYolu(hesap);
  let icerik = fs.existsSync(dosya)
    ? fs.readFileSync(dosya, 'utf8')
    : fs.readFileSync(path.join(SERVIS_DIZINI, '.env.example'), 'utf8');
  const port = portu(platform, hesap);
  // Satır varsa değiştir, yoksa EKLE — aksi halde .env'de ilgili satır yoksa
  // replace sessizce boş geçip çerez yazılmamış olur ("cookies invalid").
  const ayarla = (metin, anahtar, deger) =>
    new RegExp(`^${anahtar}=.*$`, 'm').test(metin)
      ? metin.replace(new RegExp(`^${anahtar}=.*$`, 'm'), `${anahtar}=${deger}`)
      : `${metin.trimEnd()}\n${anahtar}=${deger}\n`;
  icerik = ayarla(icerik, 'GEMINI_1PSID', psid);
  icerik = ayarla(icerik, 'GEMINI_1PSIDTS', psidts);
  icerik = ayarla(icerik, 'PORT', port);
  fs.writeFileSync(dosya, icerik);
  log.ok(`[gemini-http] çerezler yazıldı — ${hesap?.ad || 'varsayılan'} (${path.basename(dosya)})`);

  // Bu hesabın köprüsü çalışıyorsa yeni çerezlerle yeniden doğsun. Windows'ta
  // SIGTERM her zaman anında öldürmüyor — portu tutanı da zorla kapat.
  const surec = koprular.get(port);
  koprular.delete(port);
  if (surec) surec.kill('SIGTERM');
  portTutaniOldur(port);
}

/**
 * Gemini'nin sağ alt köşeye bastığı görünür logoyu siler
 * (tools/gwr — ters alfa karışım formülü, "halüsinasyon" yok).
 * Görünmez SynthID işareti dokunulmadan kalır.
 *
 * Başarısız olursa görsel korunur: watermark'lı çıktı, çıktısızlıktan iyidir.
 */
export async function watermarkTemizle(dosyaYolu) {
  if (!fs.existsSync(GWR)) {
    throw new Error(
      'Watermark aracı yok. `git clone https://github.com/GargantuaX/gemini-watermark-remover tools/gwr` ile kur.'
    );
  }
  const gecici = `${dosyaYolu}.temiz.png`;
  await new Promise((cozumle, reddet) => {
    const s = spawn('node', [GWR, 'remove', dosyaYolu, '--output', gecici], {
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let hata = '';
    s.stderr.on('data', (d) => (hata += d));
    s.on('error', (e) => reddet(new Error(`gwr çalıştırılamadı: ${e.message}`)));
    s.on('close', (kod) =>
      kod === 0
        ? cozumle()
        : reddet(new Error(`gwr çıkış ${kod}: ${hata.trim().slice(-200) || 'çıktı yok'}`))
    );
  });
  if (!fs.existsSync(gecici) || fs.statSync(gecici).size < 1024) {
    fs.rmSync(gecici, { force: true });
    throw new Error('gwr geçerli çıktı üretmedi.');
  }
  fs.renameSync(gecici, dosyaYolu);
}

export async function hazirla(_page, platform, _sel, _ayarlar, hesap) {
  await servisiBaslat(platform, hesap);
}

export async function uret(_page, { imagePath, prompt, outDir, baseName, ayarlar, platform, signal, hesap }) {
  fs.mkdirSync(outDir, { recursive: true });
  const foto = fs.readFileSync(path.resolve(imagePath));
  const uzanti = path.extname(imagePath).toLowerCase();
  const mime = uzanti === '.png' ? 'image/png' : uzanti === '.webp' ? 'image/webp' : 'image/jpeg';

  const yanit = await fetch(`${taban(platform, hesap)}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Zaman aşımı + job durdurma sinyali birlikte.
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(ayarlar?.generationTimeoutMs || 240000)])
      : AbortSignal.timeout(ayarlar?.generationTimeoutMs || 240000),
    body: JSON.stringify({
      model: platform?.model || 'gemini-3-pro-image',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: { url: `data:${mime};base64,${foto.toString('base64')}` },
            },
          ],
        },
      ],
    }),
  });

  if (!yanit.ok) {
    const govde = (await yanit.text()).slice(0, 400);
    // Kota/limit ise havuz bu hesabı dinlenmeye alsın (429 ya da metin).
    if (yanit.status === 429 || /quota|rate limit|resource.?exhausted|too many/i.test(govde)) {
      const e = new Error(`Gemini kullanım limiti doldu (${yanit.status}).`);
      e.limitDolu = true;
      e.resetsAt = null; // köprü net reset zamanı vermiyor → varsayılan cooldown
      throw e;
    }
    // BOŞ model listesi = köprü Gemini oturumuna hiç bağlanamadı (çerez ölmüş).
    // Model adı yanlış olsaydı liste DOLU gelir ("Available models: [gemini-...]")
    // — o kalıcı bir config hatasıdır, failover işe yaramaz, normal hata sayılır.
    if (/Available models:\s*\[\s*\]/i.test(govde) || /not supported or not available[\s\S]*\[\s*\]/i.test(govde)) {
      const e = new Error('Gemini oturumu geçersiz (çerezler ölmüş olabilir) — bu hesaba yeniden giriş gerekebilir.');
      e.limitDolu = true; // aynı failover yolu: bu hesabı dinlenmeye al, ötekine geç
      e.sebep = 'oturum';
      // Çerez yenilenince düzelir; kalıcı reset yok, 30 dk sonra tekrar denenir.
      e.resetsAt = Date.now() + 30 * 60 * 1000;
      throw e;
    }
    throw new Error(`Gemini köprüsü ${yanit.status}: ${govde}`);
  }

  const veri = await yanit.json();
  const icerik = veri.choices?.[0]?.message?.content || '';
  const gorseller = [...icerik.matchAll(/!\[[^\]]*\]\(data:image\/([a-z]+);base64,([^)]+)\)/g)];

  if (!gorseller.length) {
    // Görsel yerine metin döndüyse sebebi taşı — sessizce "başarısız" deme.
    const oz = icerik.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (/!\[[^\]]*\]\(https?:/.test(icerik)) {
      throw new Error(
        'Köprü görseli indirmeden URL döndürdü (voku yaması uygulanmamış olabilir): tools/gemini-web-to-api.voku.patch'
      );
    }
    throw new Error(`Gemini görsel üretmedi. Yanıt: ${oz || '(boş)'}`);
  }

  const dosyalar = [];
  for (const [i, [, tur, b64]] of gorseller.entries()) {
    const ek = gorseller.length > 1 ? `-${i + 1}` : '';
    const hedef = path.join(outDir, `${baseName}${ek}.${tur === 'jpeg' ? 'jpg' : tur}`);
    fs.writeFileSync(hedef, Buffer.from(b64, 'base64'));

    if (platform?.watermarkKaldir !== false) {
      try {
        await watermarkTemizle(hedef);
      } catch (e) {
        log.warn(`[gemini-http] watermark silinemedi (${path.basename(hedef)}): ${e.message}`);
      }
    }
    dosyalar.push(path.basename(hedef));
  }
  return dosyalar;
}

/** Panel/CLI kapanırken tüm köprüleri kapat. */
export function kapat() {
  koprulariDurdur();
}
