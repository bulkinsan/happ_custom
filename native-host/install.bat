@echo off
setlocal enabledelayexpansion

set HOST_NAME=happ_vpn_proxy
set HOST_DIR=%~dp0

pushd "%HOST_DIR%"
set HOST_DIR=%CD%
popd

REM Find node.exe
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo ERROR: Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('where node') do (
    set NODE_PATH=%%i
    goto :found
)
:found
echo Node.js: %NODE_PATH%

REM Write manifest JSON with correct paths
echo Creating manifest...
(
    echo {
    echo   "name": "%HOST_NAME%",
    echo   "description": "Happ VPN local proxy",
    echo   "path": "%HOST_DIR%%HOST_NAME%.bat",
    echo   "type": "stdio",
    echo   "allowed_origins": []
    echo }
) > "%HOST_DIR%%HOST_NAME%.json"

REM Register in Windows Registry
echo Registering native host...
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%HOST_DIR%%HOST_NAME%.json" /f >nul 2>&1

if %ERRORLEVEL% neq 0 (
    echo Failed to register. Try running as administrator.
    pause
    exit /b 1
)

REM Copy daemon.js to deployment dir
if not exist "%HOST_DIR%daemon.js" (
    echo daemon.js not found in %HOST_DIR%
    pause
    exit /b 1
)

REM Install ws dependency
if not exist "%HOST_DIR%node_modules" (
    echo Installing dependencies...
    cd /d "%HOST_DIR%"
    npm install
)

echo.
echo ====================================
echo  Native host installed successfully!
echo ====================================
echo.
echo Now load extension in chrome://extensions:
echo 1. Enable Developer Mode
echo 2. Click "Load unpacked"
echo 3. Select the happ_castom_v1 folder
echo 4. Copy Extension ID and update allowed_origins in %HOST_NAME%.json
echo.
pause
