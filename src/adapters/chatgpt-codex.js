/**
 * ChatGPT — Codex CLI sürücüsü (tarayıcısız).
 *
 * OpenAI'ın resmi "Sign in with ChatGPT" akışı: `codex login` ile abonelik
 * hesabı bağlanır, üretim Codex'in yerleşik `image_gen` tool'u (gpt-image-2)
 * üzerinden abonelik kotasından koşar. Tarayıcı, Cloudflare ve selector
 * kırılganlığı yok.
 *
 * Not: görsel üreten turlar Codex kullanım limitini metin turlarına göre
 * 3-5 kat hızlı tüketir — eşzamanlılığı ölçülü tut.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { komutCagrisi } from '../platform.js';

export const ad = 'chatgpt-codex';
export const tarayiciGerekli = false;

/**
 * OpenAI strict şema kuralı: her object'te additionalProperties=false VE
 * `required` tüm alanları kapsamalı. Opsiyonel alan bırakmak 400 döndürür
 * ("param": "text.format.schema").
 */
const CIKTI_SEMASI = {
  type: 'object',
  additionalProperties: false,
  required: ['files'],
  properties: {
    files: {
      type: 'array',
      description: 'Kaydedilen görsel dosyalarının mutlak yolları',
      items: { type: 'string' },
    },
  },
};

/**
 * Codex'i çalıştırma biçimi. Windows'ta npm shim'i `.cmd` olduğu için
 * `cmd.exe /c` üzerinden gider (bkz. platform.js > komutCagrisi).
 */
export function codexCagrisi() {
  return komutCagrisi('codex');
}

/** Codex'i verilen argümanlarla çalıştırır (platform farkını gizler). */
function codexCalistir(argumanlar, secenekler) {
  const { komut, onEk } = codexCagrisi();
  return komutCalistir(komut, [...onEk, ...argumanlar], secenekler);
}

