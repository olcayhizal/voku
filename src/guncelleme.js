/**
 * Güncelleme — GitHub'daki sürümle karşılaştırır, ister çeker.
 *
 * Kontrol paneli (VOKU.command / VOKU.cmd) bu modülü çağırır; iki platformun
 * betikleri aynı mantığı iki kez yazmasın diye karar burada verilir.
 *
 * Kurallar:
 *  - `git pull --ff-only`: yerel commit varsa güncelleme yapılmaz, kullanıcı
 *    uyarılır. Sessizce merge/rebase etmek bir kurulumu bozabilir.
 *  - Kişisel dosyalar (config/telegram.json, erisim.json, prompts.json, jobs,
 *    output) git dışıdır — güncelleme onlara dokunmaz.
 *  - `package-lock.json` değiştiyse bağımlılıklar yeniden kurulur.
 *  - Kontrol sonucu `.guncelleme-durumu.json`'a yazılır; panel her açılışta
 *    ağa çıkmasın diye varsayılan tazelik 6 saattir.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT } from './paths.js';
import { komutCagrisi } from './platform.js';

const calistir = promisify(execFile);
const DURUM_DOSYASI = path.join(ROOT, '.guncelleme-durumu.json');
const AYAR_DOSYASI = path.join(ROOT, 'config', 'guncelleme.json');
const TAZELIK_MS = 6 * 60 * 60 * 1000;

async function git(...argumanlar) {
  const { stdout } = await calistir('git', argumanlar, { cwd: ROOT, timeout: 60000 });
  return stdout.trim();
}

export function guncellemeAyarlari() {
  let ham = {};
  try {
    ham = JSON.parse(fs.readFileSync(AYAR_DOSYASI, 'utf8'));
  } catch {
    /* dosya yoksa varsayılanlar */
  }
  return {
    // Otomatik güncelleme kapalı başlar: kullanıcı açıkça açmalı.
    otomatik: ham.otomatik === true,
    dal: ham.dal || 'main',
  };
}

export function otomatikAyarla(acik) {
  const s = { ...guncellemeAyarlari(), otomatik: Boolean(acik) };
  fs.mkdirSync(path.dirname(AYAR_DOSYASI), { recursive: true });
  fs.writeFileSync(AYAR_DOSYASI, JSON.stringify(s, null, 2) + '\n');
  return s;
}

function durumuOku() {
  try {
    return JSON.parse(fs.readFileSync(DURUM_DOSYASI, 'utf8'));
  } catch {
    return null;
  }
}

function durumuYaz(d) {
  fs.writeFileSync(DURUM_DOSYASI, JSON.stringify(d, null, 2) + '\n');
  return d;
}

/** Bu klasör bir git deposu ve uzak adresi var mı? */
export async function depoMu() {
  try {
    await git('rev-parse', '--git-dir');
    const uzak = await git('remote').catch(() => '');
    return Boolean(uzak);
  } catch {
    return false;
  }
}

/**
 * Uzak sürümle karşılaştırır.
 * @param {{ zorla?: boolean }} p `zorla` önbelleği yok sayıp ağa çıkar.
 */
export async function guncellemeVarMi({ zorla = false } = {}) {
  const onbellek = durumuOku();
  if (!zorla && onbellek && Date.now() - new Date(onbellek.kontrol).getTime() < TAZELIK_MS) {
    return { ...onbellek, onbellekten: true };
  }
  if (!(await depoMu())) {
    return durumuYaz({
      var: false,
      kontrol: new Date().toISOString(),
      hata: 'Bu kurulum git deposu değil (zip ile kurulmuş olabilir).',
    });
  }

  const dal = guncellemeAyarlari().dal;
  try {
    await git('fetch', '--quiet', 'origin', dal);
    const yerel = await git('rev-parse', 'HEAD');
    const uzak = await git('rev-parse', `origin/${dal}`);
    const geride = yerel === uzak ? 0 : Number(await git('rev-list', '--count', `HEAD..origin/${dal}`));
    const kirli = Boolean(await git('status', '--porcelain'));
    const sonMesaj = geride ? await git('log', '-1', '--pretty=%s', `origin/${dal}`) : '';
    return durumuYaz({
      var: geride > 0,
      adet: geride,
      yerel: yerel.slice(0, 7),
      uzak: uzak.slice(0, 7),
      sonMesaj,
      kirli,
      kontrol: new Date().toISOString(),
      hata: null,
    });
  } catch (e) {
    return durumuYaz({
      var: false,
      kontrol: new Date().toISOString(),
      hata: String(e?.stderr || e?.message || e).trim().slice(-200),
    });
  }
}

/**
 * Güncellemeyi uygular. Yerel değişiklik varsa dokunmaz — kullanıcının
 * elindeki kurulumu sessizce ezmek en kötü senaryodur.
 */
// Panelin runtime'da yazdığı kullanıcı-verisi dosyaları. Eskiden yanlışlıkla
// git-takipliydiler; panel onları değiştirince "kirli ağaç" güncellemeyi
// blokluyordu. Artık takip dışı — hâlâ takipli bir kopya varsa güncelleme
// öncesi index'ten düşürülür (working tree korunur), böylece bir kez otomatik
// onarılır ve bir daha bloke etmez.
const KULLANICI_DOSYALARI = ['config/settings.json', 'config/prompts.json', 'config/telegram.json'];

async function takipliKullaniciDosyalariniDusur() {
  for (const dosya of KULLANICI_DOSYALARI) {
    try {
      await git('ls-files', '--error-unmatch', dosya); // takipli mi?
      await git('rm', '--cached', '-q', dosya); // içeriği koruyarak takipten çıkar
    } catch {
      /* takipli değil — sorun yok */
    }
  }
}

export async function guncelle() {
  if (!(await depoMu())) throw new Error('Bu kurulum git deposu değil; güncelleme yapılamaz.');
  const dal = guncellemeAyarlari().dal;

  await takipliKullaniciDosyalariniDusur();

  const kirli = await git('status', '--porcelain');
  if (kirli) {
    throw new Error(
      'Bu kurulumda kaydedilmemiş yerel değişiklikler var; güncelleme atlandı.\n' +
        kirli.split('\n').slice(0, 5).join('\n')
    );
  }

  const oncekiKilit = kilitOzeti();
  await git('fetch', '--quiet', 'origin', dal);
  const once = await git('rev-parse', 'HEAD');
  await git('pull', '--ff-only', 'origin', dal);
  const sonra = await git('rev-parse', 'HEAD');

  const degisti = once !== sonra;
  let bagimlilik = false;
  if (degisti && kilitOzeti() !== oncekiKilit) {
    const npm = komutCagrisi('npm');
    await calistir(npm.komut, [...npm.onEk, 'install', '--no-audit', '--no-fund'], {
      cwd: ROOT,
      timeout: 600000,
    });
    bagimlilik = true;
  }
  await guncellemeVarMi({ zorla: true });
  return { degisti, once: once.slice(0, 7), sonra: sonra.slice(0, 7), bagimlilik };
}

function kilitOzeti() {
  try {
    return String(fs.statSync(path.join(ROOT, 'package-lock.json')).mtimeMs);
  } catch {
    return '';
  }
}
