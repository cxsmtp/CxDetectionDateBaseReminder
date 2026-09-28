#!/bin/bash
# Test automation script for CxDetectionDateBaseReminder
# Run this script to clone, install, and test the application
# Loads .env from parent directory

set -e

REPO_URL="https://github.com/cxsmtp/CxDetectionDateBaseReminder.git"
TEST_DIR="CxDetectionDateBaseReminder_test_$(date +%s)"
PARENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PARENT_DIR/.env"

echo "🧪 Starting test automation..."
echo "📁 Test directory: $PARENT_DIR/$TEST_DIR"
echo ""

# Load .env from parent directory
if [ -f "$ENV_FILE" ]; then
    echo "📝 Loading .env from parent directory"
    set -a
    source "$ENV_FILE"
    set +a
else
    echo "ℹ️  No .env file found in parent directory"
fi
echo ""

# Clone the repository
echo "📥 Cloning repository..."
cd "$PARENT_DIR"
git clone "$REPO_URL" "$TEST_DIR"
cd "$TEST_DIR"

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm install

# Run tests
echo ""
echo "✅ Running tests..."
npm test

# Start the server
echo ""
echo "🚀 Starting server (press Ctrl+C to stop)..."
npm start

# Cleanup after user stops the server
echo ""
echo "🧹 Cleaning up..."
cd "$PARENT_DIR"
rm -rf "$TEST_DIR"
echo "✨ Test complete! Test directory has been removed."