function komutCalistir(komut, argumanlar, { timeoutMs, cwd, signal, stdin } = {}) {
  return new Promise((cozumle, reddet) => {
    const surec = spawn(komut, argumanlar, {
      cwd,
      env: process.env,
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (stdin !== undefined) {
      surec.stdin.write(stdin);
      surec.stdin.end();
    }
    let cikti = '';
    let hata = '';
    const sayac = timeoutMs
      ? setTimeout(() => {
          surec.kill('SIGKILL');
          reddet(new Error(`Codex zaman aşımına uğradı (${timeoutMs} ms).`));
        }, timeoutMs)
      : null;

    // Job durdurulursa çalışan Codex sürecini de kapat.
    const durdur = () => {
      surec.kill('SIGTERM');
      setTimeout(() => surec.killed || surec.kill('SIGKILL'), 3000);
      reddet(new Error('Durduruldu.'));
    };
    if (signal) {
      if (signal.aborted) return durdur();
      signal.addEventListener('abort', durdur, { once: true });
      surec.on('close', () => signal.removeEventListener('abort', durdur));
    }

    surec.stdout.on('data', (d) => (cikti += d));
    surec.stderr.on('data', (d) => (hata += d));
    surec.on('error', (e) => {
      if (sayac) clearTimeout(sayac);
      reddet(new Error(`Codex çalıştırılamadı: ${e.message}`));
    });
    surec.on('close', (kod) => {
      if (sayac) clearTimeout(sayac);
      if (kod !== 0) {
        const son = (hata || cikti).trim().split('\n').slice(-4).join(' ');
        return reddet(new Error(`Codex çıkış kodu ${kod}: ${son || 'çıktı yok'}`));
      }
      cozumle(cikti);
    });
  });
}

function codexKoku() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/**
 * Panel bu sürücüde girişi tarayıcı penceresiyle değil, alt süreçle yapar.
 * `codex login` sistem tarayıcısında OAuth akışını açar ve giriş bitince
 * kendi kapanır — panelin "tamamladım" düğmesine gerek kalmaz.
 */
export const girisTipi = 'surec';

export function girisKomutu(platform) {
  const { komut, onEk } = codexCagrisi();
  const argumanlar = [...onEk, 'login'];
  if (platform?.deviceAuth) argumanlar.push('--device-auth');
  return {
    komut,
    argumanlar,
    ipucu: platform?.deviceAuth
      ? 'Ekranda çıkan kodu chatgpt.com/device adresine gir.'
      : 'Sistem tarayıcında ChatGPT giriş sayfası açılacak. Giriş bitince bu kart kendiliğinden yeşile döner.',
  };
}

/** Panelin kart durumu için ucuz, senkron bakış (doğrulama ayrıca koşar). */
export function girisDurumu() {
  const dosya = path.join(codexKoku(), 'auth.json');
  if (!fs.existsSync(dosya)) return { profilVar: false, sonGiris: null };
  return { profilVar: true, sonGiris: fs.statSync(dosya).mtime.toISOString() };
}

/** Codex kurulu ve ChatGPT hesabıyla giriş yapılmış mı? */
export async function hazirla() {
  let durum;
  try {
    durum = await codexCalistir(['login', 'status'], { timeoutMs: 30000 });
  } catch (e) {
    if (/ENOENT|çalıştırılamadı/.test(e.message)) {
      throw new Error(
        'Codex CLI kurulu değil. `npm install -g @openai/codex` ile kur, sonra `codex login` ile ChatGPT hesabını bağla.'
      );
    }
    // `codex login status` giriş yoksa çıkış kodu 1 ile döner — bu bir arıza değil.
    if (/not logged in/i.test(e.message)) {
      throw new Error(
        'Codex girişi yapılmamış. Terminalde `codex login` çalıştır (ChatGPT hesabıyla giriş; abonelik kotası kullanılır).'
      );
    }
    throw new Error(
      `Codex oturumu doğrulanamadı: ${e.message} — terminalde \`codex login\` çalıştır.`
    );
  }
  if (/not logged in/i.test(durum)) {
    throw new Error(
      'Codex girişi yapılmamış. Terminalde `codex login` çalıştır (ChatGPT hesabıyla giriş; abonelik kotası kullanılır).'
    );
  }
  if (/api key/i.test(durum)) {
    // API anahtarıyla giriş faturalıdır — abonelik beklerken sürpriz olmasın.
    throw new Error(
      'Codex API anahtarıyla giriş yapmış görünüyor (kullanım faturalandırılır). Abonelik kotası için `codex logout` sonrası `codex login` ile ChatGPT hesabını bağla.'
    );
  }
}

/** Klasördeki görsel dosyalarının anlık listesi (baseline). */
function gorselDosyalari(klasor) {
  if (!fs.existsSync(klasor)) return new Set();
  return new Set(
    fs.readdirSync(klasor).filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
  );
}

/** Codex'in kendi çıktı klasöründe bırakılmış son görselleri toplar (yedek yol). */
function codexCiktilari(baslangicZamani) {
  const kok = path.join(codexKoku(), 'generated_images');
  if (!fs.existsSync(kok)) return [];
  const bulunan = [];
  const tara = (dizin, derinlik = 0) => {
    if (derinlik > 3) return;
    for (const giris of fs.readdirSync(dizin, { withFileTypes: true })) {
      const tam = path.join(dizin, giris.name);
      if (giris.isDirectory()) tara(tam, derinlik + 1);
      else if (/\.(png|jpe?g|webp)$/i.test(giris.name)) {
        const st = fs.statSync(tam);
        if (st.mtimeMs >= baslangicZamani) bulunan.push({ yol: tam, zaman: st.mtimeMs });
      }
    }
  };
  tara(kok);
  return bulunan.sort((a, b) => a.zaman - b.zaman).map((x) => x.yol);
}

export async function uret(_page, { imagePath, prompt, outDir, baseName, ayarlar, platform, signal }) {
  fs.mkdirSync(outDir, { recursive: true });
  const oncesi = gorselDosyalari(outDir);
  const baslangic = Date.now() - 1000;
  const hedef = path.join(outDir, `${baseName}.png`);

  const gorev = [
    'Görsel üret. Kod yazma, dosya analizi yapma, açıklama yapma — sadece görsel üretimi.',
    `Referans olarak sana verilen fotoğrafı kullan: ${path.resolve(imagePath)}`,
    '',
    'İSTENEN GÖRSEL:',
    prompt,
    '',
    `Üretilen görseli tam olarak şu yola kaydet: ${hedef}`,
    'Sonuç olarak kaydettiğin dosyaların mutlak yollarını döndür.',
  ].join('\n');

  const argumanlar = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '-C',
    outDir,
    '-s',
    'workspace-write',
    '-i',
    path.resolve(imagePath),
  ];

  if (platform?.model) argumanlar.push('-m', platform.model);
  for (const [anahtar, deger] of Object.entries(platform?.codexConfig || {})) {
    argumanlar.push('-c', `${anahtar}=${JSON.stringify(deger)}`);
  }
  // Prompt STDIN'den verilir ("-"), argüman olarak DEĞİL: `-i` çoklu değer
  // aldığı için araya `-c` girince pozisyonel prompt yutuluyor ve Codex boş
  // girdiyle bekliyor ("Reading additional input from stdin...").

  // Final cevabı şemaya bağla — dosya yolunu metinden ayıklamaya çalışmayalım.
  // Şema reddedilirse (model/sürüm farkı) şemasız tekrar dene: dosyaları
  // zaten dosya sisteminden de bulabiliyoruz.
  const semaKullan = platform?.outputSchema !== false;
  const semaDosyasi = path.join(os.tmpdir(), `voku-sema-${process.pid}-${Date.now()}.json`);
  const zamanAsimi = ayarlar?.generationTimeoutMs || 240000;

  let ham;
  try {
    if (semaKullan) {
      fs.writeFileSync(semaDosyasi, JSON.stringify(CIKTI_SEMASI));
      try {
        ham = await codexCalistir(
          [...argumanlar, '--output-schema', semaDosyasi, '-'],
          { timeoutMs: zamanAsimi, cwd: outDir, signal, stdin: gorev }
        );
      } catch (e) {
        if (!/text\.format\.schema|output.?schema|400/i.test(e.message)) throw e;
        ham = await codexCalistir([...argumanlar, '-'], {
          timeoutMs: zamanAsimi,
          cwd: outDir,
          signal,
          stdin: gorev,
        });
      }
    } else {
      ham = await codexCalistir([...argumanlar, '-'], {
        timeoutMs: zamanAsimi,
        cwd: outDir,
        signal,
        stdin: gorev,
      });
    }
  } finally {
    fs.rmSync(semaDosyasi, { force: true });
  }

  // 1) Şemalı cevaptaki yollar — üretimden önce de var olan dosyaları alma.
  const yollar = new Set();
  const eslesme = ham.match(/\{[\s\S]*"files"[\s\S]*\}/);
  if (eslesme) {
    try {
      for (const y of JSON.parse(eslesme[0]).files || []) {
        const tam = path.resolve(outDir, y);
        if (!oncesi.has(path.basename(tam))) yollar.add(tam);
      }
    } catch {
      /* şema bozuksa dosya sistemine bakarız */
    }
  }

  // 2) Çıktı klasöründe beliren yeni dosyalar — SADECE kendi baseName'imiz.
  // Aynı job'ın başka task'ları (ör. paralel koşan Gemini) aynı klasöre yazar;
  // "yeni olan her dosya benimdir" demek başkasının çıktısını sahiplenir.
  for (const dosya of gorselDosyalari(outDir)) {
    if (!oncesi.has(dosya) && dosya.startsWith(baseName)) yollar.add(path.join(outDir, dosya));
  }

  // 3) Codex kendi klasörüne bırakıp kopyalamadıysa oradan al
  if (!yollar.size) {
    const kalanlar = codexCiktilari(baslangic);
    kalanlar.forEach((kaynak, i) => {
      const ek = kalanlar.length > 1 ? `-${i + 1}` : '';
      const varis = path.join(outDir, `${baseName}${ek}${path.extname(kaynak) || '.png'}`);
      fs.copyFileSync(kaynak, varis);
      yollar.add(varis);
    });
  }

  const gecerli = [...yollar].filter((y) => fs.existsSync(y) && fs.statSync(y).size > 1024);
  if (!gecerli.length) {
    const kuyruk = ham.trim().split('\n').slice(-3).join(' ').slice(0, 300);
    throw new Error(`Codex görsel üretmedi. Son çıktı: ${kuyruk || '(boş)'}`);
  }

  // Codex mutlak yol döndürüp dosyayı kendi çalışma/geçici klasörüne yazmış
  // olabilir (Windows'un AppContainer sandbox'ında sık). Task yalnız dosya
  // ADINI saklar ve panel onu job klasöründe arar: dışarıda kalan çıktı
  // "üretildi ama görünmüyor" durumuna yol açar. Bu yüzden outDir dışındaki
  // her çıktı içeri kopyalanır.
  const dosyalar = gecerli.map((kaynak, i) => {
    if (path.resolve(path.dirname(kaynak)) === path.resolve(outDir)) return kaynak;
    const ek = gecerli.length > 1 ? `-${i + 1}` : '';
    const varis = path.join(outDir, `${baseName}${ek}${path.extname(kaynak) || '.png'}`);
    fs.copyFileSync(kaynak, varis);
    log.info(`[chatgpt-codex] çıktı iş klasörüne alındı: ${path.basename(varis)}`);
    return varis;
  });

  return dosyalar.map((y) => path.basename(y));
}
