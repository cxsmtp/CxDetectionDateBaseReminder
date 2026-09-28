#!/bin/bash
# Test script for CxDetectionDateBaseReminder
# Run this from the repo directory to run tests
# Loads .env from parent directory

set -e

PARENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PARENT_DIR/.env"

echo ""
echo "  ╔════════════════════════════════════════════════════════════╗"
echo "  ║                                                            ║"
echo "  ║      🧪 CxDetectionDateBaseReminder Test Script 🧪        ║"
echo "  ║                                                            ║"
echo "  ║   Running Tests • Install Dependencies • Start Server      ║"
echo "  ║                                                            ║"
echo "  ╚════════════════════════════════════════════════════════════╝"
echo ""

# Load .env from parent directory
if [ -f "$ENV_FILE" ]; then
    echo "Loading .env from parent directory"
    set -a
    source "$ENV_FILE"
    set +a
    echo ""
else
    echo "No .env file found in parent directory"
    echo ""
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
    echo ""
fi

# Run tests
echo "Running tests..."
npm test
echo ""

# Start the server
echo "Starting server..."
echo "Open your browser to: http://localhost:3000"
echo "Press Ctrl+C to stop the server"
echo ""
npm start
