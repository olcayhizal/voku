/**
 * codex-temizlik.js'in worker'ı: Codex sqlite'ından ölü sohbet satırlarını
 * siler ve dosyayı küçültür. İlk temizlikte GB'larca base64 satır silinir —
 * ana süreçte koşsa panel ve Telegram dakikalarca donardı.
 *
 * Şema Codex sürümüyle değişebilir: tablo adı sabitlenmez, `thread_id`
 * sütunu olan her tablodan tutulacaklar dışındaki satırlar silinir.
 */
import { parentPort, workerData } from 'node:worker_threads';

const { dosya, tutulacaklar } = workerData;

try {
  // node:sqlite Node 22.13+'ta bayraksız; daha eskisinde bu adım atlanır.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dosya);
  db.exec('PRAGMA busy_timeout = 15000');
  const tablolar = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name)
    .filter((t) => db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = 'thread_id'").get(t));
  const liste = JSON.stringify(tutulacaklar);
  let satir = 0;
  for (const t of tablolar) {
    const r = db
      .prepare(`DELETE FROM "${t.replaceAll('"', '""')}" WHERE thread_id NOT IN (SELECT value FROM json_each(?))`)
      .run(liste);
    satir += Number(r.changes);
  }
  // Silmek dosyayı küçültmez; yer ancak VACUUM ile diske döner.
  if (satir) db.exec('VACUUM');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  parentPort.postMessage({ satir });
} catch (e) {
  parentPort.postMessage({ hata: `${dosya.split(/[\\/]/).pop()}: ${e.message}` });
}
