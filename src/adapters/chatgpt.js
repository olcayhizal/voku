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
export async function uret(page, { imagePath, prompt, outDir, baseName, sel, ayarlar, signal }) {
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
  const baseline = await gorselKumesi(page, sel.resultImage);

  // Gönder
  const gonder = page.locator(sel.sendButton).first();
  if ((await gonder.count()) > 0 && (await gonder.isEnabled().catch(() => false))) {
    await gonder.click();
  } else {
    await composer.press('Enter');
  }

  const yeniler = await yeniGorselleriBekle(page, sel.resultImage, baseline, {
    timeoutMs: ayarlar.generationTimeoutMs,
    signal,
  });

  const dosyalar = [];
  for (let i = 0; i < yeniler.length; i++) {
    const ek = yeniler.length > 1 ? `-${i + 1}` : '';
    const hedef = path.join(outDir, `${baseName}${ek}.png`);
    const sonuc = await gorseliIndir(page, yeniler[i], hedef);
    dosyalar.push(path.basename(sonuc.yol));
  }
  return dosyalar;
}
