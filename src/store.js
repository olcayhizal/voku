import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { JOBS_DIR } from './paths.js';

fs.mkdirSync(JOBS_DIR, { recursive: true });

/** Job her diske yazıldığında 'job' olayı — panel canlı güncellemesi buradan beslenir. */
export const olaylar = new EventEmitter();
olaylar.setMaxListeners(50);

export function jobYolu(id) {
  return path.join(JOBS_DIR, `${id}.json`);
}

export function jobVarMi(id) {
  return fs.existsSync(jobYolu(id));
}

export function jobYaz(job) {
  job.updatedAt = new Date().toISOString();
  const hedef = jobYolu(job.id);
  const gecici = `${hedef}.tmp`;
  fs.writeFileSync(gecici, JSON.stringify(job, null, 2));
  fs.renameSync(gecici, hedef); // atomic
  olaylar.emit('job', job);
  return job;
}

export function jobOku(id) {
  const p = jobYolu(id);
  if (!fs.existsSync(p)) throw new Error(`Job bulunamadı: ${id}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function jobListele() {
  if (!fs.existsSync(JOBS_DIR)) return [];
  return fs
    .readdirSync(JOBS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), 'utf8')))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** Bekleyen işi olan ilk job'lar (pending/running/partial). */
export function bekleyenJoblar() {
  return jobListele().filter((j) =>
    j.tasks.some((t) => t.status === 'pending' || t.status === 'running')
  );
}

/**
 * Baskı seçimi özeti. `job.baskiSecim` dosya adına göre tutulur:
 *   { "<dosya>": { secili: bool, basildi: bool, seciliAt, basildiAt } }
 * Dosya adı üç varyantta da aynı olduğu için tek anahtar yeter.
 */
/**
 * Bir dosyanın baskı kaydını normalize eder.
 * `basildi` bayrağı tek başına yetmiyor: bir görselin 3 kopyası istenip
 * ikisi basılmış olabilir (gruplar 6'şarlı dolduğu için kopyalar bölünür).
 * Bu yüzden gerçek durum `basiliAdet` sayacında; `basildi` ondan türetilir.
 */
export function baskiKaydi(job, dosya) {
  const ham = job.baskiSecim?.[dosya] || {};
  const adet = Math.max(1, Number(ham.adet) || 1);
  const basiliAdet = Math.min(
    adet,
    Math.max(0, Number(ham.basiliAdet ?? (ham.basildi ? adet : 0)) || 0)
  );
  return {
    dosya,
    secili: Boolean(ham.secili),
    adet,
    basiliAdet,
    basildi: basiliAdet >= adet,
    bekleyen: Math.max(0, adet - basiliAdet),
    seciliAt: ham.seciliAt || null,
    basildiAt: ham.basildiAt || null,
  };
}

export function baskiOzetiCikar(job) {
  const tumDosyalar = job.tasks.flatMap((t) => t.files || []);
  const kayitlar = tumDosyalar.map((d) => baskiKaydi(job, d)).filter((k) => k.secili);
  return {
    toplam: tumDosyalar.length,
    secili: kayitlar.length,
    basildi: kayitlar.filter((k) => k.basildi).length,
    // Aynı görselden birden fazla kopya istenebilir; kopya ayrı sayılır.
    kopya: kayitlar.reduce((n, k) => n + k.adet, 0),
    basiliKopya: kayitlar.reduce((n, k) => n + k.basiliAdet, 0),
  };
}

/** Job durumunu task'lardan türetir. */
export function durumuHesapla(job) {
  const d = job.tasks.map((t) => t.status);
  if (d.every((s) => s === 'done')) return 'done';
  if (d.every((s) => s === 'failed')) return 'failed';
  if (d.every((s) => s === 'pending')) return 'pending';
  if (d.some((s) => s === 'running')) return 'running';
  if (d.some((s) => s === 'pending')) return 'partial';
  return 'partial'; // done + failed karışık
}

/** Çıktı klasörüne manifest.json yazar (insan-okur özet). */
export function manifestYaz(job) {
  const manifest = {
    jobId: job.id,
    telefon: job.phone,
    kaynak: job.kaynak || 'panel',
    olusturma: job.createdAt,
    inputFotograf: job.inputImage,
    durum: durumuHesapla(job),
    ozet: {
      toplam: job.tasks.length,
      tamamlanan: job.tasks.filter((t) => t.status === 'done').length,
      basarisiz: job.tasks.filter((t) => t.status === 'failed').length,
      bekleyen: job.tasks.filter((t) => t.status === 'pending').length,
    },
    tasklar: job.tasks.map((t) => ({
      id: t.id,
      promptId: t.promptId,
      platform: t.platform,
      prompt: t.prompt,
      durum: t.status,
      deneme: t.attempts,
      dosyalar: t.files,
      hata: t.error,
      baski: (t.files || []).map((d) => baskiKaydi(job, d)),
    })),
    baskiOzet: baskiOzetiCikar(job),
  };
  fs.mkdirSync(job.outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(job.outputDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );
  return manifest;
}
