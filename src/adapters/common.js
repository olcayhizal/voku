import fs from 'node:fs';
import path from 'node:path';
import { bekle } from '../browser.js';

/** Sayfadaki mevcut görsel src'lerinin anlık kümesi (baseline). */
export async function gorselKumesi(page, selector) {
  return new Set(
    await page.evaluate(
      (sel) =>
        Array.from(document.querySelectorAll(sel))
          .filter((img) => img.src && img.naturalWidth > 64)
          .map((img) => img.src),
      selector
    )
  );
}

/**
 * Baseline'da olmayan yeni görselleri bekler.
 * Yeni görsel görüldükten sonra sayı `stableMs` boyunca artmazsa tamam sayar
 * (birden fazla görsel üreten modeller için).
 */
export async function yeniGorselleriBekle(page, selector, baseline, {
  timeoutMs = 240000,
  stableMs = 6000,
  pollMs = 1500,
  signal,
} = {}) {
  const bitis = Date.now() + timeoutMs;
  let sonSayi = 0;
  let sonDegisim = Date.now();

  while (Date.now() < bitis) {
    if (signal?.aborted) throw new Error('Durduruldu.');
    const hepsi = await page.evaluate(
      (sel) =>
        Array.from(document.querySelectorAll(sel))
          .filter((img) => img.src && img.complete && img.naturalWidth > 64)
          .map((img) => img.src),
      selector
    );
    const yeniler = hepsi.filter((s) => !baseline.has(s));

    if (yeniler.length !== sonSayi) {
      sonSayi = yeniler.length;
      sonDegisim = Date.now();
    }
    if (sonSayi > 0 && Date.now() - sonDegisim >= stableMs) {
      return yeniler;
    }
    await bekle(pollMs);
  }
  throw new Error(`Görsel üretimi zaman aşımına uğradı (${timeoutMs} ms).`);
}

/**
 * Görseli diske indirir. Üç kademeli:
 *  1) sayfa içi fetch (oturum çerezleriyle, blob: dahil)
 *  2) context.request (aynı çerezler, CORS yok)
 *  3) element screenshot (son çare — kayıpsız değil)
 */
export async function gorseliIndir(page, src, hedefYol) {
  fs.mkdirSync(path.dirname(hedefYol), { recursive: true });

  // 1) sayfa içi fetch
  try {
    const b64 = await page.evaluate(async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error('fetch ' + r.status);
      const buf = await r.arrayBuffer();
      let bin = '';
      const bytes = new Uint8Array(buf);
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(bin);
    }, src);
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > 1024) {
      fs.writeFileSync(hedefYol, buf);
      return { yol: hedefYol, yontem: 'fetch', boyut: buf.length };
    }
  } catch {
    /* sonraki yönteme geç */
  }

  // 2) context.request
  if (!src.startsWith('blob:')) {
    try {
      const resp = await page.context().request.get(src);
      if (resp.ok()) {
        const buf = await resp.body();
        if (buf.length > 1024) {
          fs.writeFileSync(hedefYol, buf);
          return { yol: hedefYol, yontem: 'request', boyut: buf.length };
        }
      }
    } catch {
      /* sonraki yönteme geç */
    }
  }

  // 3) element screenshot
  const el = page.locator(`img[src="${src.replace(/"/g, '\\"')}"]`).first();
  await el.scrollIntoViewIfNeeded({ timeout: 10000 });
  await el.screenshot({ path: hedefYol });
  const st = fs.statSync(hedefYol);
  return { yol: hedefYol, yontem: 'screenshot', boyut: st.size };
}

/** Birden fazla selector'ı sırayla dener, ilk görüneni döndürür. */
export async function ilkGorunen(page, selectorler, timeoutMs = 30000) {
  const liste = String(selectorler)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bitis = Date.now() + timeoutMs;
  while (Date.now() < bitis) {
    for (const sel of liste) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        return loc;
      }
    }
    await bekle(500);
  }
  throw new Error(`Öğe bulunamadı: ${selectorler}`);
}

/**
 * Cloudflare / bot kontrolü ekranında mıyız?
 * Headless Chrome bu ekrana takılır — oturum açık olsa bile arayüz gelmez,
 * o yüzden hatayı "oturum yok" diye raporlamak yanıltıcı olur.
 */
export async function botKontroluMu(page) {
  const baslik = (await page.title().catch(() => '')) || '';
  const metin = await page
    .evaluate(() => document.body?.innerText?.slice(0, 400) || '')
    .catch(() => '');
  return /bir dakika|just a moment|checking your browser|verify you are human|doğrulanıyor/i.test(
    `${baslik} ${metin}`
  );
}

/** Uzun promptu contenteditable/textarea'ya güvenli yazar. */
export async function metinYaz(loc, metin) {
  await loc.click();
  await loc.fill('').catch(async () => {
    await loc.press('Control+A').catch(() => {});
    await loc.press('Backspace').catch(() => {});
  });
  // fill contenteditable'da bazen boş kalıyor → insertText ile bas
  await loc.page().keyboard.insertText(metin);
}
