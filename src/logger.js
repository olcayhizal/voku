import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.js';

const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'voku.log');

fs.mkdirSync(LOG_DIR, { recursive: true });

const RENK = {
  info: '\x1b[36m',
  ok: '\x1b[32m',
  warn: '\x1b[33m',
  err: '\x1b[31m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

/** Panel (SSE) için canlı log aboneleri. */
const aboneler = new Set();
export function logAbone(fn) {
  aboneler.add(fn);
  return () => aboneler.delete(fn);
}

function yaz(seviye, mesaj, ek) {
  const ts = new Date().toISOString();
  const satir = ek
    ? `${ts} [${seviye}] ${mesaj} ${JSON.stringify(ek)}`
    : `${ts} [${seviye}] ${mesaj}`;
  fs.appendFileSync(LOG_FILE, satir + '\n');
  for (const fn of aboneler) {
    try {
      fn({ ts, seviye, mesaj });
    } catch {
      /* abone hatası log akışını durdurmaz */
    }
  }
  const renk = RENK[seviye] || '';
  const saat = ts.slice(11, 19);
  console.log(`${RENK.dim}${saat}${RENK.reset} ${renk}${mesaj}${RENK.reset}`);
}

export const log = {
  info: (m, ek) => yaz('info', m, ek),
  ok: (m, ek) => yaz('ok', m, ek),
  warn: (m, ek) => yaz('warn', m, ek),
  err: (m, ek) => yaz('err', m, ek),
  file: LOG_FILE,
};
