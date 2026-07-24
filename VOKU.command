#!/bin/bash
# VOKU — çift tıklanan kontrol paneli.
#
# Bu dosyayı Finder'dan çift tıklamak yeter: panel, Telegram botu ve dış
# erişim (tünel) buradan yönetilir. Kullanan kişinin terminal bilmesi
# gerekmiyor — her seçenek tek rakam.
#
# Teknik notlar (geliştirici için):
#   - Panel ve bot tek süreçtir: `node src/cli.js panel`.
#   - Panel `caffeinate` altında koşar; kapak kapanınca iş yarıda kalmasın.
#   - Tünel ngrok; adres ngrok'un yerel API'sinden (4040) okunur.
#   - Misafir anahtarı config/erisim.json'da, `cli baglanti` ile yönetilir.

# Masaüstündeki kısayoldan da açılabilsin: symlink zincirini çözüp gerçek
# proje klasörüne geç (dirname "$0" kısayolda masaüstünü gösterir).
KAYNAK="${BASH_SOURCE[0]}"
while [ -L "$KAYNAK" ]; do
  HEDEF="$(readlink "$KAYNAK")"
  case "$HEDEF" in
    /*) KAYNAK="$HEDEF" ;;
    *) KAYNAK="$(dirname "$KAYNAK")/$HEDEF" ;;
  esac
done
cd "$(dirname "$KAYNAK")" || exit 1
KOK="$(pwd)"
PORT="${VOKU_PORT:-4173}"
mkdir -p logs

# Homebrew ve node çift tıkla açılan kabukta PATH'te olmayabilir.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:$PATH"

PLIST="$HOME/Library/LaunchAgents/io.voku.panel.plist"

# ---- görünüm ----------------------------------------------------------
KIRMIZI=$'\033[38;5;167m'; YESIL=$'\033[38;5;72m'; AMBER=$'\033[38;5;179m'
SOLUK=$'\033[38;5;245m'; KALIN=$'\033[1m'; SIFIR=$'\033[0m'

echo -ne "\033]0;VOKU\007"   # pencere başlığı

yaz()  { printf '%s\n' "$1"; }
bekle() { printf '\n%s' "  ${SOLUK}Devam etmek için Enter'a bas...${SIFIR}"; read -r; }

# ---- durum ------------------------------------------------------------
panel_pid()  { lsof -ti:"$PORT" 2>/dev/null | head -1; }
tunel_pid()  { pgrep -f "ngrok http $PORT" 2>/dev/null | head -1; }

tunel_adresi() {
  curl -sf --max-time 2 http://127.0.0.1:4040/api/tunnels 2>/dev/null \
    | sed -n 's/.*"public_url":"\(https:[^"]*\)".*/\1/p' | head -1
}

# Panelden özet bilgi çeker: telegram durumu + iş sayıları (node ile, jq'suz).
panel_ozeti() {
  curl -sf --max-time 3 "http://127.0.0.1:$PORT/api/state" 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const j = JSON.parse(s);
        const kosan = j.joblar.filter((x) => x.kosuyor || x.status === "running").length;
        const bekleyen = j.joblar.filter((x) => x.status === "pending").length;
        const tg = j.telegram || {};
        console.log([
          tg.acik ? "acik" : "kapali",
          tg.bot ? tg.bot.username : "-",
          j.joblar.length, kosan, bekleyen,
        ].join("|"));
      } catch { console.log("?|-|0|0|0"); }
    });
  ' 2>/dev/null
}

otomatik_mi() { [ -f "$PLIST" ] && echo "açık" || echo "kapalı"; }

otomatik_guncelleme_mi() {
  grep -q '"otomatik": true' config/guncelleme.json 2>/dev/null && echo "açık" || echo "kapalı"
}

