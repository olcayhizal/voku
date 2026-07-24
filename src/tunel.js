/**
 * Tünel tercihleri — dış adres her açılışta değişmesin.
 *
 * ngrok'un ücretsiz planı hesaba sabit bir `*.ngrok-free.dev` adresi verir,
 * ama bunu kullanmak için tünelin `--url` ile o adrese bağlanması gerekir;
 * aksi hâlde bazı kurulumlarda rastgele adres atanır ve paylaşılan bağlantı
 * ölür. Bu yüzden ilk açılışta alınan adres buraya yazılır, sonraki
 * açılışlarda aynısı istenir.
 *
 * Misafir anahtarı zaten sabittir (config/erisim.json) — yalnız "bağlantıyı
 * yenile" dendiğinde değişir. İkisi birleşince paylaşılan link kalıcı olur.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './paths.js';

const DOSYA = path.join(CONFIG_DIR, 'tunel.json');

export function tunelAyarlari() {
  let ham = {};
  try {
    ham = JSON.parse(fs.readFileSync(DOSYA, 'utf8'));
  } catch {
    /* yoksa varsayılan */
  }
  return {
    domain: ham.domain || null,
    // Kontrol paneli açıldığında panel ve dış erişim kendiliğinden kalksın.
    acilistaAc: ham.acilistaAc !== false,
  };
}

function yaz(s) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(DOSYA, JSON.stringify(s, null, 2) + '\n');
  return s;
}

/** `https://abc.ngrok-free.dev` → `abc.ngrok-free.dev` */
export function domainKaydet(adres) {
  const host = String(adres || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .trim();
  if (!host) throw new Error('Geçersiz adres.');
  return yaz({ ...tunelAyarlari(), domain: host });
}

export function acilistaAcAyarla(acik) {
  return yaz({ ...tunelAyarlari(), acilistaAc: Boolean(acik) });
}
