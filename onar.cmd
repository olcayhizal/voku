@echo off
setlocal
chcp 65001 >nul
title VOKU - Onarim

rem  Tek seferlik onarim: config dosyalari eskiden git-takipliydi ve panel
rem  onlari degistirince guncelleme "kirli agac" diye takiliyordu. Bu dosya
rem  onlari takipten cikarir (icerik + hesaplarin KORUNUR), guncellemeyi acar.

cd /d "%~dp0"
set "PATH=%PATH%;%ProgramFiles%\Git\cmd;%LOCALAPPDATA%\Programs\Git\cmd"

where git >nul 2>&1
if errorlevel 1 (
  echo   Git bulunamadi. install.cmd calistir.
  pause
  exit /b 1
)

echo.
echo   VOKU onarim — config dosyalari takipten cikariliyor
echo   ^(hesap tanimlarin ve ayarlarin KORUNUR^)
echo.

for %%F in (config\settings.json config\prompts.json config\telegram.json) do (
  git ls-files --error-unmatch %%F >nul 2>&1
  if not errorlevel 1 (
    git rm --cached -q %%F
    echo    - %%F takipten cikarildi
  )
)

rem Bu dosyalar zaten .gitignore'da (guncel surumde). Emniyet icin ekle.
findstr /x /c:"config/settings.json" .gitignore >nul 2>&1 || echo config/settings.json>> .gitignore

echo.
echo   Tamam. Simdi VOKU'yu ac ve 6 ^(Guncelle^) de — artik takilmayacak.
echo.
pause
