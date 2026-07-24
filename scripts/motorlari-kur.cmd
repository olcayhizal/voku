@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title VOKU - Motor kurulumu

rem  Gemini kopru servisi + watermark temizleyici kurulumu (Windows).
rem
rem  Bunlar ucuncu taraf projeler oldugu icin voku deposunda tasinmaz
rem  (tools/ klasoru .gitignore'da); her makinede kaynagindan kurulur.
rem  Bu dosya cift tiklanabilir - install.cmd de sonunda bunu cagirir.

cd /d "%~dp0.."
set "KOK=%CD%"
set "PATH=%PATH%;%ProgramFiles%\Git\cmd;%ProgramFiles%\nodejs;%ProgramFiles%\Go\bin;%LOCALAPPDATA%\Programs\Go\bin;%USERPROFILE%\go\bin;%LOCALAPPDATA%\Microsoft\WinGet\Links"
if not exist logs mkdir logs
if not exist tools mkdir tools

cls
echo.
echo   VOKU - motor kurulumu
echo   --------------------------------------------------
echo   Gemini kopru servisi ve watermark temizleyici kurulur.
echo   ChatGPT motoru ^(Codex^) bundan bagimsiz calisir.
echo.

rem ------------------------------------------------------------- Git
where git >nul 2>&1
if errorlevel 1 (
  echo   Git kurulu degil. Once install.cmd calistir.
  pause
  exit /b 1
)

rem -------------------------------------------------------------- Go
echo   [1/4] Go kontrol ediliyor...
where go >nul 2>&1
if errorlevel 1 (
  echo         Go kurulu degil, kuruluyor...
  where winget >nul 2>&1
  if errorlevel 1 (
    echo.
    echo   winget yok. Go'yu elle kur: https://go.dev/dl/
    echo   Sonra bu dosyayi tekrar calistir.
    pause
    exit /b 1
  )
  winget install --id GoLang.Go -e --accept-source-agreements --accept-package-agreements
  set "PATH=%PATH%;%ProgramFiles%\Go\bin"
  where go >nul 2>&1
  if errorlevel 1 (
    echo.
    echo   Go kuruldu ama bu pencere onu henuz gormuyor.
    echo   Bu pencereyi kapat, dosyayi tekrar calistir.
    pause
    exit /b 1
  )
) else (
  for /f "tokens=3" %%V in ('go version') do echo         Go kurulu ^(%%V^).
)

rem --------------------------------------------------- Gemini koprusu
echo   [2/4] Gemini koprusu indiriliyor...
if exist tools\gemini-web-to-api\.git (
  echo         Zaten var.
) else (
  git clone --depth 1 https://github.com/ntthanh2603/gemini-web-to-api tools\gemini-web-to-api >> logs\motor-kurulum.log 2>&1
  if errorlevel 1 (
    echo   Indirilemedi. Ayrinti: logs\motor-kurulum.log
    pause
    exit /b 1
  )
)

echo   [3/4] Yerel yama uygulaniyor ve derleniyor...
pushd tools\gemini-web-to-api
rem Yama olmadan kopru gorseli indirmiyor (lh3 URL'leri oturum bagimli, 403).
git apply --check "%KOK%\patches\gemini-web-to-api.voku.patch" >nul 2>&1
if not errorlevel 1 (
  git apply "%KOK%\patches\gemini-web-to-api.voku.patch"
  echo         Yama uygulandi.
) else (
  echo         Yama zaten uygulanmis ^(ya da kaynak degismis^).
)

go build -o ..\gemini-api-server.exe .\cmd\server >> "%KOK%\logs\motor-kurulum.log" 2>&1
if errorlevel 1 (
  echo   Derlenemedi. Ayrinti: logs\motor-kurulum.log
  popd
  pause
  exit /b 1
)
popd
echo         Derlendi: tools\gemini-api-server.exe

rem ------------------------------------------- watermark temizleyici
echo   [4/4] Watermark temizleyici indiriliyor...
if exist tools\gwr\.git (
  echo         Zaten var.
) else (
  git clone --depth 1 https://github.com/GargantuaX/gemini-watermark-remover tools\gwr >> logs\motor-kurulum.log 2>&1
  if errorlevel 1 (
    echo         Indirilemedi - Gemini yine calisir, gorsellerde logo kalir.
  )
)

cls
echo.
echo   Motor kurulumu tamam.
echo   --------------------------------------------------
echo   Sirada: VOKU panelinde Oturumlar sekmesinden Gemini girisi yap.
echo   ^(Google hesabina tarayicida giris yapilir, cerezler kopruye yazilir^)
echo.
pause
exit /b 0
