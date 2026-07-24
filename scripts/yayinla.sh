#!/usr/bin/env bash
# voku panelini ngrok üzerinden dışarı açar ve paylaşım bağlantısını basar.
#
# Panel yalnız 127.0.0.1'e bağlıdır; ngrok o portu dışarı taşır. Kimlik
# doğrulama panelin kendisindedir (config/erisim.json) — ngrok'un ücretsiz
# planında basic auth yok, o yüzden koruma tünel sağlayıcısına bırakılmaz.
#
#   ./scripts/yayinla.sh                 rastgele ngrok adresi
#   NGROK_DOMAIN=xxx.ngrok-free.dev ./scripts/yayinla.sh   sabit adres
#
# Panelin ayrıca çalışıyor olması gerekir (node src/cli.js panel).
set -euo pipefail

KOK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${VOKU_PORT:-4173}"

command -v ngrok >/dev/null || { echo "ngrok kurulu değil: brew install ngrok"; exit 1; }

if ! curl -sf "http://127.0.0.1:${PORT}/api/state" >/dev/null 2>&1; then
  echo "Panel ${PORT} portunda çalışmıyor. Önce: node src/cli.js panel"
  exit 1
fi

if [ -n "${NGROK_DOMAIN:-}" ]; then
  ngrok http "${PORT}" --url="${NGROK_DOMAIN}" --log=stdout > "${KOK}/logs/ngrok.log" 2>&1 &
else
  ngrok http "${PORT}" --log=stdout > "${KOK}/logs/ngrok.log" 2>&1 &
fi
NGROK_PID=$!
trap 'kill ${NGROK_PID} 2>/dev/null || true' EXIT INT TERM

# Tünel adresi ngrok'un yerel API'sinden okunur (kendi 4040 portu).
ADRES=""
for _ in $(seq 1 20); do
  sleep 0.5
  ADRES=$(curl -sf http://127.0.0.1:4040/api/tunnels 2>/dev/null \
    | sed -n 's/.*"public_url":"\(https:[^"]*\)".*/\1/p' | head -1) || true
  [ -n "$ADRES" ] && break
done

if [ -z "$ADRES" ]; then
  echo "Tünel adresi alınamadı. logs/ngrok.log dosyasına bak."
  exit 1
fi

echo
echo "  Tünel açık: ${ADRES}"
node "${KOK}/src/cli.js" baglanti --adres "${ADRES}"
echo "  Ziyaretçi ngrok'un ücretsiz uyarı sayfasında bir kez 'Visit Site' der."
echo "  Kapatmak için Ctrl+C."
echo

wait ${NGROK_PID}
