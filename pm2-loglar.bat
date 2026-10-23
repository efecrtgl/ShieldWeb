@echo off
set "PATH=%PATH%;C:\Program Files\nodejs;C:\Program Files (x86)\nodejs;%AppData%\npm"
title Shield Software PM2 Live Stream Logs
color 0B
cls

echo =======================================================================
echo    📊 Shield Software PM2 CANLI STREAM LOG IZLEYICI
echo =======================================================================
echo.
echo PM2 canlı log akışı başlatılıyor (Çıkış yapmak için Ctrl+C tuşlayın)...
echo.

call .\node_modules\.bin\pm2.cmd logs
