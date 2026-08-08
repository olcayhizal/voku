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
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { OUTPUT_DIR } from '../paths.js';
import { komutCagrisi } from '../platform.js';
import { log } from '../logger.js';

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

/**
 * Codex çıktısından kullanım limiti hatası + reset zamanı çıkarır.
 * Codex limite çarpınca "usage limit reached … try again at 6:34 AM" ya da
 * "resets in 4h" gibi metin döndürüyor. Reset okunabilirse ms epoch,
 * okunamıyorsa null (havuz muhafazakâr varsayılan cooldown uygular).
 */
export function limitHatasiCoz(metin) {
  const m = String(metin || '');
  if (!/usage limit|rate limit|too many requests|quota|429|limit reached/i.test(m)) return null;

  // 1) Metinde reset zamanı varsa en doğrusu o (Codex genelde verir).
  const okunan = resetZamaniCoz(m);
  if (okunan) return { limitDolu: true, resetsAt: okunan, gecici: false };

  // 2) Reset okunamadıysa hatanın cinsine göre (Gemini'dekiyle aynı mantık):
  //    "too many requests"/429 tarzı GEÇİCİ throttle → 3 dk kısa mola;
  //    gerçek kullanım limiti metni (usage/weekly/quota) → muhafazakâr 1 saat.
  //    Eskiden hepsi 1 saatti — yanlış pozitifte hesap boşuna yatıyordu.
  const geciciMi =
    /too many requests|429/i.test(m) && !/usage limit|weekly|quota|limit reached/i.test(m);
  return {
    limitDolu: true,
    resetsAt: Date.now() + (geciciMi ? 3 : 60) * 60 * 1000,
    gecici: geciciMi,
  };
}

/** Metinden reset zamanını (ms epoch) çıkarır; okunamazsa null. */
export function resetZamaniCoz(m) {
  // 1) ISO zaman damgası — Codex protokolünün resets_at'i (en güvenilir).
  const iso = m.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/);
  if (iso) {
    const t = Date.parse(iso[1]);
    if (!Number.isNaN(t) && t > Date.now()) return t;
  }
  // 2) Göreli süre: "in 4 days 2 hours 46 minutes", "resets in 3h 20m".
  const rel = m.match(/\b(?:in|resets?\s+in|try\s+again\s+in)\s+([\dhmds\s,]+?)(?:[.)\]]|$|\.\s)/i);
  if (rel) {
    const g = rel[1];
    const d = /(\d+)\s*(?:d\b|day)/i.exec(g);
    const h = /(\d+)\s*(?:h\b|hour)/i.exec(g);
    const dk = /(\d+)\s*(?:m\b|min)/i.exec(g);
    const ms =
      ((d ? +d[1] : 0) * 86400 + (h ? +h[1] : 0) * 3600 + (dk ? +dk[1] : 0) * 60) * 1000;
    if (ms > 0) return Date.now() + ms;
  }
  // 3) Saat: "try again at 6:34 AM" — bugünün o saati, geçmişse yarın.
  const saat = m.match(/(?:again|reset)\D{0,12}?\bat\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (saat) {
    const s = new Date();
    let sa = +saat[1];
    if (saat[3]) {
      const pm = /pm/i.test(saat[3]);
      if (pm && sa < 12) sa += 12;
      if (!pm && sa === 12) sa = 0;
    }
    s.setHours(sa, +saat[2], 0, 0);
    if (s.getTime() <= Date.now()) s.setDate(s.getDate() + 1);
    return s.getTime();
  }
  return null;
}

