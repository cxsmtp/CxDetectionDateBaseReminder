#!/bin/bash
# Test automation script for CxDetectionDateBaseReminder
# Run this script to clone, install, and test the application

set -e

REPO_URL="https://github.com/cxsmtp/CxDetectionDateBaseReminder.git"
TEST_DIR="CxDetectionDateBaseReminder_test_$(date +%s)"
PARENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "🧪 Starting test automation..."
echo "📁 Test directory: $PARENT_DIR/$TEST_DIR"

# Clone the repository
echo ""
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
