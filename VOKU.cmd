@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title VOKU

rem  VOKU - cift tiklanan kontrol paneli (Windows).
rem  macOS'taki VOKU.command ile ayni menu: panel/bot baslat-durdur, dis
rem  erisim (ngrok), misafir baglantisi, guncelleme, otomatik baslatma.
rem
rem  Not: bat dosyalarinda Turkce karakter kod sayfasina bagli oldugu icin
rem  menu metinleri sade (aksansiz) yazildi - bozuk gorunmesindense duz.

cd /d "%~dp0"
set "KOK=%CD%"
set "PORT=4173"
if not "%VOKU_PORT%"=="" set "PORT=%VOKU_PORT%"
if not exist logs mkdir logs

rem Node kurulumu PATH'e her zaman yansimayabilir; olagan yerleri ekle.
set "PATH=%PATH%;%ProgramFiles%\nodejs;%ProgramFiles%\Git\cmd;%LOCALAPPDATA%\Programs\nodejs"

where node >nul 2>&1
if errorlevel 1 (
  cls
  echo.
  echo   Node.js bulunamadi.
  echo   Kurulum icin install.cmd dosyasini calistir ^(ya da nodejs.org^).
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo   Ilk kurulum yapiliyor, bir dakika surebilir...
  call npm install --no-audit --no-fund >> logs\kurulum.log 2>&1
)

:acilis
rem Durum yalniz degiskenleri doldursun diye ciktisi bastirilir.
call :durum >nul
if "!ACILISTA!"=="kapali" goto menu
if "%PANEL%"=="calisiyor" if "%TUNEL%"=="acik" goto menu
cls
echo.
echo   VOKU - hazirlaniyor...
echo.
if not "%PANEL%"=="calisiyor" call :panel_baslat
if not "%TUNEL%"=="acik" (
  echo   Dis erisim aciliyor...
  call :tunel_baslat
)

