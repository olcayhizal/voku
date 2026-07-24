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

export const ad = 'gemini';

export async function hazirMi(page, sel) {
  try {
    await ilkGorunen(page, sel.composer, 8000);
    return true;
  } catch {
    return false;
  }
}

export async function hazirla(page, platform, sel) {
  await page.goto(platform.url, { waitUntil: 'domcontentloaded' });
  await bekle(3500);
  if (await hazirMi(page, sel)) return;

  if (await botKontroluMu(page)) {
    throw new Error(
      'Gemini bot kontrol ekranında takıldı. Bu genelde headless mod yüzünden olur — config/settings.json içinde "headless": false olmalı.'
    );
  }
  throw new Error(
    'Gemini arayüzü tanınmadı. Oturum kapanmış olabilir (panelden yeniden giriş yap) ya da composer selector değişmiştir (config/settings.json > selectors.gemini.composer).'
  );
}

export async function uret(page, { imagePath, prompt, outDir, baseName, sel, ayarlar, signal }) {
  await page.goto(ayarlar.platforms.gemini.url, { waitUntil: 'domcontentloaded' });
  await bekle(3000);

  const composer = await ilkGorunen(page, sel.composer, 30000);

  // Gemini'de dosya input'u menü arkasında olabilir; gizli input'a doğrudan bas.
  const fileInput = page.locator(sel.fileInput).first();
  await fileInput.setInputFiles(path.resolve(imagePath), { timeout: 30000 });
  await bekle(5000);

  await metinYaz(composer, prompt);
  await bekle(500);

  const baseline = await gorselKumesi(page, sel.resultImage);

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
