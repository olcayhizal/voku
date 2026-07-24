import { contextAc, sayfaAl, bekle } from './browser.js';
import { adaptorAl } from './adapters/index.js';
import { jobYaz, manifestYaz, durumuHesapla } from './store.js';
import { varyantDizini, taskVaryantlariniUret } from './varyant.js';
import { log } from './logger.js';

/**
 * Tek bir task'ı verilen sekmede işler; hata olursa maxAttempts'e kadar
 * backoff ile tekrar dener. Task state'i her adımda diske yazılır.
 */
async function taskiIsle(job, task, page, adaptor, platformAdi, sel, ayarlar, signal) {
  while (task.attempts < ayarlar.maxAttempts) {
    if (signal?.aborted) {
      // Durdurulduysa task bekliyor kalsın — yeniden başlatılabilir olmalı.
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
      log.info(
        `[${platformAdi}] ${task.id} → üretim (deneme ${task.attempts}/${ayarlar.maxAttempts})`
      );
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

      // Demo (damgalı) hali üretimin hemen ardından hazırlanır — panelde
      // sekme değiştirince beklemesin. Başarısız olursa üretim korunur.
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
        // Durdurma sırasında oluşan hata "arıza" değil — task bekliyor kalır.
        task.status = 'pending';
        task.error = null;
        jobYaz(job);
        log.info(`[${platformAdi}] ${task.id} durduruldu`);
        return;
      }
      task.error = String(e?.message || e);
      task.finishedAt = new Date().toISOString();
      const sonMu = task.attempts >= ayarlar.maxAttempts;
      task.status = sonMu ? 'failed' : 'pending';
      jobYaz(job);
      manifestYaz(job);
      log.warn(`[${platformAdi}] ${task.id} ✗ ${task.error}`);
      if (sonMu) {
        log.err(`[${platformAdi}] ${task.id} deneme hakkı bitti → failed`);
        return;
      }
      // Kota/limit hatasında beklemeyi uzat — hemen tekrar denemek limiti derinleştirir.
      const limitMi = /rate limit|too many|limit for|kota|deneme sınırı|try again later/i.test(
        task.error
      );
      await bekle(ayarlar.retryBackoffMs * task.attempts * (limitMi ? 6 : 1), signal);
    }
  }
}

/**
 * Tek platformun task kuyruğunu işler.
 * Tarayıcı bir kez açılır; concurrency kadar SEKME açılıp her sekme kuyruktan
 * task çeker (worker havuzu). Sekmeler aynı context'i, dolayısıyla aynı
 * oturumu paylaşır.
 */
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
  // Platform hangi sürücüyle koşacağını seçebilir (tarayıcı ↔ Codex geçişi).
  const adaptor = adaptorAl(platform.adapter || platformAdi);
  const tarayiciIle = adaptor.tarayiciGerekli !== false;
  let ctx;

  const kuyruk = tasklar.filter((t) => t.status !== 'done');
  const esZamanli = Math.max(
    1,
    Math.min(
      Number(platform.concurrency ?? ayarlar.concurrency ?? 2),
      kuyruk.length
    )
  );

  try {
    // Tarayıcılı sürücüde her worker bir SEKME; tarayıcısız sürücüde (Codex)
    // sekme yok, worker doğrudan alt süreç çalıştırır.
    let isciler;
    if (tarayiciIle) {
      log.info(
        `[${platformAdi}] tarayıcı açılıyor — ${kuyruk.length} task, ${esZamanli} sekme paralel`
      );
      ctx = await contextAc(platform, ayarlar, secenekler);
      const ilkSayfa = await sayfaAl(ctx);
      await adaptor.hazirla(ilkSayfa, platform, sel, ayarlar);
      log.ok(`[${platformAdi}] oturum hazır`);
      isciler = [ilkSayfa];
      for (let i = 1; i < esZamanli; i++) isciler.push(await ctx.newPage());
    } else {
      log.info(
        `[${platformAdi}] ${adaptor.ad} sürücüsü (tarayıcısız) — ${kuyruk.length} task, ${esZamanli} paralel`
      );
      await adaptor.hazirla(null, platform, sel, ayarlar);
      log.ok(`[${platformAdi}] sürücü hazır`);
      isciler = Array.from({ length: esZamanli }, () => null);
    }

    // Worker havuzu: her worker kuyruktan sıradaki task'ı çeker.
    let sonraki = 0;
    await Promise.all(
      isciler.map(async (isci) => {
        while (true) {
          if (secenekler.signal?.aborted) return;
          const task = kuyruk[sonraki++]; // tek thread — yarış yok
          if (!task) return;
          await taskiIsle(job, task, isci, adaptor, platformAdi, sel, ayarlar, secenekler.signal);
        }
      })
    );
  } catch (e) {
    // Oturum/tarayıcı seviyesinde hata → bu platformun kalan task'ları bekliyor kalır
    const mesaj = String(e?.message || e);
    log.err(`[${platformAdi}] platform hatası: ${mesaj}`);
    for (const t of tasklar) {
      if (t.status !== 'done') {
        t.error = mesaj;
        t.status = t.attempts >= ayarlar.maxAttempts ? 'failed' : 'pending';
      }
    }
    jobYaz(job);
  } finally {
    if (ctx) await ctx.close().catch(() => {});
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
    ([platformAdi, tasklar]) => () =>
      platformKuyrugu(job, platformAdi, tasklar, ayarlar, secenekler)
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
