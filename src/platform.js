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

const komutOnbellek = new Map();

/**
 * Bir komutun tam yolu — yoksa null.
 *
 * Windows'ta zorunlu: npm'in global kurduğu programlar `codex.cmd` gibi
 * batch shim'leridir ve Node'un `spawn`'ı PATHEXT'i uygulamadığı için
 * `spawn('codex')` ENOENT verir. Yolu `where` ile çözüp tam adıyla
 * çağırmak tek güvenilir yol.
 */
export function komutYolu(ad) {
  if (komutOnbellek.has(ad)) return komutOnbellek.get(ad);
  let sonuc = null;
  try {
    const cikti = execFileSync(WINDOWS ? 'where' : 'which', [ad], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const satirlar = cikti.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // Windows'ta birden çok eşleşme dönebilir; çalıştırılabilir olanı yeğle.
    sonuc = satirlar.find((s) => /\.(cmd|bat|exe)$/i.test(s)) || satirlar[0] || null;
  } catch {
    sonuc = null;
  }
  komutOnbellek.set(ad, sonuc);
  return sonuc;
}

export function komutVarMi(ad) {
  return Boolean(komutYolu(ad));
}

/**
 * Bir dış komutun nasıl çağrılacağı: `{ komut, onEk }`.
 *
 * Windows'ta ikinci tuzak: Node 18.20 / 20.12 ile gelen güvenlik yaması
 * (CVE-2024-27980) `.cmd` ve `.bat` dosyalarının kabuk olmadan
 * çalıştırılmasını engelliyor — `spawn('...codex.cmd')` bu kez **EINVAL**
 * veriyor. Çözüm bunları `cmd.exe /c` üzerinden çağırmak; `shell: true`
 * kullanılmıyor çünkü uzun prompt metinlerinin tırnaklamasını bozuyor
 * (Node, argümanları kendisi doğru escape ediyor).
 *
 *   const { komut, onEk } = komutCagrisi('codex');
 *   spawn(komut, [...onEk, 'login']);
 */
export function komutCagrisi(ad) {
  const yol = komutYolu(ad) || ad;
  if (WINDOWS && /\.(cmd|bat)$/i.test(yol)) {
    return { komut: process.env.COMSPEC || 'cmd.exe', onEk: ['/c', yol] };
  }
  return { komut: yol, onEk: [] };
}

/**
 * Bir TCP portunu dinleyen süreci zorla kapatır (zombi köprü temizliği).
 * Panel yeniden başladığında eski Gemini köprüsü portu tutmaya devam edip
 * yeni köprünün "bind: address already in use" almasına yol açabiliyor.
 */
export function portTutaniOldur(port) {
  try {
    if (WINDOWS) {
      const out = execFileSync('cmd', ['/c', `netstat -ano | findstr :${port}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const pidler = new Set();
      for (const satir of out.split('\n')) {
        const m = satir.match(/LISTENING\s+(\d+)\s*$/i) || satir.match(/:\s*\d+.*?\s(\d+)\s*$/);
        if (/LISTENING/i.test(satir) && m) pidler.add(m[1]);
      }
      for (const pid of pidler) {
        try {
          execFileSync('taskkill', ['/F', '/PID', pid], { stdio: 'ignore' });
        } catch {
          /* zaten kapanmış */
        }
      }
    } else {
      const out = execFileSync('lsof', ['-ti', `:${port}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const pid of out.split('\n').map((s) => s.trim()).filter(Boolean)) {
        try {
          execFileSync('kill', ['-9', pid], { stdio: 'ignore' });
        } catch {
          /* zaten kapanmış */
        }
      }
    }
  } catch {
    /* port zaten boş ya da araç (netstat/lsof) yok — sorun değil */
  }
}
