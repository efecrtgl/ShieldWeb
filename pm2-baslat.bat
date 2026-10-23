@echo off
set "PATH=%PATH%;C:\Program Files\nodejs;C:\Program Files (x86)\nodejs;%AppData%\npm"
title Shield Software PM2 Orchestration Launcher
color 0A
cls

echo =======================================================================
echo    🚀 Shield Software MEGA-SERVICE & DISCORD BOTS - PM2 ORCHESTRATION LAUNCHER
echo =======================================================================
echo.
echo [1/3] Node.js ve PM2 Ortami Kontrol Ediliyor...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [HATA] Node.js yuklu degil! Lutfen Node.js kurun.
    pause
    exit /b 1
)

echo [2/3] Tum Servisler PM2 Ile Baslatiliyor (ecosystem.config.js)...
echo.

:: PM2 komutunu calistir (Global veya npx yardimiyla)
call .\node_modules\.bin\pm2.cmd start ecosystem.config.js

echo.
echo [3/3] PM2 Canli Surec Tablosu:
echo =======================================================================
call .\node_modules\.bin\pm2.cmd status
echo =======================================================================
echo.
echo  ✅ Tum servisler (Ana Web Sunucusu + 5 Discord Botu) basariyla baslatildi!
echo.
echo  Komutlar:
echo   - Loglari izlemek icin:  call .\node_modules\.bin\pm2.cmd logs
echo   - Durdurmak icin:        call .\node_modules\.bin\pm2.cmd stop all
echo   - Yeniden baslatmak icin: call .\node_modules\.bin\pm2.cmd restart all
echo =======================================================================
echo.
pause