# Güncelleme kontrolü ağa çıkar; menüyü bekletmemek için önbellekten okunur
# (`cli guncelle --kontrol` 6 saatte bir gerçekten fetch eder).
guncelleme_satiri() {
  local d
  d="$(node -e "
    import('./src/guncelleme.js').then(async (m) => {
      const s = await m.guncellemeVarMi();
      console.log(s.var ? 'var|' + s.adet : 'yok|0');
    }).catch(() => console.log('yok|0'));
  " 2>/dev/null)"
  case "$d" in
    var\|*) yaz "  ${AMBER}↑${SIFIR} Yeni sürüm var ${SOLUK}(${d#var|} güncelleme) — 7 ile kur${SIFIR}" ;;
  esac
}

durum_ekrani() {
  clear
  local pp tp adres ozet tg_durum tg_ad is kosan bekleyen
  pp="$(panel_pid)"; tp="$(tunel_pid)"

  yaz ""
  yaz "  ${KALIN}VOKU${SIFIR} ${SOLUK}— karanlık oda${SIFIR}"
  yaz "  ${SOLUK}────────────────────────────────────────────${SIFIR}"

  if [ -n "$pp" ]; then
    ozet="$(panel_ozeti)"
    tg_durum="$(echo "$ozet" | cut -d'|' -f1)"
    tg_ad="$(echo "$ozet" | cut -d'|' -f2)"
    is="$(echo "$ozet" | cut -d'|' -f3)"
    kosan="$(echo "$ozet" | cut -d'|' -f4)"
    bekleyen="$(echo "$ozet" | cut -d'|' -f5)"
    yaz "  ${YESIL}●${SIFIR} Panel      çalışıyor    ${SOLUK}http://127.0.0.1:$PORT${SIFIR}"
    if [ "$tg_durum" = "acik" ]; then
      yaz "  ${YESIL}●${SIFIR} Telegram   dinliyor     ${SOLUK}@${tg_ad}${SIFIR}"
    else
      yaz "  ${KIRMIZI}●${SIFIR} Telegram   kapalı"
    fi
  else
    yaz "  ${SOLUK}○${SIFIR} Panel      ${KIRMIZI}kapalı${SIFIR}"
    yaz "  ${SOLUK}○${SIFIR} Telegram   ${SOLUK}kapalı${SIFIR}"
  fi

  adres="$(tunel_adresi)"
  if [ -n "$tp" ] && [ -n "$adres" ]; then
    yaz "  ${YESIL}●${SIFIR} Dış erişim açık         ${SOLUK}${adres}${SIFIR}"
  else
    yaz "  ${SOLUK}○${SIFIR} Dış erişim ${SOLUK}kapalı${SIFIR}"
  fi

  if [ -n "$pp" ] && [ -n "${is:-}" ]; then
    yaz ""
    yaz "  ${SOLUK}Kuyruk: ${is} iş · ${kosan} çalışıyor · ${bekleyen} bekliyor${SIFIR}"
  fi
  guncelleme_satiri

  yaz ""
  yaz "  ${AMBER}1${SIFIR}  Paneli aç ${SOLUK}(tarayıcıda)${SIFIR}"
  yaz "  ${AMBER}2${SIFIR}  Dışarıya aç ${SOLUK}— misafir bağlantısı üret ve kopyala${SIFIR}"
  yaz "  ${AMBER}3${SIFIR}  Dış erişimi kapat"
  yaz "  ${AMBER}4${SIFIR}  Bağlantıyı yenile ${SOLUK}(eski bağlantı geçersiz olur)${SIFIR}"
  yaz "  ${AMBER}5${SIFIR}  Her şeyi kapat"
  yaz "  ${AMBER}6${SIFIR}  Bilgisayar açılınca kendiliğinden başlasın   ${SOLUK}[$(otomatik_mi)]${SIFIR}"
  yaz "  ${AMBER}7${SIFIR}  Güncelle ${SOLUK}(GitHub'daki yeni sürümü çek)${SIFIR}"
  yaz "  ${AMBER}8${SIFIR}  Otomatik güncelleme                         ${SOLUK}[$(otomatik_guncelleme_mi)]${SIFIR}"
  yaz "  ${AMBER}0${SIFIR}  Çık ${SOLUK}(panel arka planda çalışmaya devam eder)${SIFIR}"
  yaz ""
}

