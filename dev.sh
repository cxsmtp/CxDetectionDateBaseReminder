#!/bin/bash
# Development script for CxDetectionDateBaseReminder
# Run this to quickly start the application for local testing
# Loads .env from parent directory

set -e

PARENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PARENT_DIR/.env"

echo "🚀 CxDetectionDateBaseReminder - Development Mode"
echo ""

# Load .env from parent directory
if [ -f "$ENV_FILE" ]; then
    echo "📝 Loading .env from parent directory"
    set -a
    source "$ENV_FILE"
    set +a
    echo ""
else
    echo "ℹ️  No .env file found in parent directory"
    echo ""
fi

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
