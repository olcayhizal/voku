/**
 * ChatGPT tarayıcı YEDEĞİ — Codex kotası dolunca web kotasından devam.
 *
 * Codex CLI kullanımı ile chatgpt.com'un görsel üretim hakkı AYRI kotalardan
 * sayılıyor: Codex "limit doldu" derken web hâlâ üretebiliyor. Bu sürücü,
 * havuzdaki sanal "tarayıcı" hesabı kiralandığında chatgpt.com'u Playwright
 * ile açar ve klasik tarayıcı sürücüsüne (chatgpt.js) iş yaptırır.
 *
 * Tek pencere/tek profil olduğu için turlar burada serileştirilir
 * (concurrency 1). Pencere görünür açılır (headless bot kontrolüne takılır).
 */
import fs from 'node:fs';
import path from 'node:path';
import { contextAc, sayfaAl } from '../browser.js';
import * as chatgptWeb from './chatgpt.js';
import { log } from '../logger.js';

export const ad = 'chatgpt-tarayici';
export const tarayiciGerekli = false; // havuz akışında koşar; context'i kendisi açar

// Profil başına kaynak: web motorlu her hesap kendi penceresinde koşar.
// Paralellik aynı pencerede SEKME ile: her tur boş sekme kiralar, yoksa
// yenisini açar (eşzamanlı tur sayısını runner'daki hesap slotu sınırlar).
const kaynaklar = new Map(); // profileDir → { ctx, acilis, sayfalar: [{page, mesgul}] }

function kaynakAl(profil) {
  let k = kaynaklar.get(profil);
  if (!k) {
    k = { ctx: null, acilis: null, sayfalar: [] };
    kaynaklar.set(profil, k);
  }
  return k;
}

/* ChatGPT eşzamanlı mesaj gönderimini sınırlıyor: hesap (profil) başına
 * gönderimler arasında en az `webGonderimAraligiMs` (10 sn) bulunur.
 * Paralel sekmeler üretimi paralel sürdürür — yalnız gönderme anları
 * sıraya dizilip aralıklandırılır. */
const tempolar = new Map(); // profil → { son, kuyruk }

function gonderimSirasi(profil, aralikMs) {
  let t = tempolar.get(profil);
  if (!t) {
    t = { son: 0, kuyruk: Promise.resolve() };
    tempolar.set(profil, t);
  }
  const soz = t.kuyruk.then(async () => {
    const bekleMs = t.son + aralikMs - Date.now();
    if (bekleMs > 0) await new Promise((r) => setTimeout(r, bekleMs));
    t.son = Date.now();
  });
  t.kuyruk = soz.catch(() => {});
  return soz;
}

/** Hesabın (yoksa platformun) web profili. */
function profilYolu(platform, hesap) {
  return hesap?.profileDir || platform?.profileDir || null;
}

/** Web profili hiç giriş görmemişse denenmesin. */
export function profilVar(platform, hesap) {
  const dizin = profilYolu(platform, hesap);
  return Boolean(
    dizin &&
      (fs.existsSync(path.join(dizin, 'Default')) ||
        fs.existsSync(path.join(dizin, '.voku-login.json')))
  );
}

/**
 * Havuzdaki sanal tarayıcı hesabı. Web profili yoksa (hiç giriş yapılmamış)
 * null — havuza katılmaz; kullanıcı bir kez tarayıcıdan giriş yapmış olmalı.
 * `yedek:false` ile ASIL hesap olarak da kullanılabilir (motor: web).
 */
export function sanalHesap(platform, { yedek = true } = {}) {
  if (yedek && platform?.tarayiciYedek === false) return null;
  if (!profilVar(platform)) return null;
  return { ad: 'tarayıcı', saglayici: 'tarayici', yedek, aktif: true, concurrency: 1 };
}

