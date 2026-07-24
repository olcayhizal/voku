import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);

/** Proje kökü (src/'in bir üstü). */
export const ROOT = path.resolve(path.dirname(__filename), '..');

export const JOBS_DIR = path.join(ROOT, 'jobs');
export const OUTPUT_DIR = path.join(ROOT, 'output');
export const CONFIG_DIR = path.join(ROOT, 'config');
