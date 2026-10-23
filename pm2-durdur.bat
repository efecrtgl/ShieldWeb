@echo off
set "PATH=%PATH%;C:\Program Files\nodejs;C:\Program Files (x86)\nodejs;%AppData%\npm"
title Shield Software PM2 Process Stopper
color 0C
cls

echo =======================================================================
echo    🛑 Shield Software PM2 PROCESS STOPPER
echo =======================================================================
echo.
echo PM2 altindaki tum servisler (Ana Sunucu + 5 Discord Botu) durduruluyor...
echo.

call .\node_modules\.bin\pm2.cmd stop all

echo.
echo =======================================================================
echo  ✅ Tum PM2 servisleri durduruldu.
echo =======================================================================
echo.
pause
