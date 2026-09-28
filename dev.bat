@echo off
REM Development script for CxDetectionDateBaseReminder
REM Run this to quickly start the application for local testing
REM Loads .env from parent directory

setlocal enabledelayedexpansion

set PARENT_DIR=%cd%
set ENV_FILE=%PARENT_DIR%\.env

cls
echo 🚀 CxDetectionDateBaseReminder - Development Mode
echo.

REM Load .env from parent directory
if exist "%ENV_FILE%" (
    echo 📝 Loading .env from parent directory
    for /f "usebackq tokens=* delims=" %%A in ("%ENV_FILE%") do (
        set "line=%%A"
        if not "!line!"=="" (
            if not "!line:~0,1!"=="#" (
                for /f "tokens=1,* delims==" %%x in ("!line!") do (
                    set "%%x=%%y"
                )
            )
        )
    )
    echo.
) else (
    echo ℹ️  No .env file found in parent directory
    echo.
)

REM Check if node_modules exists
if not exist "node_modules" (
    echo 📦 Installing dependencies...
    call npm install
    echo.
)

REM Run tests first
echo ✅ Running tests...
call npm test
echo.

REM Start the server
echo 🌐 Starting server...
echo 📍 Open your browser to: http://localhost:3000
echo ⏹️ Press Ctrl+C to stop the server
echo.
call npm start
