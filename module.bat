@echo off
echo ====================================================
echo   Shield Software - Dependency Installer
echo ====================================================
echo.
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed! Node.js 22.12 or newer is required.
    pause
    exit /b 1
)
echo Installing project dependencies from package-lock.json...
call npm ci
if %errorlevel% neq 0 (
    echo [ERROR] Dependency installation failed.
    pause
    exit /b 1
)
echo.
echo ====================================================
echo   Installation completed successfully!
echo   Copy .env.example to .env, fill it in, then run 'npm start'.
echo ====================================================
pause
