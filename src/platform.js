/**
 * İşletim sistemi farkları tek yerde.
 *
 * Kod uzun süre yalnız macOS'ta koştu ve `open`, `python3` gibi çağrılar
 * doğrudan gömülüydü. Windows'ta panelin açılması için bu varsayımların
 * tek noktada toplanması gerekiyor — yeni bir platform farkı çıkarsa
 * adapter'a değil buraya eklenir.
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';

export const WINDOWS = process.platform === 'win32';
export const MAC = process.platform === 'darwin';

/** Klasörü/dosyayı sistem dosya yöneticisinde gösterir. */
export function dosyayiGoster(yol) {
  if (WINDOWS) return spawn('explorer', [yol.replace(/\//g, '\\')], { stdio: 'ignore', detached: true }).unref();
  if (MAC) return spawn('open', [yol], { stdio: 'ignore', detached: true }).unref();
  return spawn('xdg-open', [yol], { stdio: 'ignore', detached: true }).unref();
}

/** Adresi varsayılan tarayıcıda açar. */
export function tarayicidaAc(adres) {
  if (WINDOWS) {
    // cmd /c start: ilk tırnaklı argüman pencere başlığı sayılır, boş geçilir.
    return spawn('cmd', ['/c', 'start', '', adres], { stdio: 'ignore', detached: true }).unref();
  }
  if (MAC) return spawn('open', [adres], { stdio: 'ignore', detached: true }).unref();
  return spawn('xdg-open', [adres], { stdio: 'ignore', detached: true }).unref();
}

/**
 * Python yorumlayıcısının adı. macOS/Linux'ta `python3`, Windows'ta çoğu
 * kurulumda `python` ya da başlatıcı `py`. İlk yanıt verenle devam edilir.
 */
let pythonAdi = null;
export function pythonKomutu() {
  if (pythonAdi) return pythonAdi;
  const adaylar = WINDOWS ? ['python', 'py', 'python3'] : ['python3', 'python'];
  for (const aday of adaylar) {
    try {
      execFileSync(aday, ['--version'], { stdio: 'ignore' });
      pythonAdi = aday;
      return aday;
    } catch {
      /* sıradaki adaya geç */
    }
  }
  pythonAdi = adaylar[0]; // hiçbiri yoksa net hata mesajı çağıran tarafta çıkar
  return pythonAdi;
}

/** Derlenmiş yardımcı programın dosya adı (Windows'ta .exe). */
export function calistirilabilir(ad) {
  return WINDOWS ? `${ad}.exe` : ad;
}
