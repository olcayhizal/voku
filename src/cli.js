#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { ayarlariYukle, promptlariYukle } from './config.js';
import { jobOlustur } from './job.js';
import {
  jobOku,
  jobListele,
  jobYaz,
  bekleyenJoblar,
  manifestYaz,
  durumuHesapla,
} from './store.js';
import { jobuCalistir } from './runner.js';
import { contextAc, sayfaAl } from './browser.js';
import { log } from './logger.js';
import { OUTPUT_DIR } from './paths.js';

function argAyristir(argv) {
  const komut = argv[0];
  const pozisyonel = [];
  const opsiyon = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) opsiyon[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) opsiyon[k] = argv[++i];
      else opsiyon[k] = true;
    } else pozisyonel.push(a);
  }
  return { komut, pozisyonel, opsiyon };
}

function yardim() {
  console.log(`
voku — fotoğraftan ChatGPT + Gemini üyelikleri üzerinden görsel üretim hattı

KOMUTLAR
  login <platform>              Platforma elle giriş yap (oturum profile kaydedilir)
                                  platform: chatgpt | gemini

  new --image <yol> [--phone <no>] [--prompts <dosya>] [--note <metin>] [--run]
                                Yeni job oluşturur. Telefon yoksa 000 ile
                                başlayan id üretilir. --run ile hemen çalıştırır.

  run [jobId] [--all] [--headless]
                                Bekleyen job'ları çalıştırır. jobId verilmezse
                                bekleyen ilk job; --all ile hepsi.

  status [jobId]                Job listesi veya tek job detayı.

  retry <jobId> [--task <taskId>] [--failed] [--all]
                                Başarısız task'ları tekrar sıraya alır.

  prompts [--prompts <dosya>]   Prompt listesini doğrular ve özetler.

  panel [--port 4173] [--open] [--no-telegram]
                                Web panelini açar: oturum, prompt ve iş yönetimi
                                tek ekranda; canlı ilerleme + kontak baskısı.
                                Telegram botu da bu süreçte dinler.

  telegram                      Botu panelsiz dinletir (aynı token iki yerde
                                aynı anda dinleyemez — panel açıksa gerekmez).

  guncelle [--kontrol] [--otomatik acik|kapali]
                                GitHub'daki sürümü çeker. --kontrol yalnız
                                bakar, --otomatik açılışta kendiliğinden
                                güncellemeyi ayarlar.

  baglanti [--adres <url>] [--yenile]
                                Paylaşım bağlantısını yazar (tam yetki).
                                --adres ile tünel adresini birleştirir,
                                --yenile eski bağlantıyı geçersiz kılar.

  temizle [jobId] [--all]       Gemini çıktılarındaki görünür logoyu siler.
                                jobId verilmezse son job; --all ile hepsi.
                                (Yeni üretimlerde otomatik yapılır.)

  varyant [jobId] [--all] [--yeniden]
                                Eksik demo (damgalı) hallerini üretir; eski düz
                                yapıdaki çıktıları uretim/ altına taşır.
                                --yeniden ile var olan demoları da yeniler.

Ayarlar: config/settings.json   Prompt listesi: config/prompts.json
`);
}

async function enterBekle(mesaj) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((r) => rl.question(mesaj, () => r()));
  rl.close();
}

