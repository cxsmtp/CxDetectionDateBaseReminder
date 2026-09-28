# Testing Guide for CxDetectionDateBaseReminder

This document describes the automated scripts for testing and developing the application.

## Quick Start (Local Development)

### Linux/Mac
```bash
chmod +x dev.sh
./dev.sh
```

### Windows
```cmd
dev.bat
```

This will:
1. ✅ Install dependencies (if needed)
2. ✅ Run all tests
3. 🌐 Start the development server
4. 📍 Open http://localhost:3000 in your browser

**To stop**: Press `Ctrl+C`

---

## Full Test Cycle (With Fresh Clone)

If you want to test the application as if you're a new user:

### Linux/Mac
```bash
chmod +x test.sh
./test.sh
```

### Windows
```cmd
test.bat
```

This will:
1. 📥 Clone the repository to a temporary directory
2. 📦 Install all dependencies
3. ✅ Run all tests
4. 🌐 Start the development server
5. 🧹 Automatically clean up after you stop the server

**Note**: When prompted with `Press Ctrl+C to stop the server`, press `Ctrl+C` and then `y` to confirm exit. The test directory will be automatically removed.

---

## What Each Script Does

### `dev.sh` / `dev.bat` (Recommended for Development)
- **Use this**: When working on the current branch
- **Time**: ~1-2 minutes
- **Cleanup**: None (keeps node_modules for faster rebuilds)
- **Browser**: Manual - open http://localhost:3000

### `test.sh` / `test.bat` (For Full Testing)
- **Use this**: Before pushing changes or for CI/CD testing
- **Time**: ~3-5 minutes
- **Cleanup**: Automatic (removes cloned directory)
- **Browser**: Same as dev scripts

---

## Manual Process (If Scripts Don't Work)

If you prefer to run commands manually:

```bash
# Clone and setup
git clone https://github.com/cxsmtp/CxDetectionDateBaseReminder.git
cd CxDetectionDateBaseReminder
npm install

# Run tests
npm test

# Start development server
npm start

# When done: Ctrl+C to stop, then cleanup
cd ..
rm -rf CxDetectionDateBaseReminder  # Linux/Mac
rmdir /s CxDetectionDateBaseReminder  # Windows
```

---

## Troubleshooting

### Scripts don't run (Linux/Mac)
```bash
chmod +x *.sh
```

### npm not found
Install Node.js from https://nodejs.org/

### Port 3000 already in use
Change the port:
```bash
PORT=3001 npm start
```

### Tests fail
Check node version:
```bash
node --version  # Should be v18+ or v20+
npm --version   # Should be v9+
```

---

## Environment Setup

### Required
- Node.js v18+ (v20 recommended)
- npm v9+
- git

### Optional (for full testing)
- GitHub account with repository access

---

## Git Workflow After Testing

After testing and everything works:

```bash
# Commit changes
git add .
git commit -m "Your message"

# Push to branch
git push origin claude/great-mccarthy-dce00h

# Create/update PR
# Visit: https://github.com/cxsmtp/CxDetectionDateBaseReminder/pulls
```

---

## Testing the New Features

To test the newly implemented per-initiator HTML report sending:

1. Run `dev.sh` or `dev.bat`
2. Connect with Checkmarx credentials
3. Fetch projects (wait for data to load)
4. Select "HTML Report (Per Developer)" from the Send options
5. Click "Send Report"
6. Each developer should receive their own HTML report email

---

For more information, see the main README.md