function komutCalistir(komut, argumanlar, { timeoutMs, cwd, signal, stdin, codexHome } = {}) {
  return new Promise((cozumle, reddet) => {
    const surec = spawn(komut, argumanlar, {
      cwd,
      // Her hesap ayrı CODEX_HOME: auth.json ve generated_images orada izole.
      env: codexHome ? { ...process.env, CODEX_HOME: codexHome } : process.env,
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
      // Limit dolduysa çıkış kodu 0 olsa bile (Codex bazen 0 döndürüp metinde
      // söylüyor) havuzun tanıyabileceği özel hata fırlat.
      const limit = limitHatasiCoz(hata + '\n' + cikti);
      if (limit) {
        const e = new Error(
          limit.gecici
            ? 'Codex geçici olarak sınırladı — kısa mola.'
            : 'Codex kullanım limiti doldu.'
        );
        e.limitDolu = true;
        e.resetsAt = limit.resetsAt;
        return reddet(e);
      }
      if (kod !== 0) {
        const son = (hata || cikti).trim().split('\n').slice(-4).join(' ');
        return reddet(new Error(`Codex çıkış kodu ${kod}: ${son || 'çıktı yok'}`));
      }
      cozumle(cikti);
    });
  });
}

function codexKoku(hesap) {
  return hesap?.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/**
 * Panel bu sürücüde girişi tarayıcı penceresiyle değil, alt süreçle yapar.
 * `codex login` sistem tarayıcısında OAuth akışını açar ve giriş bitince
 * kendi kapanır — panelin "tamamladım" düğmesine gerek kalmaz.
 */
export const girisTipi = 'surec';

export function girisKomutu(platform, hesap) {
  const { komut, onEk } = codexCagrisi();
  const argumanlar = [...onEk, 'login'];
  if (platform?.deviceAuth) argumanlar.push('--device-auth');
  return {
    komut,
    argumanlar,
    // Her hesap ayrı CODEX_HOME'a giriş yapar; süreci başlatan taraf bu env'i
    // uygular (server.js). Kart ipucu hesap adını da içerir.
    env: hesap?.codexHome ? { CODEX_HOME: hesap.codexHome } : null,
    ipucu: platform?.deviceAuth
      ? 'Ekranda çıkan kodu chatgpt.com/device adresine gir.'
      : 'Sistem tarayıcında ChatGPT giriş sayfası açılacak. Giriş bitince bu kart kendiliğinden yeşile döner.',
  };
}

/** Panelin kart durumu için ucuz, senkron bakış (doğrulama ayrıca koşar). */
export function girisDurumu(platform, hesap) {
  const dosya = path.join(codexKoku(hesap), 'auth.json');
  if (!fs.existsSync(dosya)) return { profilVar: false, sonGiris: null };
  return { profilVar: true, sonGiris: fs.statSync(dosya).mtime.toISOString() };
}

/** Codex kurulu ve ChatGPT hesabıyla giriş yapılmış mı? */
export async function hazirla(_page, _platform, _sel, _ayarlar, hesap) {
  let durum;
  try {
    durum = await codexCalistir(['login', 'status'], { timeoutMs: 30000, codexHome: codexKoku(hesap) });
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
function codexCiktilari(baslangicZamani, hesap) {
  const kok = path.join(codexKoku(hesap), 'generated_images');
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

/* ---------------- sohbet modu ----------------
 * Her yeni `codex exec` sıfır sohbet açar: sistem promptu + araç şemaları +
 * fotoğraf her seferinde baştan token yakar. Sohbet modunda her PROMPT
 * ŞABLONU (hesap başına) kendi kalıcı sohbetini tutar; her yeni iş o sohbete
 * `codex exec resume <id> -i <yeni foto>` ile yeni bir tur olarak eklenir.
 * Tekrar eden prefix önbellekten gelir, limit çok daha yavaş dolar — ve aynı
 * işin farklı prompt'ları FARKLI sohbetler olduğundan paralellik bozulmaz.
 * Aynı sohbete paralel tur gönderilemez: turlar sohbet başına sıraya dizilir
 * (aynı prompt'un art arda işleri serileşir, gerisi paraleldir).
 */
const sohbetler = new Map(); // "hesap::promptId::promptOzeti" → [{ id, tur, aktif, kuyruk }]

// Hesap (CODEX_HOME) başına süren üretim sayısı: generated_images yedek
// yolunun paralel üretim sırasında BAŞKA task'ın görselini kapmaması için
// (kare 01'e kare 04'ün görselinin yazılması bu yüzdendi).
const aktifUretimler = new Map(); // codexHome → sayı

function uretimSayaci(home, fark) {
  aktifUretimler.set(home, Math.max(0, (aktifUretimler.get(home) || 0) + fark));
}

/**
 * Aynı prompt'un işleri paralel gelebilsin diye prompt başına birden çok
 * sohbet tutulur (`sohbetParalel`, varsayılan 2): boşta sohbet varsa o,
 * yoksa sınıra kadar yeni sohbet, sınır dolunca en az yüklü sohbetin
 * kuyruğu kullanılır.
 */
function sohbetSec(anahtar, sinir) {
  let liste = sohbetler.get(anahtar);
  if (!liste) {
    liste = [];
    sohbetler.set(anahtar, liste);
  }
  const bosta = liste.find((k) => !k.aktif);
  if (bosta) return bosta;
  if (liste.length < Math.max(1, sinir)) {
    const yeni = { id: null, tur: 0, aktif: 0, kuyruk: Promise.resolve() };
    liste.push(yeni);
    return yeni;
  }
  return liste.reduce((a, b) => (a.aktif <= b.aktif ? a : b));
}

/* ---------------- limit sorgusu (panel rozeti) ----------------
 * Codex'in kalan hakkı chatgpt.com backend'inden okunur (wham/usage) —
 * hesabın kendi auth token'ı ile. Panel sync okur (limitOku), tazeleme
 * server'daki periyodik görevle yapılır (limitTazele).
 */
const limitCache = new Map(); // codexHome → { veri, zaman }

export function limitOku(hesap) {
  return limitCache.get(codexKoku(hesap))?.veri || null;
}

export async function limitTazele(hesap) {
  const home = codexKoku(hesap);
  const eski = limitCache.get(home);
  if (eski && Date.now() - eski.zaman < 2 * 60 * 1000) return eski.veri;
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'));
    const token = auth?.tokens?.access_token;
    if (!token) return null;
    const yanit = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!yanit.ok) throw new Error(`usage ${yanit.status}`);
    const d = await yanit.json();
    const pencere = (p) =>
      p
        ? {
            yuzde: Number(p.used_percent) || 0,
            resetAt: p.reset_at ? p.reset_at * 1000 : null,
            pencereSn: p.limit_window_seconds || null,
          }
        : null;
    const veri = {
      plan: d.plan_type || null,
      doldu: Boolean(d.rate_limit?.limit_reached),
      birincil: pencere(d.rate_limit?.primary_window),
      ikincil: pencere(d.rate_limit?.secondary_window),
      zaman: Date.now(),
    };
    limitCache.set(home, { veri, zaman: Date.now() });
    return veri;
  } catch {
    return eski?.veri || null; // ağ hatasında eski değer kalsın
  }
}

/**
 * Sohbet anahtarı prompt METNİNİ de içerir: şablon panelden düzenlenirse
 * eski sohbet (eski talimatlarıyla) kullanılmaz, taze sohbet açılır.
 */
function sohbetAnahtari(hesap, promptId, prompt) {
  const ozet = crypto.createHash('md5').update(String(prompt || '')).digest('hex').slice(0, 8);
  return `${hesap?.ad || 'varsayılan'}::${promptId || 'p'}::${ozet}`;
}

/** Codex `--json` (JSONL) çıktısından oturum kimliğini ayıklar. */
export function oturumKimligiCoz(ham) {
  for (const satir of String(ham || '').split('\n')) {
    const s = satir.trim();
    if (!s.startsWith('{')) continue;
    try {
      const o = JSON.parse(s);
      const kimlik =
        o.session_id || o.thread_id || o.session?.id || o.thread?.id ||
        (/session|thread/i.test(String(o.type || '')) ? o.id : null);
      if (typeof kimlik === 'string' && kimlik.length >= 8) return kimlik;
    } catch {
      /* JSON olmayan satır */
    }
  }
  return null;
}

export async function uret(_page, girdi) {
  const { platform, hesap, promptId, prompt } = girdi;
  const home = codexKoku(hesap);
  uretimSayaci(home, +1);
  try {
    return await uretIc(girdi);
  } finally {
    uretimSayaci(home, -1);
  }
}

async function uretIc(girdi) {
  const { platform, hesap, promptId, prompt } = girdi;
  if (platform?.sohbetModu === false) return tekSeferlikUret(girdi);

  // Sohbet modu (varsayılan): prompt şablonunun sohbet havuzundan boş
  // sohbete düş — aynı prompt'un paralel işleri farklı sohbetlerde koşar.
  const anahtar = sohbetAnahtari(hesap, promptId, prompt);
  const kayit = sohbetSec(anahtar, Number(platform?.sohbetParalel) || 2);
  kayit.aktif = (kayit.aktif || 0) + 1;
  const tur = kayit.kuyruk.then(() => sohbetteUret(girdi, kayit));
  kayit.kuyruk = tur.catch(() => {}); // zincir bir hatayla kopmasın
  return tur.finally(() => {
    kayit.aktif -= 1;
  });
}

async function sohbetteUret(girdi, kayit) {
  // Sohbet sonsuz uzayamaz: her tur bir fotoğraf ekliyor, bağlam sınırına
  // yaklaşmadan belli tur sayısında taze sohbete dönülür (cache sıfırlanır
  // ama bir kereliğine — sonraki turlar yine önbellekten gelir).
  const sinir = Number(girdi.platform?.sohbetTurSiniri) || 12;
  if (kayit.id && kayit.tur >= sinir) {
    log.info(`[chatgpt-codex] sohbet ${kayit.id.slice(0, 8)}… ${kayit.tur} tura ulaştı — taze sohbet açılıyor`);
    kayit.id = null;
    kayit.tur = 0;
  }
  if (kayit.id) {
    try {
      return await turCalistir(girdi, kayit, false);
    } catch (e) {
      // Limit/durdurma/dosya-toplama hataları yukarı çıkar (failover/abort/
      // retry oradan yönetiliyor); diğer hatalarda oturum çürümüş olabilir —
      // yeni sohbetle bir şans daha.
      if (e.limitDolu || girdi.signal?.aborted || e.sohbetiKoru) throw e;
      log.warn(`[chatgpt-codex] sohbet sürdürülemedi (${String(e.message).slice(0, 120)}) — yeni sohbet açılıyor`);
      kayit.id = null;
      kayit.tur = 0;
    }
  }
  return turCalistir(girdi, kayit, true);
}

/** Sohbet modunda tek tur: ilk tur oturumu açar, sonrakiler devam ettirir. */
async function turCalistir({ imagePath, prompt, outDir, baseName, ayarlar, platform, signal, hesap }, kayit, ilkMi) {
  fs.mkdirSync(outDir, { recursive: true });
  const oncesi = gorselDosyalari(outDir);
  const baslangic = Date.now() - 1000;
  const hedef = path.join(outDir, `${baseName}.png`);
  const codexHome = codexKoku(hesap);
  const zamanAsimi = ayarlar?.generationTimeoutMs || 240000;

  // Yeni Codex sürümlerinde image_gen bir skill: üretim isteğini sandbox
  // İÇİNDEN ağa atıyor. workspace-write varsayılanı ağı kapattığı için izin
  // açılmazsa "yetkilendirme hatası" ile sessizce üretmiyor.
  // Çıktı kökü sandbox'ın yazılabilir köklerine eklenir — Windows sandbox'ı
  // cwd iznine rağmen kullanıcı dizinine yazdırmayabiliyor; bu ayar
  // destekleniyorsa kopyalama ajan tarafında da düzelir (CIKTI yolu yedek).
  const ortakArgumanlar = [
    '-c', 'sandbox_workspace_write.network_access=true',
    '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([OUTPUT_DIR])}`,
  ];
  // Varsayılan model gpt-5.5 (CLI varsayılanı 5.6-sol) — settings'te
  // platform.model ile değiştirilebilir. Görseli image_gen ürettiği için
  // kalite aynı; yöneten ajan 5.5.
  ortakArgumanlar.push('-m', platform?.model || 'gpt-5.5');
  for (const [anahtar, deger] of Object.entries(platform?.codexConfig || {})) {
    ortakArgumanlar.push('-c', `${anahtar}=${JSON.stringify(deger)}`);
  }

  let ham;
  if (ilkMi) {
    const gorev = [
      'Görsel üret. Kod yazma, dosya analizi yapma, açıklama yapma — sadece görsel üretimi.',
      `Referans fotoğraf bu mesaja ekli: ${path.resolve(imagePath)}`,
      'Bu sohbette sana her mesajda YENİ bir referans fotoğraf vereceğim; her turda yalnız o mesajın fotoğrafını kullan.',
      '',
      'İSTENEN GÖRSEL:',
      prompt,
      '',
      'Üretilen dosyayı TAŞIMA, KOPYALAMA, yeniden adlandırma — dosya işleri bizde.',
      'Üretim bitince görsel dosyasının tam (mutlak) yolunu tek satırda şu biçimde yaz: CIKTI: <yol>',
    ].join('\n');
    // `--json`: oturum kimliği event akışından okunur. `--ephemeral` YOK —
    // oturum diske yazılmalı ki sonraki işler devam ettirebilsin. Sohbet
    // işler arası yaşadığı için sandbox kökü tek işin klasörü değil tüm
    // çıktı kökü olmalı — sonraki turlar başka işlerin klasörüne yazacak.
    const sandboxKoku = path.resolve(outDir).startsWith(path.resolve(OUTPUT_DIR))
      ? OUTPUT_DIR
      : outDir;
    ham = await codexCalistir(
      [
        'exec', '--skip-git-repo-check', '--json',
        '-C', sandboxKoku, '-s', 'workspace-write',
        '-i', path.resolve(imagePath),
        ...ortakArgumanlar, '-',
      ],
      { timeoutMs: zamanAsimi, cwd: sandboxKoku, signal, stdin: gorev, codexHome }
    );
    kayit.id = oturumKimligiCoz(ham);
    if (kayit.id) log.info(`[chatgpt-codex] sohbet açıldı: ${kayit.id.slice(0, 8)}… (bu prompt'un sonraki işleri buradan devam eder)`);
    else log.warn('[chatgpt-codex] oturum kimliği okunamadı — sonraki tur yeni sohbet açacak');
    if (process.env.VOKU_CODEX_DEBUG) {
      fs.writeFileSync(path.join(outDir, `.codex-ham-${baseName}.log`), ham);
    }
  } else {
    const gorev = [
      `Bu mesaja YENİ bir referans fotoğraf ekledim: ${path.resolve(imagePath)}`,
      'Önceki fotoğrafları değil, yalnız bu yeni fotoğrafı kullan. Kod yazma, açıklama yapma.',
      '',
      'İSTENEN GÖRSEL:',
      prompt,
      '',
      'Üretilen dosyayı TAŞIMA, KOPYALAMA, yeniden adlandırma — dosya işleri bizde.',
      'Üretim bitince görsel dosyasının tam (mutlak) yolunu tek satırda şu biçimde yaz: CIKTI: <yol>',
    ].join('\n');
    // --json: file_change event'leri üretilen dosyanın KESİN yolunu verir —
    // ortak klasör tahminine (yanlış eşleşme riski) gerek kalmaz.
    ham = await codexCalistir(
      [
        'exec', 'resume', kayit.id, '--skip-git-repo-check', '--json',
        '-i', path.resolve(imagePath),
        ...ortakArgumanlar, '-',
      ],
      { timeoutMs: zamanAsimi, cwd: outDir, signal, stdin: gorev, codexHome }
    );
    log.info(`[chatgpt-codex] sohbetten devam (${kayit.tur + 1}. tur): ${kayit.id.slice(0, 8)}… → ${baseName}`);
  }

  let dosyalar;
  try {
    dosyalar = dosyalariTopla(ham, { outDir, baseName, oncesi, baslangic, hesap });
  } catch (e) {
    if (!kayit.id || e.limitDolu || signal?.aborted) throw e;
    // Üretim büyük olasılıkla TAMAM ama dosya izlenemedi (Windows'ta Codex
    // hedefe kopyalayamayabiliyor; ortak klasör paralelde güvensiz). Yeniden
    // üretim görsel kotası yakar — bunun yerine sohbete ucuz bir kurtarma
    // turu: sohbet kendi görselini bilir, hedefe KOPYALATILIR.
    kayit.tur += 1; // başarısız tur da sohbet geçmişine yazıldı
    log.warn(`[chatgpt-codex] çıktı bulunamadı — kurtarma turu: sohbetteki son görsel hedefe kopyalatılıyor (${baseName})`);
    const kurtarmaGorev = [
      'YENİ GÖRSEL ÜRETME. Bu sohbette az önce ürettiğin SON görselin dosyası nerede duruyorsa,',
      'o dosyanın tam (mutlak) yolunu tek satırda şu biçimde yaz: CIKTI: <yol>',
      `Mümkünse ayrıca dosyayı şu yola da kopyalamayı dene (izin yoksa atla): ${hedef}`,
    ].join('\n');
    const kurtarmaHam = await codexCalistir(
      ['exec', 'resume', kayit.id, '--skip-git-repo-check', '--json', ...ortakArgumanlar, '-'],
      { timeoutMs: 120000, cwd: outDir, signal, stdin: kurtarmaGorev, codexHome }
    );
    dosyalar = dosyalariTopla(kurtarmaHam, { outDir, baseName, oncesi, baslangic, hesap });
  }
  kayit.tur += 1;
  return dosyalar;
}

/** Eski davranış (sohbetModu:false): her kare kendi tek seferlik oturumunda. */
async function tekSeferlikUret({ imagePath, prompt, outDir, baseName, ayarlar, platform, signal, hesap }) {
  fs.mkdirSync(outDir, { recursive: true });
  const oncesi = gorselDosyalari(outDir);
  const baslangic = Date.now() - 1000;
  const hedef = path.join(outDir, `${baseName}.png`);
  const codexHome = codexKoku(hesap);

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
    // imagegen skill'i üretim isteğini sandbox içinden ağa atıyor (yeni Codex).
    '-c',
    'sandbox_workspace_write.network_access=true',
    '-c',
    `sandbox_workspace_write.writable_roots=${JSON.stringify([OUTPUT_DIR])}`,
    '-i',
    path.resolve(imagePath),
  ];

  argumanlar.push('-m', platform?.model || 'gpt-5.5');
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
          { timeoutMs: zamanAsimi, cwd: outDir, signal, stdin: gorev, codexHome }
        );
      } catch (e) {
        // Limit hatasını YUTMA — şemasız tekrar aynı hesapta yine dolu döner.
        if (e.limitDolu) throw e;
        if (!/text\.format\.schema|output.?schema|400/i.test(e.message)) throw e;
        ham = await codexCalistir([...argumanlar, '-'], {
          timeoutMs: zamanAsimi,
          cwd: outDir,
          signal,
          stdin: gorev,
          codexHome,
        });
      }
    } else {
      ham = await codexCalistir([...argumanlar, '-'], {
        timeoutMs: zamanAsimi,
        cwd: outDir,
        signal,
        stdin: gorev,
        codexHome,
      });
    }
  } finally {
    fs.rmSync(semaDosyasi, { force: true });
  }

  return dosyalariTopla(ham, { outDir, baseName, oncesi, baslangic, hesap });
}

