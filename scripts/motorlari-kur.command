#!/bin/bash
# Gemini köprü servisi + watermark temizleyici kurulumu (macOS/Linux).
#
# Bunlar üçüncü taraf projeler olduğu için voku deposunda taşınmaz
# (tools/ .gitignore'da); her makinede kaynağından kurulur.
# Windows karşılığı: scripts/motorlari-kur.cmd
set -uo pipefail

KAYNAK="${BASH_SOURCE[0]}"
while [ -L "$KAYNAK" ]; do
  HEDEF="$(readlink "$KAYNAK")"
  case "$HEDEF" in
    /*) KAYNAK="$HEDEF" ;;
    *) KAYNAK="$(dirname "$KAYNAK")/$HEDEF" ;;
  esac
done
cd "$(dirname "$KAYNAK")/.." || exit 1
KOK="$(pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
mkdir -p logs tools

KIRMIZI=$'\033[38;5;167m'; YESIL=$'\033[38;5;72m'; SOLUK=$'\033[38;5;245m'; SIFIR=$'\033[0m'
yaz() { printf '%s\n' "$1"; }

clear
yaz ""
yaz "  VOKU — motor kurulumu"
yaz "  ${SOLUK}──────────────────────────────────────────${SIFIR}"
yaz "  ${SOLUK}Gemini köprü servisi ve watermark temizleyici kurulur.${SIFIR}"
yaz ""

# ---- Go ----
yaz "  [1/4] Go kontrol ediliyor..."
if ! command -v go >/dev/null; then
  if command -v brew >/dev/null; then
    yaz "        ${SOLUK}Go kurulu değil, kuruluyor...${SIFIR}"
    brew install go >> logs/motor-kurulum.log 2>&1
  fi
fi
if ! command -v go >/dev/null; then
  yaz "  ${KIRMIZI}Go bulunamadı.${SIFIR} ${SOLUK}Kurulum: https://go.dev/dl/${SIFIR}"
  read -r -p "  Enter'a bas..." _
  exit 1
fi
yaz "        $(go version | cut -d' ' -f3) kurulu."

# ---- Gemini köprüsü ----
yaz "  [2/4] Gemini köprüsü indiriliyor..."
if [ -d tools/gemini-web-to-api/.git ]; then
  yaz "        Zaten var."
else
  git clone --depth 1 https://github.com/ntthanh2603/gemini-web-to-api tools/gemini-web-to-api \
    >> logs/motor-kurulum.log 2>&1 || {
    yaz "  ${KIRMIZI}İndirilemedi.${SIFIR} ${SOLUK}logs/motor-kurulum.log${SIFIR}"
    read -r -p "  Enter'a bas..." _
    exit 1
  }
fi

yaz "  [3/4] Yerel yama uygulanıyor ve derleniyor..."
(
  cd tools/gemini-web-to-api || exit 1
  # Yama olmadan köprü görseli indirmiyor (lh3 URL'leri oturum bağımlı, 403).
  if git apply --check "$KOK/patches/gemini-web-to-api.voku.patch" >/dev/null 2>&1; then
    git apply "$KOK/patches/gemini-web-to-api.voku.patch"
    echo "        Yama uygulandı."
  else
    echo "        Yama zaten uygulanmış (ya da kaynak değişmiş)."
  fi
  go build -o ../gemini-api-server ./cmd/server >> "$KOK/logs/motor-kurulum.log" 2>&1
) || {
  yaz "  ${KIRMIZI}Derlenemedi.${SIFIR} ${SOLUK}logs/motor-kurulum.log${SIFIR}"
  read -r -p "  Enter'a bas..." _
  exit 1
}
yaz "        ${YESIL}Derlendi: tools/gemini-api-server${SIFIR}"

# ---- watermark temizleyici ----
yaz "  [4/4] Watermark temizleyici indiriliyor..."
if [ -d tools/gwr/.git ]; then
  yaz "        Zaten var."
else
  git clone --depth 1 https://github.com/GargantuaX/gemini-watermark-remover tools/gwr \
    >> logs/motor-kurulum.log 2>&1 \
    || yaz "        ${SOLUK}İndirilemedi — Gemini yine çalışır, görsellerde logo kalır.${SIFIR}"
fi

yaz ""
yaz "  ${YESIL}Motor kurulumu tamam.${SIFIR}"
yaz "  ${SOLUK}Sırada: panelde Oturumlar sekmesinden Gemini girişi yap.${SIFIR}"
yaz ""
read -r -p "  Enter'a bas..." _