# ---- işler ------------------------------------------------------------
gereksinim_kontrol() {
  if ! command -v node >/dev/null; then
    yaz ""
    yaz "  ${KIRMIZI}Node.js bulunamadı.${SIFIR}"
    yaz "  ${SOLUK}Kurulum: https://nodejs.org (LTS sürümü) — sonra bu pencereyi kapatıp tekrar aç.${SIFIR}"
    bekle
    return 1
  fi
  if [ ! -d node_modules ]; then
    yaz "  ${SOLUK}İlk kurulum yapılıyor, bir dakika sürebilir...${SIFIR}"
    npm install --silent >> logs/kurulum.log 2>&1 || {
      yaz "  ${KIRMIZI}Kurulum başarısız.${SIFIR} ${SOLUK}logs/kurulum.log dosyasına bak.${SIFIR}"
      bekle
      return 1
    }
  fi
  return 0
}

panel_baslat() {
  [ -n "$(panel_pid)" ] && return 0
  gereksinim_kontrol || return 1
  # Otomatik güncelleme açıksa panel yeni sürümle kalksın.
  if [ "$(otomatik_guncelleme_mi)" = "açık" ]; then
    yaz "  ${SOLUK}Güncelleme kontrol ediliyor...${SIFIR}"
    node src/cli.js guncelle >> logs/guncelleme.log 2>&1 || true
  fi
  yaz "  ${SOLUK}Panel başlatılıyor...${SIFIR}"
  # caffeinate: kapak kapansa da üretim ve Telegram botu ayakta kalsın.
  nohup caffeinate -dimsu node src/cli.js panel --port "$PORT" >> logs/panel.out 2>&1 &
  for _ in $(seq 1 30); do
    sleep 0.4
    [ -n "$(panel_pid)" ] && return 0
  done
  yaz "  ${KIRMIZI}Panel açılamadı.${SIFIR} ${SOLUK}logs/panel.out dosyasına bak.${SIFIR}"
  return 1
}

panele_git() {
  panel_baslat || { bekle; return; }
  open "http://127.0.0.1:$PORT"
  yaz "  ${YESIL}Panel tarayıcıda açıldı.${SIFIR}"
  sleep 1
}

disariya_ac() {
  panel_baslat || { bekle; return; }

  if ! command -v ngrok >/dev/null; then
    yaz ""
    yaz "  ${KIRMIZI}Dış erişim aracı (ngrok) kurulu değil.${SIFIR}"
    if command -v brew >/dev/null; then
      printf '%s' "  Şimdi kurulsun mu? (e/h): "
      read -r c
      if [ "$c" = "e" ] || [ "$c" = "E" ]; then
        yaz "  ${SOLUK}Kuruluyor...${SIFIR}"
        brew install ngrok >> logs/kurulum.log 2>&1 || {
          yaz "  ${KIRMIZI}Kurulamadı.${SIFIR} ${SOLUK}logs/kurulum.log${SIFIR}"; bekle; return; }
      else
        return
      fi
    else
      yaz "  ${SOLUK}Kurulum: https://ngrok.com/download${SIFIR}"
      bekle; return
    fi
  fi

  if ! ngrok config check >/dev/null 2>&1; then
    yaz ""
    yaz "  ${KIRMIZI}ngrok hesabı bağlı değil.${SIFIR}"
    yaz "  ${SOLUK}ngrok.com'da ücretsiz hesap aç, panelindeki komutu bir kez çalıştır:${SIFIR}"
    yaz "  ${SOLUK}ngrok config add-authtoken <senin-anahtarın>${SIFIR}"
    bekle; return
  fi

  if [ -z "$(tunel_pid)" ]; then
    yaz "  ${SOLUK}Dış erişim açılıyor...${SIFIR}"
    if [ -n "${NGROK_DOMAIN:-}" ]; then
      nohup ngrok http "$PORT" --url="$NGROK_DOMAIN" --log=stdout >> logs/ngrok.log 2>&1 &
    else
      nohup ngrok http "$PORT" --log=stdout >> logs/ngrok.log 2>&1 &
    fi
  fi

  local adres=""
  for _ in $(seq 1 25); do
    sleep 0.5
    adres="$(tunel_adresi)"
    [ -n "$adres" ] && break
  done

  if [ -z "$adres" ]; then
    yaz "  ${KIRMIZI}Dış adres alınamadı.${SIFIR} ${SOLUK}logs/ngrok.log dosyasına bak.${SIFIR}"
    bekle; return
  fi

  local anahtar link
  anahtar="$(node -e "import('./src/erisim.js').then(m=>console.log(m.erisimAyarlariniYukle().misafirToken))" 2>/dev/null)"
  link="${adres}/?anahtar=${anahtar}"
  printf '%s' "$link" | pbcopy 2>/dev/null

  clear
  yaz ""
  yaz "  ${YESIL}${KALIN}Dış erişim açık.${SIFIR}"
  yaz ""
  yaz "  ${KALIN}Paylaşılacak bağlantı${SIFIR} ${SOLUK}(panoya kopyalandı — WhatsApp'a yapıştır)${SIFIR}"
  yaz ""
  yaz "  ${AMBER}${link}${SIFIR}"
  yaz ""
  yaz "  ${SOLUK}Bu bağlantıyla girenler işleri ve fotoğrafları görür;${SIFIR}"
  yaz "  ${SOLUK}iş açamaz, silemez, ayarlara giremez.${SIFIR}"
  yaz "  ${SOLUK}İlk açılışta bir uyarı sayfası çıkarsa 'Visit Site' demeleri yeterli.${SIFIR}"
  yaz ""
  yaz "  ${SOLUK}Bu bilgisayar uyursa bağlantı çalışmaz — kapağı açık bırak.${SIFIR}"
  bekle
}

