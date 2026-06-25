@echo off
cd /d "%~dp0"

:: ── Start Docker Desktop if not running ───────────────────────────────────────
docker version >nul 2>&1
if errorlevel 1 (
    echo Starting Docker Desktop...
    start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    echo Waiting for Docker to be ready...
    :waitdocker
    timeout /t 4 /nobreak >nul
    docker version >nul 2>&1
    if errorlevel 1 goto waitdocker
    echo Docker is ready.
    :: Give Docker a moment to fully initialise before starting containers
    timeout /t 5 /nobreak >nul
)

:: ── Start Immich containers ───────────────────────────────────────────────────
docker compose -f "C:\immich\docker-compose.yml" up -d >nul 2>&1
echo Immich started.

:: ── Check Node.js ─────────────────────────────────────────────────────────────
node --version >nul 2>&1
if errorlevel 1 (
    echo Node.js not found. Install from https://nodejs.org
    pause & exit /b 1
)

if not exist node_modules (
    echo Installing dependencies...
    npm install
)

if not exist film.db (
    echo Building database for the first time ^(this may take a minute^)...
    node scanner.js
) else (
    echo Database found. To rescan, delete film.db and re-run.
)

echo.
echo Opening Film Archive at http://localhost:5000
start http://localhost:5000
node app.js
