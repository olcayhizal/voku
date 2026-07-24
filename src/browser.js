import fs from 'node:fs';
import { chromium } from 'playwright';
import { log } from './logger.js';

/**
 * Platform için kalıcı profilli tarayıcı context'i açar.
 * Oturum çerezleri profileDir içinde kalır → bir kez login, sonrası otomatik.
 *
 * Varsayılan olarak sistemdeki gerçek Google Chrome ("chrome" kanalı) kullanılır:
 * Playwright'ın indirdiği Chromium'a göre hem kurulum gerektirmez hem de
 * ChatGPT/Gemini tarafında daha az bot şüphesi çeker. Kanal yoksa indirilmiş
 * Chromium'a düşer.
 */
export async function contextAc(platform, ayarlar, { headless } = {}) {
  fs.mkdirSync(platform.profileDir, { recursive: true });

  const secenekler = {
    headless: headless ?? ayarlar.headless,
    slowMo: ayarlar.slowMo || 0,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    args: ['--disable-blink-features=AutomationControlled'],
  };

  const kanal = platform.channel ?? ayarlar.channel ?? 'chrome';
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(platform.profileDir, {
      ...secenekler,
      ...(kanal ? { channel: kanal } : {}),
    });
  } catch (e) {
    if (!kanal) throw e;
    log.warn(
      `Chrome kanalı "${kanal}" açılamadı (${String(e?.message || e).split('\n')[0]}) — indirilmiş Chromium deneniyor.`
    );
    ctx = await chromium.launchPersistentContext(platform.profileDir, secenekler);
  }
  ctx.setDefaultTimeout(ayarlar.navigationTimeoutMs);
  ctx.setDefaultNavigationTimeout(ayarlar.navigationTimeoutMs);
  return ctx;
}

/** Context'teki ilk sayfayı verir, yoksa açar. */
export async function sayfaAl(ctx) {
  const mevcut = ctx.pages();
  return mevcut.length ? mevcut[0] : await ctx.newPage();
}

/** Bekler; iptal sinyali gelirse erken döner (durdurma anında takılmasın). */
export async function bekle(ms, signal) {
  if (!signal) return new Promise((r) => setTimeout(r, ms));
  if (signal.aborted) return;
  await new Promise((cozumle) => {
    const sayac = setTimeout(bitir, ms);
    function bitir() {
      clearTimeout(sayac);
      signal.removeEventListener('abort', bitir);
      cozumle();
    }
    signal.addEventListener('abort', bitir, { once: true });
  });
}