disariyi_kapat() {
  if [ -z "$(tunel_pid)" ]; then
    yaz "  ${SOLUK}Dış erişim zaten kapalı.${SIFIR}"; sleep 1; return
  fi
  pkill -f "ngrok http $PORT" 2>/dev/null
  sleep 1
  yaz "  ${YESIL}Dış erişim kapatıldı — paylaşılan bağlantı artık açılmaz.${SIFIR}"
  sleep 1
}

baglantiyi_yenile() {
  yaz ""
  yaz "  ${SOLUK}Eski bağlantı geçersiz olacak; kimse eski linkle giremeyecek.${SIFIR}"
  printf '%s' "  Yenilensin mi? (e/h): "
  read -r c
  [ "$c" = "e" ] || [ "$c" = "E" ] || return
  node src/cli.js baglanti --yenile >/dev/null 2>&1
  yaz "  ${YESIL}Yeni bağlantı üretildi.${SIFIR} ${SOLUK}2 numarayla yeni linki al.${SIFIR}"
  sleep 2
}

hepsini_kapat() {
  printf '%s' "  Panel, Telegram botu ve dış erişim kapatılsın mı? (e/h): "
  read -r c
  [ "$c" = "e" ] || [ "$c" = "E" ] || return
  pkill -f "ngrok http $PORT" 2>/dev/null
  pkill -f "cli.js panel" 2>/dev/null
  sleep 1
  yaz "  ${YESIL}Kapatıldı.${SIFIR} ${SOLUK}Süren işler varsa yarıda kaldı; panel açılınca kaldığı yerden devam eder.${SIFIR}"
  sleep 2
}

otomatik_baslat() {
  if [ -f "$PLIST" ]; then
    printf '%s' "  Otomatik başlatma kapatılsın mı? (e/h): "
    read -r c
    [ "$c" = "e" ] || [ "$c" = "E" ] || return
    launchctl unload "$PLIST" 2>/dev/null
    rm -f "$PLIST"
    yaz "  ${YESIL}Kapatıldı.${SIFIR}"
    sleep 1
    return
  fi

  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLISTSON
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.voku.panel</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string><string>-dimsu</string>
    <string>$(command -v node)</string>
    <string>${KOK}/src/cli.js</string><string>panel</string>
    <string>--port</string><string>${PORT}</string>
  </array>
  <key>WorkingDirectory</key><string>${KOK}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${KOK}/logs/panel.out</string>
  <key>StandardErrorPath</key><string>${KOK}/logs/panel.out</string>
</dict></plist>
PLISTSON
  launchctl load "$PLIST" 2>/dev/null
  yaz "  ${YESIL}Açıldı.${SIFIR} ${SOLUK}Bilgisayar her açıldığında panel ve Telegram botu kendiliğinden başlar.${SIFIR}"
  sleep 2
}

