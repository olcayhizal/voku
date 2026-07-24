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
import { calistirilabilir } from '../platform.js';
import { log } from '../logger.js';

export const ad = 'gemini-http';
export const tarayiciGerekli = false;
/** Giriş yine tarayıcıda yapılır (Google oturumu), sonra çerez senkronu koşar. */
export const girisTipi = 'tarayici';

const SERVIS_DIZINI = path.join(ROOT, 'tools', 'gemini-web-to-api');
const SERVIS_BINARY = path.join(ROOT, 'tools', calistirilabilir('gemini-api-server'));
const ENV_DOSYASI = path.join(SERVIS_DIZINI, '.env');
const GWR = path.join(ROOT, 'tools', 'gwr', 'bin', 'gwr.mjs');

let servisSureci = null;

function taban(platform) {
  return (platform?.baseUrl || 'http://127.0.0.1:4981').replace(/\/+$/, '');
}

/**
 * Köprünün dinleyeceği port. Upstream'in `.env.example`'ı panelinkiyle aynı
 * portu (4173) öneriyor; taze bir kurulumda köprü paneli ezmeye çalışıp
 * "bind: address already in use" ile ölüyordu. Port artık tek kaynaktan —
 * `settings.json > platforms.gemini.baseUrl` — türetilir.
 */
function portu(platform) {
  try {
    return new URL(taban(platform)).port || '4981';
  } catch {
    return '4981';
  }
}

async function saglikli(platform, timeoutMs = 2500) {
  try {
    const yanit = await fetch(`${taban(platform)}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return yanit.ok;
  } catch {
    return false;
  }
}

/** Servisi arka planda başlatır ve sağlıklı olana kadar bekler. */
async function servisiBaslat(platform) {
  if (!fs.existsSync(SERVIS_BINARY)) {
    throw new Error(
      `Gemini köprüsü derlenmemiş. tools/gemini-web-to-api içinde \`go build -o ../gemini-api-server ./cmd/server\` çalıştır.`
    );
  }
  if (!fs.existsSync(ENV_DOSYASI)) {
    throw new Error(
      'Gemini köprüsünün .env dosyası yok. Panelden "Giriş yap" ile Gemini oturumunu aç — çerezler otomatik yazılır.'
    );
  }

  log.info('[gemini-http] köprü servisi başlatılıyor');
  servisSureci = spawn(SERVIS_BINARY, [], {
    cwd: SERVIS_DIZINI,
    // PORT env ile veriliyor: .env'de ne yazarsa yazsın köprü doğru portta
    // kalkar (eski kurulumlarda .env panelin portunu taşıyor olabilir).
    env: { ...process.env, PORT: portu(platform) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  servisSureci.stdout.on('data', () => {});
  servisSureci.stderr.on('data', (d) => log.warn(`[gemini-http] ${String(d).trim().slice(0, 200)}`));
  servisSureci.on('close', () => {
    servisSureci = null;
  });

  for (let i = 0; i < 40; i++) {
    if (await saglikli(platform)) {
      log.ok('[gemini-http] köprü hazır');
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Gemini köprüsü 20 sn içinde ayağa kalkmadı — logs/voku.log ve .env çerezlerine bak.');
}

/**
 * Gemini tarayıcı profilindeki oturum çerezlerini köprünün .env'ine yazar.
 * Panel "Giriş yap" akışını tamamladığında çağrılır.
 */
export async function cerezleriSenkronla(cerezler, platform) {
  const bul = (isim) => cerezler.find((c) => c.name === isim)?.value || null;
  const psid = bul('__Secure-1PSID');
  const psidts = bul('__Secure-1PSIDTS');
  if (!psid || !psidts) {
    throw new Error(
      'Gemini oturum çerezleri bulunamadı (__Secure-1PSID / __Secure-1PSIDTS). Tarayıcıda Gemini hesabına giriş yapıldığından emin ol.'
    );
  }

  let icerik = fs.existsSync(ENV_DOSYASI)
    ? fs.readFileSync(ENV_DOSYASI, 'utf8')
    : fs.readFileSync(path.join(SERVIS_DIZINI, '.env.example'), 'utf8');
  const port = portu(platform);
  icerik = icerik
    .replace(/^GEMINI_1PSID=.*$/m, `GEMINI_1PSID=${psid}`)
    .replace(/^GEMINI_1PSIDTS=.*$/m, `GEMINI_1PSIDTS=${psidts}`);
  // Örnek dosyadan gelen PORT paneli eziyor; doğrusuyla değiştirilir.
  icerik = /^PORT=/m.test(icerik)
    ? icerik.replace(/^PORT=.*$/m, `PORT=${port}`)
    : `PORT=${port}\n${icerik}`;
  fs.writeFileSync(ENV_DOSYASI, icerik);
  log.ok('[gemini-http] çerezler köprüye yazıldı');

  // Servis çalışıyorsa yeni çerezlerle yeniden doğsun.
  if (servisSureci) {
    servisSureci.kill('SIGTERM');
    servisSureci = null;
  }
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

export async function hazirla(_page, platform) {
  if (await saglikli(platform)) return;
  await servisiBaslat(platform);
}

export async function uret(_page, { imagePath, prompt, outDir, baseName, ayarlar, platform, signal }) {
  fs.mkdirSync(outDir, { recursive: true });
  const foto = fs.readFileSync(path.resolve(imagePath));
  const uzanti = path.extname(imagePath).toLowerCase();
  const mime = uzanti === '.png' ? 'image/png' : uzanti === '.webp' ? 'image/webp' : 'image/jpeg';

  const yanit = await fetch(`${taban(platform)}/openai/v1/chat/completions`, {
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
    const govde = (await yanit.text()).slice(0, 300);
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

/** Panel/CLI kapanırken köprüyü de kapat. */
export function kapat() {
  if (servisSureci) {
    servisSureci.kill('SIGTERM');
    servisSureci = null;
  }
}
