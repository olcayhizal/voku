import * as chatgpt from './chatgpt.js';
import * as gemini from './gemini.js';
import * as chatgptCodex from './chatgpt-codex.js';
import * as geminiHttp from './gemini-http.js';

/**
 * Yeni platform: buraya bir satır ekle, runner'a dokunma.
 * Bir platform hangi sürücüyü kullanacağını `settings.platforms.<ad>.adapter`
 * ile seçer — prompt listesindeki `platform: "chatgpt"` değişmeden motor
 * tarayıcıdan Codex'e (veya tersine) çevrilebilir.
 */
export const ADAPTORLER = {
  chatgpt, // tarayıcı (chatgpt.com)
  gemini, // tarayıcı (gemini.google.com)
  'chatgpt-codex': chatgptCodex, // Codex CLI + image_gen, tarayıcısız
  'gemini-http': geminiHttp, // yerel gemini-web-to-api köprüsü, tarayıcısız
};

export function adaptorAl(platformAdi) {
  const a = ADAPTORLER[platformAdi];
  if (!a) {
    throw new Error(
      `Adapter yok: ${platformAdi}. Tanımlı: ${Object.keys(ADAPTORLER).join(', ')}`
    );
  }
  return a;
}