/**
 * `--json` akışındaki file_change event'lerinden bu TURDA yazılan görsel
 * dosyalarının kesin yollarını çıkarır — paralel üretimde tek güvenilir
 * eşleştirme kaynağı (agent hangi dosyayı yazdıysa event'i onu söyler).
 */
function jsonlDosyaYollari(ham, outDir) {
  const yollar = [];
  for (const satir of String(ham || '').split('\n')) {
    const t = satir.trim();
    if (!t.startsWith('{')) continue;
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const it = o.item || o;
    if (it.type !== 'file_change') continue;
    for (const c of it.changes || []) {
      const ham_yol = c.path || '';
      if (!/\.(png|jpe?g|webp)$/i.test(ham_yol)) continue;
      const tam = path.isAbsolute(ham_yol) ? ham_yol : path.resolve(outDir, ham_yol);
      yollar.push(tam);
    }
  }
  return yollar;
}

/**
 * Agent'ın bildirdiği çıktı yolları: görev metni "CIKTI: <tam yol>" satırı
 * ister. Sandbox agent'ın hedefe KOPYALAMASINA izin vermese bile yolu
 * YAZMASINA engel yok — kopyayı sandbox'sız çalışan biz yaparız. Her sohbet
 * yalnız kendi dosyasını bildirdiği için paralel üretimde eşleşme kesindir.
 */