/** Pencereyi (persistent context) açar — eşzamanlı ilk turlar tek kilitte. */
async function contextHazirla(kaynak, platform, profil, sel, ayarlar) {
  if (!kaynak.acilis) {
    kaynak.acilis = (async () => {
      log.info('[chatgpt-tarayici] web penceresi açılıyor (Codex kotası ayrı — web hakkı kullanılacak)');
      kaynak.ctx = await contextAc({ ...platform, profileDir: profil }, ayarlar);
      const ilk = await sayfaAl(kaynak.ctx);
      await chatgptWeb.hazirla(ilk, platform, sel, ayarlar);
      kaynak.sayfalar = [{ page: ilk, mesgul: false }];
    })().catch((e) => {
      // Açılış başarısızsa kilidi bırak — sonraki tur yeniden denesin.
      if (kaynak.ctx) kaynak.ctx.close().catch(() => {});
      kaynak.ctx = null;
      kaynak.acilis = null;
      kaynak.sayfalar = [];
      throw e;
    });
  }
  await kaynak.acilis;
}

export async function hazirla(_page, platform, _sel, _ayarlar, hesap) {
  if (!profilVar(platform, hesap)) {
    throw new Error(
      `ChatGPT web profili yok — "${hesap?.ad || 'tarayıcı'}" hesabı için önce panelden tarayıcı girişi yapılmalı.`
    );
  }
}

export async function uret(_page, girdi) {
  const { platform, sel, ayarlar, signal } = girdi;
  const profil = profilYolu(platform, girdi.hesap);
  const kaynak = kaynakAl(profil);
  try {
    await contextHazirla(kaynak, platform, profil, sel, ayarlar);

    // Boş sekme kirala; yoksa yeni sekme aç. Eşzamanlı tur sayısını hesap
    // slotu (runner) sınırladığı için sekme sayısı kapasiteyi aşmaz.
    kaynak.sayfalar = kaynak.sayfalar.filter((s) => !s.page.isClosed());
    let sayfa = kaynak.sayfalar.find((s) => !s.mesgul);
    if (sayfa) {
      sayfa.mesgul = true;
    } else {
      sayfa = { page: await kaynak.ctx.newPage(), mesgul: true };
      kaynak.sayfalar.push(sayfa);
      log.info(`[chatgpt-tarayici] yeni sekme açıldı (${kaynak.sayfalar.length}. paralel üretim)`);
    }

    try {
      // Web üretimi CLI'dan yavaş akar (kuyruk + akış animasyonu) — dar
      // zaman aşımı gereksiz "üretmedi" sayar.
      const webAyar = {
        ...ayarlar,
        generationTimeoutMs: Math.max(Number(ayarlar.generationTimeoutMs) || 240000, 360000),
      };
      const aralik = Number(platform.webGonderimAraligiMs) || 10000;
      const dosyalar = await chatgptWeb.uret(sayfa.page, {
        ...girdi,
        ayarlar: webAyar,
        gonderimKapisi: () => gonderimSirasi(profil, aralik),
      });
      log.ok(`[chatgpt-tarayici] web kotasından üretildi: ${dosyalar.join(', ')}`);
      return dosyalar;
    } finally {
      sayfa.mesgul = false;
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    // Pencere/oturum çökmüş olabilir — bir sonraki tur taze pencere açsın.
    if (/closed|crashed|Target/i.test(String(e.message))) {
      if (kaynak.ctx) kaynak.ctx.close().catch(() => {});
      kaynak.ctx = null;
      kaynak.acilis = null;
      kaynak.sayfalar = [];
    }
    // Web de üretemiyorsa bu hesabı bir süre dinlendir ki kuyruk diğer
    // hesaba/fal'a düşebilsin; kısa süre — web limiti genelde çabuk açılır.
    const y = new Error(`Tarayıcı üretemedi: ${String(e.message).slice(0, 160)}`);
    y.limitDolu = true;
    y.resetsAt = Date.now() + 15 * 60 * 1000;
    throw y;
  }
}

/** Panel kapanırken açık pencereleri bırakma. */
export async function kapat() {
  for (const k of kaynaklar.values()) {
    if (k.ctx) await k.ctx.close().catch(() => {});
  }
  kaynaklar.clear();
}
