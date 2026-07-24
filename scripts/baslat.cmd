@echo off
rem Paneli (ve Telegram botunu) penceresiz baslatir.
rem Gorev Zamanlayici bu dosyayi cagirir - komut satirini dogrudan gorev
rem tanimina gomsek ic ice tirnaklar bozuluyor.
cd /d "%~dp0.."
set "VPORT=4173"
if not "%VOKU_PORT%"=="" set "VPORT=%VOKU_PORT%"
set "PATH=%PATH%;%ProgramFiles%\nodejs;%LOCALAPPDATA%\Programs\nodejs;%ProgramFiles%\Git\cmd"
if not exist logs mkdir logs

rem Otomatik guncelleme aciksa once yeni surumu cek.
if exist config\guncelleme.json (
  findstr /c:"\"otomatik\": true" config\guncelleme.json >nul 2>&1
  if not errorlevel 1 node src\cli.js guncelle >> logs\guncelleme.log 2>&1
)

node src\cli.js panel --port %VPORT% >> logs\panel.out 2>&1
