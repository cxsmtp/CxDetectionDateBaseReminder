#!/bin/bash
# Development script for CxDetectionDateBaseReminder
# Run this to quickly start the application for local testing

set -e

echo "🚀 CxDetectionDateBaseReminder - Development Mode"
echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
    echo ""
fi

# Run tests first
echo "✅ Running tests..."
npm test
echo ""

# Start the server
echo "🌐 Starting server..."
echo "📍 Open your browser to: http://localhost:3000"
echo "⏹️  Press Ctrl+C to stop the server"
echo ""
npm start
