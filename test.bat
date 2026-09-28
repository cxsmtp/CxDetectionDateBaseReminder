@echo off
REM Test automation script for CxDetectionDateBaseReminder
REM Run this script to clone, install, and test the application

setlocal enabledelayedexpansion

set REPO_URL=https://github.com/cxsmtp/CxDetectionDateBaseReminder.git
for /f "tokens=2-4 delims=/ " %%a in ('date /t') do (set mydate=%%c%%a%%b)
for /f "tokens=1-2 delims=/:" %%a in ('time /t') do (set mytime=%%a%%b)
set TEST_DIR=CxDetectionDateBaseReminder_test_%mydate%_%mytime%

echo.
echo 🧪 Starting test automation...
echo 📁 Test directory: %cd%\%TEST_DIR%
echo.

REM Clone the repository
echo 📥 Cloning repository...
git clone %REPO_URL% %TEST_DIR%
if errorlevel 1 (
    echo ❌ Clone failed!
    exit /b 1
)
cd /d %TEST_DIR%

REM Install dependencies
echo.
echo 📦 Installing dependencies...
call npm install
if errorlevel 1 (
    echo ❌ npm install failed!
    cd ..
    exit /b 1
)

REM Run tests
echo.
echo ✅ Running tests...
call npm test
if errorlevel 1 (
    echo ⚠️ Tests completed with warnings/errors
)

REM Start the server
echo.
echo 🚀 Starting server (press Ctrl+C to stop)...
call npm start

REM Cleanup after user stops the server
echo.
echo 🧹 Cleaning up...
cd ..
rmdir /s /q %TEST_DIR%
if errorlevel 1 (
    echo ⚠️ Could not automatically delete test directory
    echo 📁 Please manually delete: %cd%\%TEST_DIR%
) else (
    echo ✨ Test complete! Test directory has been removed.
)
echo.
pause