:menu
cls
call :durum
echo.
echo   1  Paneli ac ^(tarayicida^)
echo   2  Disariya ac - misafir baglantisi uret ve kopyala
echo   3  Dis erisimi kapat
echo   4  Baglantiyi yenile ^(eski baglanti gecersiz olur^)
echo   5  Her seyi kapat
echo   6  Guncelle ^(GitHub'daki yeni surumu cek^)
echo   7  Bilgisayar acilinca kendiliginden baslasin   [!OTO!]
echo   8  Otomatik guncelleme                          [!OTOGUNCEL!]
echo   9  Acilista panel + dis erisim                  [!ACILISTA!]
echo   0  Cik ^(panel arka planda calismaya devam eder^)
echo.
set "secim="
set /p "secim=  Secim: "

if "%secim%"=="1" goto panele_git
if "%secim%"=="2" goto disariya_ac
if "%secim%"=="3" goto disariyi_kapat
if "%secim%"=="4" goto baglanti_yenile
if "%secim%"=="5" goto hepsini_kapat
if "%secim%"=="6" goto guncelle
if "%secim%"=="7" goto otomatik_baslat
if "%secim%"=="8" goto otomatik_guncelle
if "%secim%"=="9" goto acilista_degistir
if "%secim%"=="0" goto cikis
goto menu

rem ------------------------------------------------------------------ durum
:durum
set "PANEL=kapali"
set "TELEGRAM=kapali"
set "TUNEL=kapali"
set "ADRES="
set "KUYRUK="
set "OTO=kapali"
set "OTOGUNCEL=kapali"
set "ACILISTA=acik"
set "LINK="
set "GUNCELLEME="

netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul 2>&1
if not errorlevel 1 set "PANEL=calisiyor"

if "%PANEL%"=="calisiyor" (
  for /f "delims=" %%A in ('curl -s --max-time 3 "http://127.0.0.1:%PORT%/api/state" 2^>nul ^| node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const k=j.joblar.filter(x=>x.kosuyor||x.status==='running').length;const b=j.joblar.filter(x=>x.status==='pending').length;const t=j.telegram||{};console.log((t.acik?'dinliyor @'+(t.bot?t.bot.username:'-'):'kapali')+';'+j.joblar.length+' is, '+k+' calisiyor, '+b+' bekliyor')}catch{console.log('kapali;')}})" 2^>nul') do (
    for /f "tokens=1,2 delims=;" %%B in ("%%A") do (
      set "TELEGRAM=%%B"
      set "KUYRUK=%%C"
    )
  )
)

tasklist /fi "imagename eq ngrok.exe" 2>nul | find /i "ngrok.exe" >nul
if not errorlevel 1 (
  for /f "delims=" %%A in ('curl -s --max-time 2 http://127.0.0.1:4040/api/tunnels 2^>nul ^| node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const t=JSON.parse(s).tunnels.find(x=>x.public_url.startsWith('https'));console.log(t?t.public_url:'')}catch{console.log('')}})" 2^>nul') do set "ADRES=%%A"
  if not "!ADRES!"=="" set "TUNEL=acik"
)

schtasks /query /tn "VOKU Panel" >nul 2>&1
if not errorlevel 1 set "OTO=acik"

if exist config\tunel.json (
  findstr /c:"\"acilistaAc\": false" config\tunel.json >nul 2>&1
  if not errorlevel 1 set "ACILISTA=kapali"
)

if exist config\guncelleme.json (
  findstr /c:"\"otomatik\": true" config\guncelleme.json >nul 2>&1
  if not errorlevel 1 set "OTOGUNCEL=acik"
)

echo.
echo   VOKU  - karanlik oda
echo   --------------------------------------------------
if "%PANEL%"=="calisiyor" (
  echo   [+] Panel      calisiyor    http://127.0.0.1:%PORT%
) else (
  echo   [ ] Panel      kapali
)
echo   [.] Telegram   %TELEGRAM%
if "%TUNEL%"=="acik" (
  echo   [+] Dis erisim acik         !ADRES!
  call :baglanti_yaz
) else (
  echo   [ ] Dis erisim kapali
)
if not "%KUYRUK%"=="" (
  echo.
  echo   Kuyruk: %KUYRUK%
)
if not "%GUNCELLEME%"=="" echo   %GUNCELLEME%
exit /b

rem Paylasilacak tam baglanti - 2'ye basmaya gerek kalmasin.
:baglanti_yaz
for /f "delims=" %%K in ('node -e "import('./src/erisim.js').then(m=>console.log(m.erisimAyarlariniYukle().misafirToken))" 2^>nul') do set "ANAHTAR=%%K"
if not "!ANAHTAR!"=="" echo       baglanti: !ADRES!/?anahtar=!ANAHTAR!
exit /b

rem Tuneli baslatir: kayitli adres varsa onunla (baglanti degismesin),
rem alinamazsa serbest adresle tekrar dener ve yeni adresi kaydeder.
:tunel_baslat
rem "Surec var" yeterli degil: olmekte olan bir ngrok ornegi tunelin hazir
rem sanilmasina yol aciyor. Olcut adresin alinabilmesi.
tasklist /fi "imagename eq ngrok.exe" 2>nul | find /i "ngrok.exe" >nul
if not errorlevel 1 (
  set "ADRES="
  for /f "delims=" %%A in ('curl -s --max-time 2 http://127.0.0.1:4040/api/tunnels 2^>nul ^| node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const t=JSON.parse(s).tunnels.find(x=>x.public_url.startsWith('https'));console.log(t?t.public_url:'')}catch{console.log('')}})" 2^>nul') do set "ADRES=%%A"
  if not "!ADRES!"=="" exit /b 0
  taskkill /f /im ngrok.exe >nul 2>&1
  timeout /t 1 /nobreak >nul
)
where ngrok >nul 2>&1
if errorlevel 1 exit /b 1
ngrok config check >nul 2>&1
if errorlevel 1 exit /b 1

set "DOMAIN=%NGROK_DOMAIN%"
if "!DOMAIN!"=="" (
  for /f "delims=" %%D in ('node src\cli.js tunel 2^>nul') do set "DOMAIN=%%D"
)
if "!DOMAIN!"=="" (
  start "" /b cmd /c "ngrok http %PORT% --log=stdout >> logs\ngrok.log 2>&1"
) else (
  start "" /b cmd /c "ngrok http %PORT% --url=!DOMAIN! --log=stdout >> logs\ngrok.log 2>&1"
)

call :adres_bekle
if not "!ADRES!"=="" goto :tunel_kaydet

rem Kayitli adres hesapta yoksa ngrok acilmaz; serbest adresle dene.
if not "!DOMAIN!"=="" (
  taskkill /f /im ngrok.exe >nul 2>&1
  start "" /b cmd /c "ngrok http %PORT% --log=stdout >> logs\ngrok.log 2>&1"
  call :adres_bekle
)
if "!ADRES!"=="" exit /b 1

:tunel_kaydet
call node src\cli.js tunel --kaydet "!ADRES!" >nul 2>&1
exit /b 0

:adres_bekle
set "ADRES="
for /l %%i in (1,1,25) do (
  if "!ADRES!"=="" (
    timeout /t 1 /nobreak >nul
    for /f "delims=" %%A in ('curl -s --max-time 2 http://127.0.0.1:4040/api/tunnels 2^>nul ^| node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const t=JSON.parse(s).tunnels.find(x=>x.public_url.startsWith('https'));console.log(t?t.public_url:'')}catch{console.log('')}})" 2^>nul') do set "ADRES=%%A"
  )
)
exit /b

rem ------------------------------------------------------- panel baslatma
:panel_baslat
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul 2>&1
if not errorlevel 1 exit /b 0
echo   Panel baslatiliyor...
rem Otomatik guncelleme aciksa once yeni surumu cek.
if exist config\guncelleme.json (
  findstr /c:"\"otomatik\": true" config\guncelleme.json >nul 2>&1
  if not errorlevel 1 (
    echo   Guncelleme kontrol ediliyor...
    call node src\cli.js guncelle >> logs\guncelleme.log 2>&1
  )
)
start "" /b cmd /c "scripts\baslat.cmd"
for /l %%i in (1,1,30) do (
  timeout /t 1 /nobreak >nul
  netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul 2>&1
  if not errorlevel 1 exit /b 0
)
echo   Panel acilamadi. logs\panel.out dosyasina bak.
pause
exit /b 1

rem --------------------------------------------------------------- islemler
:panele_git
call :panel_baslat || goto menu
start "" "http://127.0.0.1:%PORT%"
goto menu

:disariya_ac
call :panel_baslat || goto menu
where ngrok >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Dis erisim araci ^(ngrok^) kurulu degil.
  set "c="
  set /p "c=  Simdi kurulsun mu? (e/h): "
  if /i "!c!"=="e" (
    winget install --id ngrok.ngrok -e --accept-source-agreements --accept-package-agreements
    set "PATH=%PATH%;%LOCALAPPDATA%\Microsoft\WinGet\Links"
  ) else (
    goto menu
  )
)
ngrok config check >nul 2>&1
if errorlevel 1 (
  echo.
  echo   ngrok hesabi bagli degil.
  echo   ngrok.com'da ucretsiz hesap ac, panelindeki komutu bir kez calistir:
  echo   ngrok config add-authtoken ^<senin-anahtarin^>
  echo.
  pause
  goto menu
)

