@echo off
REM Test script for CxDetectionDateBaseReminder
REM Run this from the repo directory to run tests
REM Loads .env from parent directory

setlocal enabledelayedexpansion

set PARENT_DIR=%cd%\..
set ENV_FILE=%PARENT_DIR%\.env

cls
echo.
echo   ╔════════════════════════════════════════════════════════════╗
echo   ║                                                            ║
echo   ║      🧪 CxDetectionDateBaseReminder Test Script 🧪        ║
echo   ║                                                            ║
echo   ║   Running Tests • Install Dependencies • Start Server      ║
echo   ║                                                            ║
echo   ╚════════════════════════════════════════════════════════════╝
echo.

REM Load .env from parent directory
if exist "%ENV_FILE%" (
    echo Loading .env from parent directory
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
    echo No .env file found in parent directory
    echo.
)

REM Install dependencies if needed
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    echo.
)

REM Run tests
echo Running tests...
call npm test
echo.

REM Start the server
echo Starting server...
echo Open your browser to: http://localhost:3000
echo Press Ctrl+C to stop the server
echo.
call npm start