guncelleme_yap() {
  clear
  yaz ""
  yaz "  ${SOLUK}Güncelleme kontrol ediliyor...${SIFIR}"
  local sonuc durum adet mesaj
  sonuc="$(node src/cli.js guncelle --kontrol 2>/dev/null)"
  durum="${sonuc%%|*}"; sonuc="${sonuc#*|}"
  adet="${sonuc%%|*}"; mesaj="${sonuc#*|}"

  case "$durum" in
    hata)
      yaz "  ${KIRMIZI}Kontrol edilemedi.${SIFIR} ${SOLUK}${mesaj}${SIFIR}"
      bekle; return ;;
    yok)
      yaz "  ${YESIL}Zaten güncel.${SIFIR}"
      sleep 2; return ;;
  esac

  yaz ""
  yaz "  ${AMBER}Yeni sürüm var${SIFIR} ${SOLUK}(${adet} güncelleme)${SIFIR}"
  [ -n "$mesaj" ] && yaz "  ${SOLUK}Son değişiklik: ${mesaj}${SIFIR}"
  yaz ""
  printf '%s' "  Şimdi güncellensin mi? (e/h): "
  read -r c
  [ "$c" = "e" ] || [ "$c" = "E" ] || return

  local panelAcikti=0
  [ -n "$(panel_pid)" ] && panelAcikti=1
  if [ "$panelAcikti" = "1" ]; then
    yaz "  ${SOLUK}Panel kapatılıyor...${SIFIR}"
    pkill -f "cli.js panel" 2>/dev/null
    sleep 2
  fi

  if node src/cli.js guncelle; then
    yaz "  ${YESIL}Güncelleme tamam.${SIFIR}"
  else
    yaz "  ${KIRMIZI}Güncelleme yapılamadı.${SIFIR} ${SOLUK}Yukarıdaki mesaja bak.${SIFIR}"
  fi
  [ "$panelAcikti" = "1" ] && panel_baslat
  bekle
}

otomatik_guncelleme_degistir() {
  if [ "$(otomatik_guncelleme_mi)" = "açık" ]; then
    node src/cli.js guncelle --otomatik kapali >/dev/null 2>&1
    yaz "  ${YESIL}Otomatik güncelleme kapatıldı.${SIFIR}"
  else
    node src/cli.js guncelle --otomatik acik >/dev/null 2>&1
    yaz "  ${YESIL}Açıldı.${SIFIR} ${SOLUK}Panel her başlatıldığında yeni sürüm çekilir.${SIFIR}"
  fi
  sleep 2
}

# ---- döngü ------------------------------------------------------------
while true; do
  durum_ekrani
  printf '%s' "  Seçim: "
  read -r secim
  case "$secim" in
    1) panele_git ;;
    2) disariya_ac ;;
    3) disariyi_kapat ;;
    4) baglantiyi_yenile ;;
    5) hepsini_kapat ;;
    6) otomatik_baslat ;;
    7) guncelleme_yap ;;
    8) otomatik_guncelleme_degistir ;;
    0|q|Q)
      clear
      yaz ""
      [ -n "$(panel_pid)" ] \
        && yaz "  ${SOLUK}Panel arka planda çalışmaya devam ediyor.${SIFIR}" \
        || yaz "  ${SOLUK}Panel kapalı.${SIFIR}"
      yaz "  ${SOLUK}Bu pencereyi kapatabilirsin.${SIFIR}"
      yaz ""
      exit 0
      ;;
    *) ;;
  esac
done