echo   Dis erisim aciliyor...
call :tunel_baslat
if "!ADRES!"=="" (
  echo   Dis adres alinamadi. logs\ngrok.log dosyasina bak.
  pause
  goto menu
)

for /f "delims=" %%A in ('node -e "import('./src/erisim.js').then(m=>console.log(m.erisimAyarlariniYukle().misafirToken))" 2^>nul') do set "ANAHTAR=%%A"
set "LINK=!ADRES!/?anahtar=!ANAHTAR!"
<nul set /p "=!LINK!" | clip

cls
echo.
echo   Dis erisim acik.
echo.
echo   Paylasilacak baglanti ^(panoya kopyalandi - WhatsApp'a yapistir^)
echo.
echo   !LINK!
echo.
echo   Bu baglantiyla girenler isleri ve fotograflari gorur;
echo   is acamaz, silemez, ayarlara giremez.
echo   Ilk acilista uyari sayfasi cikarsa 'Visit Site' demeleri yeterli.
echo.
echo   Bu bilgisayar uyursa baglanti calismaz.
echo.
pause
goto menu

:disariyi_kapat
taskkill /f /im ngrok.exe >nul 2>&1
echo   Dis erisim kapatildi - paylasilan baglanti artik acilmaz.
timeout /t 2 /nobreak >nul
goto menu

:baglanti_yenile
echo.
echo   Eski baglanti gecersiz olacak; kimse eski linkle giremeyecek.
set "c="
set /p "c=  Yenilensin mi? (e/h): "
if /i not "%c%"=="e" goto menu
call node src\cli.js baglanti --yenile >nul 2>&1
echo   Yeni baglanti uretildi. 2 numarayla yeni linki al.
timeout /t 2 /nobreak >nul
goto menu

:hepsini_kapat
set "c="
set /p "c=  Panel, Telegram botu ve dis erisim kapatilsin mi? (e/h): "
if /i not "%c%"=="e" goto menu
taskkill /f /im ngrok.exe >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do taskkill /f /pid %%P >nul 2>&1
echo   Kapatildi. Suren isler varsa panel acilinca kaldigi yerden devam eder.
timeout /t 2 /nobreak >nul
goto menu

:guncelle
cls
echo.
echo   Guncelleme kontrol ediliyor...
echo.
for /f "delims=" %%A in ('node src\cli.js guncelle --kontrol 2^>nul') do set "SONUC=%%A"
for /f "tokens=1,2,* delims=|" %%B in ("!SONUC!") do (
  set "DURUM=%%B"
  set "ADET=%%C"
  set "MESAJ=%%D"
)
if "!DURUM!"=="hata" (
  echo   Kontrol edilemedi: !MESAJ!
  echo.
  pause
  goto menu
)
if "!DURUM!"=="yok" (
  echo   Zaten guncel.
  echo.
  pause
  goto menu
)
echo   Yeni surum var: !ADET! guncelleme
if not "!MESAJ!"=="" echo   Son degisiklik: !MESAJ!
echo.
set "c="
set /p "c=  Simdi guncellensin mi? (e/h): "
if /i not "%c%"=="e" goto menu
echo.
echo   Panel kapatiliyor...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do taskkill /f /pid %%P >nul 2>&1
call node src\cli.js guncelle
echo.
echo   Panel yeniden baslatiliyor...
call :panel_baslat
echo   Bitti.
timeout /t 3 /nobreak >nul
goto menu

:otomatik_baslat
if "%OTO%"=="acik" (
  set "c="
  set /p "c=  Otomatik baslatma kapatilsin mi? (e/h): "
  if /i not "!c!"=="e" goto menu
  schtasks /delete /tn "VOKU Panel" /f >nul 2>&1
  echo   Kapatildi.
  timeout /t 2 /nobreak >nul
  goto menu
)
schtasks /create /tn "VOKU Panel" /tr "\"%KOK%\scripts\baslat.cmd\"" /sc onlogon /rl limited /f >nul 2>&1
if errorlevel 1 (
  echo   Gorev olusturulamadi. Bu dosyayi yonetici olarak calistirmayi dene.
  pause
  goto menu
)
echo   Acildi. Bilgisayar her acildiginda panel ve Telegram botu baslar.
timeout /t 2 /nobreak >nul
goto menu

:otomatik_guncelle
if "%OTOGUNCEL%"=="acik" (
  call node src\cli.js guncelle --otomatik kapali >nul 2>&1
  echo   Otomatik guncelleme kapatildi.
) else (
  call node src\cli.js guncelle --otomatik acik >nul 2>&1
  echo   Otomatik guncelleme acildi - panel her baslatildiginda yeni surum cekilir.
)
timeout /t 2 /nobreak >nul
goto menu

:acilista_degistir
if "!ACILISTA!"=="acik" (
  call node src\cli.js tunel --acilista kapali >nul 2>&1
  echo   Kapatildi. Bundan sonra panel ve dis erisimi elle acarsin.
) else (
  call node src\cli.js tunel --acilista acik >nul 2>&1
  echo   Acildi. Bu dosyayi her actiginda panel ve dis erisim kendiliginden kalkar.
)
timeout /t 2 /nobreak >nul
goto menu

:cikis
cls
echo.
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo   Panel arka planda calismaya devam ediyor.
) else (
  echo   Panel kapali.
)
echo   Bu pencereyi kapatabilirsin.
echo.
timeout /t 3 /nobreak >nul
exit /b 0
