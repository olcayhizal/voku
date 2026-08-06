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
const kaynaklar = new Map(); // profileDir → { ctx, page, kuyruk }

function kaynakAl(profil) {
  let k = kaynaklar.get(profil);
  if (!k) {
    k = { ctx: null, page: null, kuyruk: Promise.resolve() };
    kaynaklar.set(profil, k);
  }
  return k;
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

async function sayfaHazirla(kaynak, platform, profil, sel, ayarlar) {
  if (kaynak.page && !kaynak.page.isClosed()) return kaynak.page;
  if (kaynak.ctx) await kaynak.ctx.close().catch(() => {});
  log.info('[chatgpt-tarayici] web penceresi açılıyor (Codex kotası ayrı — web hakkı kullanılacak)');
  kaynak.ctx = await contextAc({ ...platform, profileDir: profil }, ayarlar);
  kaynak.page = await sayfaAl(kaynak.ctx);
  await chatgptWeb.hazirla(kaynak.page, platform, sel, ayarlar);
  return kaynak.page;
}

export async function hazirla(_page, platform, _sel, _ayarlar, hesap) {
  if (!profilVar(platform, hesap)) {
    throw new Error(
      `ChatGPT web profili yok — "${hesap?.ad || 'tarayıcı'}" hesabı için önce panelden tarayıcı girişi yapılmalı.`
    );
  }
}

export async function uret(_page, girdi) {
  // Profil başına tek pencere: o profilin turları sırayla. Kuyruk hatada kopmaz.
  const profil = profilYolu(girdi.platform, girdi.hesap);
  const kaynak = kaynakAl(profil);
  const tur = kaynak.kuyruk.then(() => turCalistir(girdi, kaynak, profil));
  kaynak.kuyruk = tur.catch(() => {});
  return tur;
}

async function turCalistir(girdi, kaynak, profil) {
  const { platform, sel, ayarlar, signal } = girdi;
  try {
    const page = await sayfaHazirla(kaynak, platform, profil, sel, ayarlar);
    // Web üretimi CLI'dan yavaş akar (kuyruk + akış animasyonu) — dar
    // zaman aşımı gereksiz "üretmedi" sayar.
    const webAyar = {
      ...ayarlar,
      generationTimeoutMs: Math.max(Number(ayarlar.generationTimeoutMs) || 240000, 360000),
    };
    const dosyalar = await chatgptWeb.uret(page, { ...girdi, ayarlar: webAyar });
    log.ok(`[chatgpt-tarayici] web kotasından üretildi: ${dosyalar.join(', ')}`);
    return dosyalar;
  } catch (e) {
    if (signal?.aborted) throw e;
    // Pencere/oturum çökmüş olabilir — bir sonraki tur taze pencere açsın.
    if (/closed|crashed|Target/i.test(String(e.message))) {
      kaynak.page = null;
    }
    // Web de üretemiyorsa bu hesabı bir süre dinlendir ki kuyruk fal'a
    // (varsa) düşebilsin; kısa süre — web limiti genelde çabuk açılır.
    const y = new Error(`Tarayıcı yedeği üretemedi: ${String(e.message).slice(0, 160)}`);
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
