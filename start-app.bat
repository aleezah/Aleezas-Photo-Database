@echo off
cd /d "C:\Users\aleez\Desktop\Developer\Aleezas projects\film-db"
set SITE_URL=https://alzfilm.ca
:restart
echo Starting Film DB app...
node app.js
echo.
echo App stopped or crashed. Restarting in 3 seconds...
timeout /t 3 >nul
goto restart
