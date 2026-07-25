import { contextAc, sayfaAl, bekle } from './browser.js';
import { adaptorAl } from './adapters/index.js';
import { jobYaz, manifestYaz, durumuHesapla } from './store.js';
import { varyantDizini, taskVaryantlariniUret } from './varyant.js';
import * as havuz from './havuz.js';
import { log } from './logger.js';

// Tüm hesaplar limitteyse ve en erken açılış bundan uzaksa task beklemez,
// pending kalır (kullanıcı sonra başlatır). Yakınsa worker bekleyip devam eder.
const HESAP_BEKLEME_ESIGI = 8 * 60 * 1000;

/** Reset zamanını "14:30" gibi okunur saate çevirir. */
function saatEtiketi(ms) {
  if (!ms) return 'bilinmiyor';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Bir task'ı işler. Havuzdan hesap kiralar; hesap kota hatası verirse onu
 * `resets_at`'e göre dinlenmeye alıp **denemeyi harcamadan** başka hesaba
 * geçer (failover). Gerçek üretim hatası normal retry sayılır.
 *
 * Dönüş: 'done' | 'failed' | 'pending' (tüm hesaplar limitte / durduruldu).
 */
async function taskiIsleHavuz(job, task, adaptor, platformAdi, platform, hesaplar, sel, ayarlar, signal, hazirlanan) {
  while (task.attempts < ayarlar.maxAttempts) {
    if (signal?.aborted) {
      task.status = 'pending';
      task.error = null;
      jobYaz(job);
      return 'pending';
    }

    // 1) Failover sırasıyla uygun bir hesap kirala.
    const hesap = havuz.kirala(platformAdi, hesaplar);
    if (!hesap) {
      const erken = havuz.enErkenAcilis(platformAdi, hesaplar);
      if (erken === null) {
        // Uygun hesap var ama slotları başka worker'larca dolu — kısa bekle.
        await bekle(1500, signal);
        continue;
      }
      const kalan = erken - Date.now();
      if (kalan > HESAP_BEKLEME_ESIGI) {
        task.status = 'pending';
        task.error = `Tüm ${platformAdi} hesapları limitte — ${saatEtiketi(erken)}'de otomatik sürecek.`;
        // Bekçi (server) bu işareti görüp reset olunca işi kendiliğinden başlatır.
        task.limitBekliyor = true;
        task.limitAcilis = erken;
        jobYaz(job);
        manifestYaz(job);
        log.warn(`[${platformAdi}] ${task.id} bekletildi — hesaplar ${saatEtiketi(erken)}'e kadar limitte`);
        return 'pending';
      }
      await bekle(Math.min(kalan + 1000, 30000), signal);
      continue;
    }

    // 2) Hesap ilk kez kullanılıyorsa hazırla (Codex girişi / köprü servisi).
    if (!hazirlanan.has(hesap.ad)) {
      try {
        await adaptor.hazirla(null, platform, sel, ayarlar, hesap);
        hazirlanan.add(hesap.ad);
        log.ok(`[${platformAdi}] hesap hazır: ${hesap.ad}`);
      } catch (e) {
        havuz.birak(platformAdi, hesap.ad);
        // Bu hesabın oturumu/kurulumu bozuk — dinlenmeye al, ötekine geç.
        // Hata reset zamanı verdiyse (oturum çürük → 30 dk) onu kullan.
        const resetsAt = e.resetsAt || Date.now() + 30 * 60 * 1000;
        havuz.dinlenmeyeAl(platformAdi, hesap.ad, resetsAt, `hazırlık: ${e.message}`);
        log.err(`[${platformAdi}] hesap ${hesap.ad} hazırlanamadı: ${e.message}`);
        continue;
      }
    }

    // 3) Üret. Uygun hesap bulundu — limit-bekleme işareti temizlenir.
    task.attempts += 1;
    task.status = 'running';
    task.startedAt = new Date().toISOString();
    task.error = null;
    task.hesap = hesap.ad;
    task.limitBekliyor = false;
    task.limitAcilis = null;
    jobYaz(job);

    try {
      log.info(`[${platformAdi}:${hesap.ad}] ${task.id} → üretim (deneme ${task.attempts}/${ayarlar.maxAttempts})`);
      const dosyalar = await adaptor.uret(null, {
        imagePath: job.inputImage,
        prompt: task.prompt,
        outDir: varyantDizini(job, 'uretim'),
        baseName: `${task.id}-${platformAdi}`,
        sel,
        ayarlar,
        platform,
        signal,
        hesap,
      });
      havuz.birak(platformAdi, hesap.ad);
      task.files = dosyalar;
      task.status = 'done';
      task.finishedAt = new Date().toISOString();
      try {
        await taskVaryantlariniUret(job, task);
      } catch (e) {
        log.warn(`[${platformAdi}] ${task.id} demo damgası üretilemedi: ${e.message}`);
      }
      jobYaz(job);
      manifestYaz(job);
      log.ok(`[${platformAdi}:${hesap.ad}] ${task.id} ✓ ${dosyalar.join(', ')}`);
      return 'done';
    } catch (e) {
      havuz.birak(platformAdi, hesap.ad);

      if (signal?.aborted) {
        task.status = 'pending';
        task.error = null;
        jobYaz(job);
        log.info(`[${platformAdi}] ${task.id} durduruldu`);
        return 'pending';
      }

      // Hesap kullanılamaz (kota dolu VEYA oturum geçersiz): dinlenmeye al,
      // denemeyi HARCAMA, başka hesaba geç.
      if (e.limitDolu) {
        task.attempts -= 1;
        havuz.dinlenmeyeAl(platformAdi, hesap.ad, e.resetsAt, e.message);
        const ne = e.resetsAt ? `${saatEtiketi(e.resetsAt)}'e kadar` : '(reset okunamadı, ~1s)';
        const sebep = e.sebep === 'oturum' ? 'oturum geçersiz' : 'limit doldu';
        log.warn(`[${platformAdi}:${hesap.ad}] ${sebep} ${ne} — başka hesaba geçiliyor`);
        task.status = 'pending';
        jobYaz(job);
        continue;
      }

      // Gerçek üretim hatası → normal retry.
      task.error = String(e?.message || e);
      task.finishedAt = new Date().toISOString();
      const sonMu = task.attempts >= ayarlar.maxAttempts;
      task.status = sonMu ? 'failed' : 'pending';
      jobYaz(job);
      manifestYaz(job);
      log.warn(`[${platformAdi}:${hesap.ad}] ${task.id} ✗ ${task.error}`);
      if (sonMu) {
        log.err(`[${platformAdi}] ${task.id} deneme hakkı bitti → failed`);
        return 'failed';
      }
      await bekle(ayarlar.retryBackoffMs * task.attempts, signal);
    }
  }
  return task.status === 'done' ? 'done' : 'failed';
}

/**
 * Tarayıcısız platform kuyruğu (Codex, gemini-http) — hesap havuzuyla.
 * Worker sayısı = tüm hesapların toplam eşzamanlı slotu; her worker kuyruktan
 * task çeker, havuzdan hesap kiralar, işler. Hesaplar limite çarptıkça
 * failover ile taze hesaba kayar.
 */
async function havuzluKuyruk(job, platformAdi, platform, tasklar, sel, adaptor, ayarlar, secenekler) {
  const hesaplar = platform.hesaplar || [];
  const kuyruk = tasklar.filter((t) => t.status !== 'done');
  const toplamSlot = hesaplar.reduce((n, h) => n + Math.max(1, Number(h.concurrency) || 1), 0);
  const isciSayisi = Math.max(1, Math.min(toplamSlot, kuyruk.length));
  const hazirlanan = new Set();

  log.info(
    `[${platformAdi}] ${adaptor.ad} — ${kuyruk.length} task, ${hesaplar.length} hesap, ${isciSayisi} paralel slot`
  );

  let sonraki = 0;
  await Promise.all(
    Array.from({ length: isciSayisi }, async () => {
      while (true) {
        if (secenekler.signal?.aborted) return;
        const task = kuyruk[sonraki++];
        if (!task) return;
        await taskiIsleHavuz(
          job, task, adaptor, platformAdi, platform, hesaplar, sel, ayarlar, secenekler.signal, hazirlanan
        );
      }
    })
  );
}

/**
 * Tarayıcılı platform kuyruğu (yedek chatgpt/gemini sürücüleri) — tek oturum,
 * havuz yok. Bir kez tarayıcı açılır, concurrency kadar sekme task çeker.
 */
async function tarayiciliKuyruk(job, platformAdi, platform, tasklar, sel, adaptor, ayarlar, secenekler) {
  const kuyruk = tasklar.filter((t) => t.status !== 'done');
  const esZamanli = Math.max(1, Math.min(Number(platform.concurrency ?? ayarlar.concurrency ?? 2), kuyruk.length));
  let ctx;
  try {
    log.info(`[${platformAdi}] tarayıcı açılıyor — ${kuyruk.length} task, ${esZamanli} sekme paralel`);
    ctx = await contextAc(platform, ayarlar, secenekler);
    const ilkSayfa = await sayfaAl(ctx);
    await adaptor.hazirla(ilkSayfa, platform, sel, ayarlar);
    log.ok(`[${platformAdi}] oturum hazır`);
    const isciler = [ilkSayfa];
    for (let i = 1; i < esZamanli; i++) isciler.push(await ctx.newPage());

    let sonraki = 0;
    await Promise.all(
      isciler.map(async (isci) => {
        while (true) {
          if (secenekler.signal?.aborted) return;
          const task = kuyruk[sonraki++];
          if (!task) return;
          await taskiIsleBasit(job, task, isci, adaptor, platformAdi, sel, ayarlar, secenekler.signal);
        }
      })
    );
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
}

/** Tarayıcılı sürücü için basit tek-oturum task işleme (havuzsuz). */
async function taskiIsleBasit(job, task, page, adaptor, platformAdi, sel, ayarlar, signal) {
  while (task.attempts < ayarlar.maxAttempts) {
    if (signal?.aborted) {
      task.status = 'pending';
      task.error = null;
      jobYaz(job);
      return;
    }
    task.attempts += 1;
    task.status = 'running';
    task.startedAt = new Date().toISOString();
    task.error = null;
    jobYaz(job);
    try {
      const dosyalar = await adaptor.uret(page, {
        imagePath: job.inputImage,
        prompt: task.prompt,
        outDir: varyantDizini(job, 'uretim'),
        baseName: `${task.id}-${platformAdi}`,
        sel,
        ayarlar,
        platform: ayarlar.platforms[platformAdi],
        signal,
      });
      task.files = dosyalar;
      task.status = 'done';
      task.finishedAt = new Date().toISOString();
      try {
        await taskVaryantlariniUret(job, task);
      } catch (e) {
        log.warn(`[${platformAdi}] ${task.id} demo damgası üretilemedi: ${e.message}`);
      }
      jobYaz(job);
      manifestYaz(job);
      log.ok(`[${platformAdi}] ${task.id} ✓ ${dosyalar.join(', ')}`);
      return;
    } catch (e) {
      if (signal?.aborted) {
        task.status = 'pending';
        task.error = null;
        jobYaz(job);
        return;
      }
      task.error = String(e?.message || e);
      task.finishedAt = new Date().toISOString();
      const sonMu = task.attempts >= ayarlar.maxAttempts;
      task.status = sonMu ? 'failed' : 'pending';
      jobYaz(job);
      manifestYaz(job);
      log.warn(`[${platformAdi}] ${task.id} ✗ ${task.error}`);
      if (sonMu) return;
      const limitMi = /rate limit|too many|limit for|kota|try again later/i.test(task.error);
      await bekle(ayarlar.retryBackoffMs * task.attempts * (limitMi ? 6 : 1), signal);
    }
  }
}

/** Tek platformun task kuyruğunu işler (havuzlu veya tarayıcılı). */
async function platformKuyrugu(job, platformAdi, tasklar, ayarlar, secenekler) {
  const platform = ayarlar.platforms[platformAdi];
  if (!platform || platform.enabled === false) {
    for (const t of tasklar) {
      t.status = 'failed';
      t.error = `Platform kapalı veya tanımsız: ${platformAdi}`;
      t.finishedAt = new Date().toISOString();
    }
    jobYaz(job);
    return;
  }

  const sel = ayarlar.selectors[platformAdi] || {};
  const adaptor = adaptorAl(platform.adapter || platformAdi);

  try {
    if (adaptor.tarayiciGerekli === false) {
      await havuzluKuyruk(job, platformAdi, platform, tasklar, sel, adaptor, ayarlar, secenekler);
    } else {
      await tarayiciliKuyruk(job, platformAdi, platform, tasklar, sel, adaptor, ayarlar, secenekler);
    }
  } catch (e) {
    const mesaj = String(e?.message || e);
    log.err(`[${platformAdi}] platform hatası: ${mesaj}`);
    for (const t of tasklar) {
      if (t.status !== 'done') {
        t.error = mesaj;
        t.status = t.attempts >= ayarlar.maxAttempts ? 'failed' : 'pending';
      }
    }
    jobYaz(job);
  }
}

/** Bir job'ın bekleyen tüm task'larını işler. */
export async function jobuCalistir(job, ayarlar, secenekler = {}) {
  const bekleyen = job.tasks.filter((t) => t.status === 'pending' || t.status === 'running');
  if (bekleyen.length === 0) {
    log.info(`${job.id}: bekleyen task yok.`);
    return job;
  }

  const gruplar = new Map();
  for (const t of bekleyen) {
    if (!gruplar.has(t.platform)) gruplar.set(t.platform, []);
    gruplar.get(t.platform).push(t);
  }

  log.info(
    `${job.id} başlıyor — ${bekleyen.length} task / ${gruplar.size} platform (${[...gruplar.keys()].join(', ')})`
  );

  const isler = [...gruplar.entries()].map(
    ([platformAdi, tasklar]) => () => platformKuyrugu(job, platformAdi, tasklar, ayarlar, secenekler)
  );

  if (ayarlar.parallelPlatforms) {
    await Promise.all(isler.map((f) => f()));
  } else {
    for (const f of isler) await f();
  }

  job.status = durumuHesapla(job);
  jobYaz(job);
  const m = manifestYaz(job);
  if (secenekler.signal?.aborted) {
    log.warn(
      `${job.id} durduruldu — tamam: ${m.ozet.tamamlanan}, bekleyen: ${m.ozet.bekleyen} (yeniden başlatılabilir)`
    );
  } else {
    log.ok(
      `${job.id} bitti — durum: ${job.status} | tamam: ${m.ozet.tamamlanan}, hata: ${m.ozet.basarisiz}, bekleyen: ${m.ozet.bekleyen}`
    );
  }
  log.info(`Çıktı: ${job.outputDir}`);
  return job;
}