function bildirilenYollar(ham, outDir) {
  const metinler = [];
  let jsonlVar = false;
  for (const satir of String(ham || '').split('\n')) {
    const t = satir.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = JSON.parse(t);
      jsonlVar = true;
      const it = o.item || o;
      if (it.type === 'agent_message' && it.text) metinler.push(it.text);
    } catch {
      /* JSON olmayan satır */
    }
  }
  if (!jsonlVar) metinler.push(String(ham || '')); // düz metin çıktı modu
  const yollar = [];
  const kalip = /CIKTI:\s*"?([^\n"']+\.(?:png|jpe?g|webp))"?/gi;
  for (const metin of metinler) {
    for (const es of metin.matchAll(kalip)) {
      const y = es[1].trim();
      yollar.push(path.isAbsolute(y) ? y : path.resolve(outDir, y));
    }
  }
  return yollar;
}

/** Codex çıktısından üretilen dosyaları bulur, gerekirse iş klasörüne taşır. */
export function dosyalariTopla(ham, { outDir, baseName, oncesi, baslangic, hesap }) {
  const yollar = new Set();

  // 0a) Agent'ın "CIKTI:" satırıyla bildirdiği yollar — sohbet kendi
  // dosyasını bildirir, paralel üretimde en kesin eşleşme.
  for (const y of bildirilenYollar(ham, outDir)) {
    if (fs.existsSync(y) && !oncesi.has(path.basename(y))) yollar.add(y);
  }

  // 0) --json akışının file_change kayıtları: bu turda yazılan dosyaların
  // KESİN yolları — varsa tahmine (yol 2/3) hiç gerek kalmaz.
  for (const y of jsonlDosyaYollari(ham, outDir)) {
    if (fs.existsSync(y) && !oncesi.has(path.basename(y))) yollar.add(y);
  }

  // 1) Şemalı cevaptaki yollar — üretimden önce de var olan dosyaları alma.
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

  // 2) Çıktı klasöründe beliren yeni dosyalar — SADECE kendi baseName'imiz,
  // sıkı kalıpla (tam ad veya -N eki). Gevşek startsWith, Codex'in yazdığı
  // türev/ara dosyaları da sahiplenip task'a çoklu dosya sızdırıyordu.
  const adKalibi = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(-\\d+)?\\.(png|jpe?g|webp)$`, 'i');
  for (const dosya of gorselDosyalari(outDir)) {
    if (!oncesi.has(dosya) && adKalibi.test(dosya)) yollar.add(path.join(outDir, dosya));
  }

  // 3) Codex kendi klasörüne bırakıp kopyalamadıysa oradan YALNIZ EN YENİSİNİ
  // al: sohbet modunda aynı hesabın paralel sohbetleri de generated_images'a
  // yazar — "bu turda oluşan her görsel benimdir" demek başka task'ın
  // çıktısını da sahiplenip Telegram'a kopya olarak taşıyordu.
  if (!yollar.size) {
    // Aynı hesapta BAŞKA üretim de sürüyorsa ortak klasördeki "en yeni"
    // görsel pekala onunki olabilir — almak yanlış eşleşme (kare 01'e kare
    // 04'ün görseli) üretir. Belirsizlikte alma: hata → normal retry.
    if ((aktifUretimler.get(codexKoku(hesap)) || 0) > 1) {
      const e = new Error(
        'Codex çıktısı bulunamadı (paralel üretim sürerken ortak klasörden alınmaz) — yeniden denenecek.'
      );
      e.sohbetiKoru = true; // sohbet çürümedi; dosya toplama sorunu
      throw e;
    }
    const kalanlar = codexCiktilari(baslangic, hesap).slice(-1);
    for (const kaynak of kalanlar) {
      const varis = path.join(outDir, `${baseName}${path.extname(kaynak) || '.png'}`);
      fs.copyFileSync(kaynak, varis);
      yollar.add(varis);
    }
  }

  let gecerli = [...yollar].filter((y) => fs.existsSync(y) && fs.statSync(y).size > 1024);
  // Codex bir turda TEK görsel üretir: birden çok aday kaldıysa (agent'ın
  // ara/türev kayıtları) yalnız ilki (en güvenilir kaynak sırası: şemalı
  // cevap → hedef yol) task'a yazılır — çoklu dosya Telegram'da kopya olur.
  if (gecerli.length > 1) {
    log.warn(`[chatgpt-codex] ${gecerli.length} aday çıktıdan yalnız ilki alındı (${baseName})`);
    gecerli = gecerli.slice(0, 1);
  }
  if (!gecerli.length) {
    // Görsel servisi erişimi reddettiyse (403 / yetkilendirme) bu hesap şu an
    // üretemiyor demektir — genelde görsel kotası dolmuştur ama Codex bunu
    // "usage limit" metniyle DEĞİL servis hatasıyla veriyor. Havuzun
    // failover'ı tetiklensin diye limit hatası olarak sınıflandırılır.
    if (/403|forbidden|yetkilendir|authorization|unauthorized|erişim hata/i.test(ham)) {
      const e = new Error('Codex görsel servisi erişimi reddetti (403) — hesabın görsel kotası dolmuş olabilir.');
      e.limitDolu = true;
      e.resetsAt = Date.now() + 30 * 60 * 1000;
      throw e;
    }
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
    try {
      fs.copyFileSync(kaynak, varis);
    } catch (e) {
      throw new Error(`Codex çıktısı iş klasörüne kopyalanamadı (${kaynak}): ${e.message}`);
    }
    // Kopya gerçekten diske düştü mü? Task'ı dosyasız "done" işaretlemektense
    // hata verip yeniden denemek yeğdir — panelde boş kare bırakmasın.
    if (!fs.existsSync(varis) || fs.statSync(varis).size < 1024) {
      throw new Error(`Codex çıktısı kopyalandı ama okunamıyor: ${path.basename(varis)}`);
    }
    log.info(`[chatgpt-codex] çıktı iş klasörüne alındı: ${path.basename(kaynak)} → ${path.basename(varis)}`);
    return varis;
  });

  return dosyalar.map((y) => path.basename(y));
}
