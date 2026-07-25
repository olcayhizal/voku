@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title VOKU - Kurulum

rem  VOKU kurulumu (Windows).
rem  Cift tikla: Git ve Node.js yoksa winget ile kurar, projeyi GitHub'dan
rem  ceker, bagimliliklari yukler, yapilandirma dosyalarini ornekten
rem  olusturur ve masaustune kisayol koyar.
rem
rem  Kurulum yeri: %USERPROFILE%\voku  (VOKU_DIZIN ile degistirilebilir)
rem  Kaynak repo:  VOKU_REPO ortam degiskeni ile degistirilebilir.

set "REPO=https://github.com/olcayhizal/voku.git"
if not "%VOKU_REPO%"=="" set "REPO=%VOKU_REPO%"
set "HEDEF=%USERPROFILE%\voku"
if not "%VOKU_DIZIN%"=="" set "HEDEF=%VOKU_DIZIN%"

set "PATH=%PATH%;%ProgramFiles%\nodejs;%ProgramFiles%\Git\cmd;%LOCALAPPDATA%\Programs\nodejs;%LOCALAPPDATA%\Microsoft\WinGet\Links"

cls
echo.
echo   VOKU kurulumu
echo   --------------------------------------------------
echo   Kurulacak yer : %HEDEF%
echo   Kaynak        : %REPO%
echo.
echo   Bu islem birkac dakika surebilir.
echo.
pause

rem ------------------------------------------------------------ 1. Git
echo.
echo   [1/7] Git kontrol ediliyor...
where git >nul 2>&1
if errorlevel 1 (
  echo         Git kurulu degil, kuruluyor...
  where winget >nul 2>&1
  if errorlevel 1 (
    echo.
    echo   Bu Windows surumunde otomatik kurulum araci ^(winget^) yok.
    echo   Once sunu kur: https://git-scm.com/download/win
    echo   Sonra bu dosyayi tekrar calistir.
    echo.
    pause
    exit /b 1
  )
  winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
  set "PATH=%PATH%;%ProgramFiles%\Git\cmd"
) else (
  echo         Git kurulu.
)

rem ----------------------------------------------------------- 2. Node.js
echo   [2/7] Node.js kontrol ediliyor...
where node >nul 2>&1
if errorlevel 1 (
  echo         Node.js kurulu degil, kuruluyor...
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
) else (
  for /f "delims=" %%V in ('node -v') do set "NODESURUM=%%V"
  echo         Node.js kurulu ^(!NODESURUM!^).
)

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js kurulumu tamamlanamadi. Bilgisayari yeniden baslatip
  echo   bu dosyayi tekrar calistir.
  echo.
  pause
  exit /b 1
)

rem -------------------------------------------------------------- 3. Proje
echo   [3/7] Proje indiriliyor...
if exist "%HEDEF%\.git" (
  echo         Zaten kurulu, guncelleniyor...
  pushd "%HEDEF%"
  git pull --ff-only
  popd
) else (
  git clone "%REPO%" "%HEDEF%"
  if errorlevel 1 (
    echo.
    echo   Proje indirilemedi. Internet baglantisini ve adresi kontrol et:
    echo   %REPO%
    echo.
    pause
    exit /b 1
  )
)

rem -------------------------------------------------------- 4. Bagimliliklar
echo   [4/7] Bagimliliklar kuruluyor ^(bu adim uzun surebilir^)...
pushd "%HEDEF%"
if not exist logs mkdir logs
call npm install --no-audit --no-fund >> logs\kurulum.log 2>&1
if errorlevel 1 (
  echo.
  echo   Bagimliliklar kurulamadi. Ayrinti: %HEDEF%\logs\kurulum.log
  echo.
  popd
  pause
  exit /b 1
)

rem ------------------------------------------------- 5. Yapilandirma + kisayol
echo   [5/7] Yapilandirma hazirlaniyor...
if not exist config\settings.json (
  if exist config\settings.example.json copy /y config\settings.example.json config\settings.json >nul
)
if not exist config\telegram.json (
  if exist config\telegram.example.json copy /y config\telegram.example.json config\telegram.json >nul
)
if not exist config\prompts.json (
  if exist config\prompts.example.json copy /y config\prompts.example.json config\prompts.json >nul
)

rem --------------------------------------------------- 6. ChatGPT motoru
echo   [6/7] ChatGPT motoru ^(Codex CLI^) kuruluyor...
where codex >nul 2>&1
if errorlevel 1 (
  call npm install -g @openai/codex >> logs\kurulum.log 2>&1
  if errorlevel 1 (
    echo         Kurulamadi - ChatGPT motoru olmadan da calisir ^(Gemini^).
    echo         Sonra elle denemek icin: npm install -g @openai/codex
  ) else (
    echo         Kuruldu.
  )
) else (
  echo         Zaten kurulu.
)

rem ------------------------------------------------- 7. Gemini motoru
echo   [7/7] Gemini motoru ^(kopru + watermark^) kuruluyor...
if exist tools\gemini-api-server.exe (
  echo         Zaten kurulu.
) else (
  call scripts\motorlari-kur.cmd
)

rem Masaustune kisayol (PowerShell ile .lnk)
powershell -NoProfile -Command "$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'VOKU.lnk')); $s.TargetPath=$env:HEDEF + '\VOKU.cmd'; $s.WorkingDirectory=$env:HEDEF; $s.Save()" >nul 2>&1

popd

cls
echo.
echo   Kurulum tamam.
echo   --------------------------------------------------
echo   Kurulan yer: %HEDEF%
echo   Masaustunde "VOKU" kisayolu olusturuldu.
echo.
echo   Yapilacaklar:
echo    1. Telegram botu kullanacaksan config\telegram.json icine
echo       BotFather'dan aldigin token'i yaz.
echo    2. config\prompts.json icine kendi prompt listeni koy.
echo    3. Panelde Oturumlar sekmesinden ChatGPT ve Gemini girislerini yap.
echo.
set "c="
set /p "c=  VOKU simdi acilsin mi? (e/h): "
if /i "%c%"=="e" start "" "%HEDEF%\VOKU.cmd"
exit /b 0
