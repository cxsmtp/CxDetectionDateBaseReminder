@echo off
REM Development script for CxDetectionDateBaseReminder
REM Run this to quickly start the application for local testing

cls
echo 🚀 CxDetectionDateBaseReminder - Development Mode
echo.

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