async function komutLogin(pozisyonel, ayarlar) {
  const ad = pozisyonel[0];
  const platform = ayarlar.platforms[ad];
  if (!platform) {
    log.err(`Bilinmeyen platform: ${ad}. Tanımlı: ${Object.keys(ayarlar.platforms).join(', ')}`);
    process.exit(1);
  }
  log.info(`${ad} açılıyor — tarayıcıda giriş yap, sonra buraya dön.`);
  const ctx = await contextAc(platform, ayarlar, { headless: false });
  const page = await sayfaAl(ctx);
  await page.goto(platform.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await enterBekle('\nGiriş tamamlandıysa ENTER’a bas (oturum profile kaydedilecek)... ');
  await ctx.close();
  log.ok(`${ad} oturumu kaydedildi: ${platform.profileDir}`);
}

async function komutNew(opsiyon, ayarlar) {
  if (!opsiyon.image) {
    log.err('--image zorunlu (input fotoğrafın yolu).');
    process.exit(1);
  }
  const promptlar = promptlariYukle(opsiyon.prompts, ayarlar);
  const job = await jobOlustur({
    imagePath: opsiyon.image,
    phone: opsiyon.phone === true ? null : opsiyon.phone,
    prompts: promptlar,
    note: opsiyon.note === true ? null : opsiyon.note,
  });
  log.ok(`Job oluşturuldu: ${job.id}`);
  log.info(`  telefon : ${job.phone || `(yok → ${job.fakeId})`}`);
  log.info(`  fotoğraf: ${job.inputImage}`);
  log.info(`  task    : ${job.tasks.length} (${promptlar.length} prompt)`);
  log.info(`  çıktı   : ${job.outputDir}`);
  return job;
}

async function komutRun(pozisyonel, opsiyon, ayarlar) {
  const secenekler = {};
  if (opsiyon.headless) {
    secenekler.headless = true;
    log.warn(
      'Uyarı: headless modda ChatGPT/Gemini bot kontrolüne takılıyor ("Bir dakika lütfen…"). Üretim büyük ihtimalle başarısız olur.'
    );
  }

  let hedefler;
  if (pozisyonel[0]) hedefler = [jobOku(pozisyonel[0])];
  else if (opsiyon.all) hedefler = bekleyenJoblar();
  else {
    const b = bekleyenJoblar();
    hedefler = b.length ? [b[0]] : [];
  }

  if (!hedefler.length) {
    log.info('Bekleyen job yok.');
    return;
  }
  for (const job of hedefler) {
    await jobuCalistir(job, ayarlar, secenekler);
  }
}

function durumRozeti(s) {
  return { done: '✓ tamam', failed: '✗ hata', running: '… çalışıyor', pending: '· bekliyor', partial: '± kısmi' }[s] || s;
}

function komutStatus(pozisyonel) {
  if (pozisyonel[0]) {
    const job = jobOku(pozisyonel[0]);
    console.log(`\nJob ${job.id}  [${durumRozeti(durumuHesapla(job))}]`);
    console.log(`  oluşturma: ${job.createdAt}`);
    console.log(`  telefon  : ${job.phone || `(yok → ${job.fakeId})`}`);
    console.log(`  fotoğraf : ${job.inputImage}`);
    console.log(`  çıktı    : ${job.outputDir}\n`);
    for (const t of job.tasks) {
      const dosya = t.files.length ? ` → ${t.files.join(', ')}` : '';
      const hata = t.error ? `  ⚠ ${t.error}` : '';
      console.log(
        `  ${durumRozeti(t.status).padEnd(12)} ${t.id.padEnd(24)} ${t.platform.padEnd(8)} d:${t.attempts}${dosya}${hata}`
      );
    }
    console.log('');
    return;
  }

  const hepsi = jobListele();
  if (!hepsi.length) {
    console.log('Henüz job yok. `node src/cli.js new --image <foto>` ile başla.');
    return;
  }
  console.log('');
  for (const j of hepsi) {
    const tamam = j.tasks.filter((t) => t.status === 'done').length;
    const hata = j.tasks.filter((t) => t.status === 'failed').length;
    console.log(
      `  ${j.id.padEnd(26)} ${durumRozeti(durumuHesapla(j)).padEnd(12)} ${tamam}/${j.tasks.length} tamam` +
        (hata ? `, ${hata} hata` : '')
    );
  }
  console.log('');
}

function komutRetry(pozisyonel, opsiyon) {
  const job = jobOku(pozisyonel[0]);
  let sayac = 0;
  for (const t of job.tasks) {
    const secili =
      (opsiyon.task && t.id === opsiyon.task) ||
      (opsiyon.all && true) ||
      (!opsiyon.task && t.status === 'failed');
    if (!secili) continue;
    t.status = 'pending';
    t.attempts = 0;
    t.error = null;
    sayac++;
  }
  job.status = durumuHesapla(job);
  jobYaz(job);
  manifestYaz(job);
  log.ok(`${job.id}: ${sayac} task yeniden sıraya alındı. \`run ${job.id}\` ile çalıştır.`);
}

/** Üretilmiş Gemini görsellerinden watermark siler (geriye dönük temizlik). */
async function komutTemizle(pozisyonel, opsiyon) {
  const { watermarkTemizle } = await import('./adapters/gemini-http.js');
  const { varyantDizini, taskVaryantlariniUret } = await import('./varyant.js');
  const hepsi = jobListele();
  let hedefler;
  if (pozisyonel[0]) hedefler = [jobOku(pozisyonel[0])];
  else if (opsiyon.all) hedefler = hepsi;
  else hedefler = hepsi.slice(-1);

  if (!hedefler.length) return log.info('Temizlenecek job yok.');

  let temiz = 0;
  let atlanan = 0;
  for (const job of hedefler) {
    for (const task of job.tasks) {
      // Watermark yalnızca Gemini çıktılarında var.
      if (task.platform !== 'gemini' || task.status !== 'done') continue;
      let degisti = false;
      for (const dosya of task.files) {
        const yol = path.join(varyantDizini(job, 'uretim'), dosya);
        if (!fs.existsSync(yol)) continue;
        try {
          await watermarkTemizle(yol);
          temiz++;
          degisti = true;
          log.ok(`${job.id}/${dosya} temizlendi`);
        } catch (e) {
          atlanan++;
          log.warn(`${job.id}/${dosya} atlandı: ${e.message}`);
        }
      }
      // Demo damgası temizlenmiş üretimden yeniden basılır, yoksa eski
      // (watermark'lı) hal demo klasöründe kalırdı.
      if (degisti) {
        await taskVaryantlariniUret(job, task, { yenidenUret: true }).catch((e) =>
          log.warn(`${job.id}/${task.id} demo yenilenemedi: ${e.message}`)
        );
      }
    }
  }
  log.info(`Bitti — ${temiz} görsel temizlendi${atlanan ? `, ${atlanan} atlandı` : ''}.`);
}

/** Varyant klasörlerini kurar, eski düz yapıyı taşır, eksik demoları üretir. */
async function komutVaryant(pozisyonel, opsiyon) {
  const { uretimeTasi, taskVaryantlariniUret, varyantSayilari } = await import('./varyant.js');
  const hepsi = jobListele();
  let hedefler;
  if (pozisyonel[0]) hedefler = [jobOku(pozisyonel[0])];
  else if (opsiyon.all) hedefler = hepsi;
  else hedefler = hepsi.slice(-1);

  if (!hedefler.length) return log.info('İşlenecek job yok.');

  for (const job of hedefler) {
    const tasinan = uretimeTasi(job);
    if (tasinan) log.info(`${job.id}: ${tasinan} dosya uretim/ altına taşındı`);

    let uretilen = 0;
    for (const task of job.tasks) {
      if (task.status !== 'done') continue;
      try {
        const yeni = await taskVaryantlariniUret(job, task, { yenidenUret: Boolean(opsiyon.yeniden) });
        uretilen += yeni.length;
      } catch (e) {
        log.warn(`${job.id}/${task.id}: ${e.message}`);
      }
    }
    const sayim = varyantSayilari(job);
    log.ok(
      `${job.id} — üretim ${sayim.uretim}, demo ${sayim.demo}${uretilen ? ` (+${uretilen} yeni)` : ''}, baskı ${sayim.baski}`
    );
  }
}

function komutPrompts(opsiyon, ayarlar) {
  const p = promptlariYukle(opsiyon.prompts, ayarlar);
  const sayim = {};
  let toplam = 0;
  for (const x of p) {
    sayim[x.platform] = (sayim[x.platform] || 0) + x.count;
    toplam += x.count;
  }
  console.log(`\n${p.length} prompt, ${toplam} üretim:`);
  for (const [plt, n] of Object.entries(sayim)) console.log(`  ${plt.padEnd(10)} ${n}`);
  console.log('');
  for (const x of p) {
    console.log(`  ${String(x.sira).padStart(2, '0')} ${x.id.padEnd(18)} ${x.platform.padEnd(8)} x${x.count}  ${x.prompt.slice(0, 60)}${x.prompt.length > 60 ? '…' : ''}`);
  }
  console.log('');
}

async function main() {
  const { komut, pozisyonel, opsiyon } = argAyristir(process.argv.slice(2));
  if (!komut || komut === 'help' || opsiyon.help) return yardim();

  const ayarlar = ayarlariYukle(opsiyon.settings);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  switch (komut) {
    case 'login':
      return komutLogin(pozisyonel, ayarlar);
    case 'new': {
      const job = await komutNew(opsiyon, ayarlar);
      if (opsiyon.run) await jobuCalistir(job, ayarlar, opsiyon.headless ? { headless: true } : {});
      return;
    }
    case 'run':
      return komutRun(pozisyonel, opsiyon, ayarlar);
    case 'status':
      return komutStatus(pozisyonel);
    case 'retry':
      return komutRetry(pozisyonel, opsiyon);
    case 'prompts':
      return komutPrompts(opsiyon, ayarlar);
    case 'temizle':
      return komutTemizle(pozisyonel, opsiyon);
    case 'varyant':
      return komutVaryant(pozisyonel, opsiyon);
    case 'panel': {
      const { paneliBaslat } = await import('./server.js');
      paneliBaslat({
        port: Number(opsiyon.port) || 4173,
        ayarlarDosyasi: opsiyon.settings,
        ac: Boolean(opsiyon.open),
        telegram: !opsiyon['no-telegram'],
      });
      return new Promise(() => {}); // sunucu kapanana dek açık kal
    }
    case 'guncelle': {
      const g = await import('./guncelleme.js');
      if (opsiyon.otomatik !== undefined) {
        const acik = opsiyon.otomatik === 'acik' || opsiyon.otomatik === true;
        g.otomatikAyarla(acik);
        log.ok(`Otomatik güncelleme ${acik ? 'açıldı' : 'kapatıldı'}.`);
        return;
      }
      if (opsiyon.kontrol) {
        const d = await g.guncellemeVarMi({ zorla: true });
        // Betikler bu satırı okuyor: <var|yok|hata>|<adet>|<mesaj>
        if (d.hata) console.log(`hata|0|${d.hata.replace(/\n/g, ' ')}`);
        else if (d.var) console.log(`var|${d.adet}|${d.sonMesaj || ''}`);
        else console.log('yok|0|');
        return;
      }
      // Hata yığını basmak yerine tek satır: bu komutu çoğunlukla kontrol
      // panelinden, terminal bilmeyen biri tetikliyor.
      try {
        const sonuc = await g.guncelle();
        if (!sonuc.degisti) log.info('Zaten güncel.');
        else
          log.ok(
            `Güncellendi: ${sonuc.once} → ${sonuc.sonra}` +
              (sonuc.bagimlilik ? ' (bağımlılıklar da yenilendi)' : '')
          );
      } catch (e) {
        log.err(String(e?.message || e));
        process.exitCode = 1;
      }
      return;
    }
    case 'tunel': {
      const t = await import('./tunel.js');
      if (opsiyon.kaydet && opsiyon.kaydet !== true) {
        const s = t.domainKaydet(opsiyon.kaydet);
        log.ok(`Dış adres sabitlendi: ${s.domain}`);
        return;
      }
      if (opsiyon.acilista !== undefined) {
        const acik = opsiyon.acilista === 'acik' || opsiyon.acilista === true;
        t.acilistaAcAyarla(acik);
        log.ok(`Açılışta dış erişim ${acik ? 'açılacak' : 'açılmayacak'}.`);
        return;
      }
      // Betikler bu iki satırı okuyor.
      const s = t.tunelAyarlari();
      console.log(s.domain || '');
      if (opsiyon.tam) console.log(s.acilistaAc ? 'acilista-acik' : 'acilista-kapali');
      return;
    }
    case 'baglanti': {
      const { erisimAyarlariniYukle, anahtariYenile } = await import('./erisim.js');
      const anahtar = opsiyon.yenile ? anahtariYenile() : erisimAyarlariniYukle().erisimToken;
      if (opsiyon.yenile) log.ok('Anahtar yenilendi — eski bağlantı artık geçersiz.');
      const adres = String(opsiyon.adres || '').replace(/\/+$/, '') || '<tünel-adresi>';
      console.log(`\n  Paylaşım bağlantısı:\n  ${adres}/?anahtar=${anahtar}\n`);
      console.log('  Bu bağlantıyla girenler paneli senin gibi kullanır:');
      console.log('  iş açar, çalıştırır, siler. Yalnız ekiple paylaş.\n');
      return;
    }
    case 'telegram': {
      const { botuBaslat, telegramAyarlariniYukle } = await import('./telegram.js');
      const tgAyar = telegramAyarlariniYukle();
      if (!tgAyar.enabled) return log.err('Telegram kapalı (config/telegram.json > enabled).');
      if (!tgAyar.token) return log.err('Token yok: config/telegram.json > token.');
      const bot = botuBaslat({ ayarlar, telegram: tgAyar });
      const kapat = () => {
        bot.durdur();
        process.exit(0);
      };
      process.on('SIGINT', kapat);
      process.on('SIGTERM', kapat);
      return new Promise(() => {}); // Ctrl+C'ye dek dinle
    }
    default:
      log.err(`Bilinmeyen komut: ${komut}`);
      yardim();
      process.exit(1);
  }
}

main().catch((e) => {
  log.err(String(e?.stack || e?.message || e));
  process.exit(1);
});
