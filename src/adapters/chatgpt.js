import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bekle } from '../browser.js';
import {
  gorselKumesi,
  yeniGorselleriBekle,
  gorseliIndir,
  ilkGorunen,
  metinYaz,
  botKontroluMu,
} from './common.js';

export const ad = 'chatgpt';

/**
 * Üretilen görsel selector'ı: settings'teki değere EK olarak güncel arayüz
 * kalıpları koda gömülü — ChatGPT DOM değiştiğinde (oaiusercontent →
 * backend-api/estuary geçişi gibi) eski kurulumlardaki settings.json elle
 * düzeltilmeden çalışmaya devam etsin.
 */
const GORSEL_EK =
  'main img[src*="estuary/content"], main img[alt*="Üretilen görsel"], main img[alt*="Generated image"]';
const gorselSecici = (sel) => [sel.resultImage, GORSEL_EK].filter(Boolean).join(', ');

/** Sayfa hazır mı (oturum açık, composer görünür mü)? */
export async function hazirMi(page, sel) {
  try {
    await ilkGorunen(page, sel.composer, 8000);
    return true;
  } catch {
    return false;
  }
}

export async function hazirla(page, platform, sel, ayarlar) {
  await page.goto(platform.url, { waitUntil: 'domcontentloaded' });
  await bekle(3500);
  if (await hazirMi(page, sel)) return;

  if (await botKontroluMu(page)) {
    throw new Error(
      'ChatGPT bot kontrol ekranında takıldı ("Bir dakika lütfen…"). Bu genelde headless mod yüzünden olur — config/settings.json içinde "headless": false olmalı.'
    );
  }
  throw new Error(
    'ChatGPT arayüzü tanınmadı. Oturum kapanmış olabilir (panelden yeniden giriş yap) ya da composer selector değişmiştir (config/settings.json > selectors.chatgpt.composer).'
  );
}

/**
 * Tek prompt için üretim. Yeni sohbet açar → fotoğrafı yükler →
 * promptu gönderir → üretilen görselleri indirir.
 */
export async function uret(page, { imagePath, prompt, outDir, baseName, sel, ayarlar, signal, gonderimKapisi }) {
  // Her task temiz sohbette çalışsın — önceki bağlam bulaşmasın.
  await page.goto(ayarlar.platforms.chatgpt.url, { waitUntil: 'domcontentloaded' });
  await bekle(2500);

  const composer = await ilkGorunen(page, sel.composer, 30000);

  // Fotoğrafı yükle
  const fileInput = page.locator(sel.fileInput).first();
  await fileInput.setInputFiles(path.resolve(imagePath));
  await bekle(4000); // yükleme tamamlansın

  // Prompt
  await metinYaz(composer, prompt);
  await bekle(500);

  // Üretim öncesi baseline (yüklenen foto baseline'a dahil olsun)
  const baseline = await gorselKumesi(page, gorselSecici(sel));

  // ChatGPT'nin eşzamanlı mesaj/rate limitine takılmamak için gönderimler
  // arası tempo — paralel sekmeler üretimi paralel sürdürür, yalnız
  // GÖNDERME anları aralıklı olur (kapıyı çağıran sürücü tutar).
  if (gonderimKapisi) await gonderimKapisi();

  // Gönder
  const gonder = page.locator(sel.sendButton).first();
  if ((await gonder.count()) > 0 && (await gonder.isEnabled().catch(() => false))) {
    await gonder.click();
  } else {
    await composer.press('Enter');
  }

  const yeniler = await yeniGorselleriBekle(page, gorselSecici(sel), baseline, {
    timeoutMs: ayarlar.generationTimeoutMs,
    signal,
    // ChatGPT görsel yerine hata/ret yazdıysa timeout beklenmez.
    hataKontrol: async () => {
      const metin = await page
        .evaluate(() => {
          const mesajlar = document.querySelectorAll('[data-message-author-role="assistant"]');
          const son = mesajlar[mesajlar.length - 1];
          return son ? son.innerText.slice(0, 600) : '';
        })
        .catch(() => '');
      if (
        /content policy|policy violation|üretemem|oluşturamam|oluşturamıyorum|yardımcı olamam|can.t (create|generate|make)|unable to (create|generate)|something went wrong|bir sorun oluştu|bir hata oluştu/i.test(
          metin
        )
      ) {
        return `ChatGPT görseli üretemedi/reddetti: ${metin.replace(/\s+/g, ' ').slice(0, 160)}`;
      }
      return null;
    },
  });

  // Yalnız ASİSTAN mesajındaki görseller üretimdir — kullanıcının yüklediği
  // fotoğraf da sohbette img olarak durur ve geç yüklenirse baseline'ı
  // kaçırıp "yeni" sanılabilir (orijinal foto "üretildi" diye inerdi).
  const asistanKumesi = new Set(
    await page
      .evaluate(
        () =>
          Array.from(
            document.querySelectorAll(
              '[data-message-author-role="assistant"] img, main img[alt*="Üretilen"], main img[alt*="Generated"]'
            )
          )
            .filter((img) => img.src)
            .map((img) => img.src)
      )
      .catch(() => [])
  );
  const asistanin = yeniler.filter((src) => asistanKumesi.has(src));

  // Aynı görsel DOM'da birden çok img'de durur (önizleme + büyütme kopyaları,
  // farklı URL parametreleriyle) — dosya kimliğine göre teke indir.
  const gorulen = new Set();
  const benzersiz = asistanin.filter((src) => {
    const kimlik = /[?&]id=([\w-]+)/.exec(src)?.[1] || src;
    if (gorulen.has(kimlik)) return false;
    gorulen.add(kimlik);
    return true;
  });

  // Son savunmalar: girdi fotoğrafının birebir kopyası "üretim" sayılmaz;
  // URL kimliği farklı olsa da içerik aynıysa kopya atılır.
  const girdiOzeti = crypto
    .createHash('md5')
    .update(fs.readFileSync(path.resolve(imagePath)))
    .digest('hex');
  const dosyalar = [];
  const icerikler = new Set([girdiOzeti]);
  for (let i = 0; i < benzersiz.length; i++) {
    const ek = benzersiz.length > 1 ? `-${i + 1}` : '';
    const hedef = path.join(outDir, `${baseName}${ek}.png`);
    const sonuc = await gorseliIndir(page, benzersiz[i], hedef);
    const ozet = crypto.createHash('md5').update(fs.readFileSync(sonuc.yol)).digest('hex');
    if (icerikler.has(ozet)) {
      fs.rmSync(sonuc.yol, { force: true });
      continue;
    }
    icerikler.add(ozet);
    dosyalar.push(path.basename(sonuc.yol));
  }

  if (!dosyalar.length) {
    throw new Error('ChatGPT yanıtında üretilmiş görsel yok (yalnız yüklenen fotoğraf/eski kareler görüldü).');
  }
  return dosyalar;
}
