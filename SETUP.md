# Setup Guide - CxDetectionDateBaseReminder

Complete guide for setting up and running the application with standalone scripts.

## 🎯 Quick Setup (Recommended)

### 1️⃣ Create Your Configuration File

In your **parent directory** (NOT in the repo), create a `.env` file:

```bash
# Linux/Mac terminal
cat > .env << 'EOF'
CX_API_KEY=your_checkmarx_api_key_here
PORT=3000
EOF
```

**Windows** - Create a text file named `.env` with:
```
CX_API_KEY=your_checkmarx_api_key_here
PORT=3000
```

### 2️⃣ Download Standalone Scripts

Download these 4 files to your **parent directory**:
- ✅ `test-standalone.sh` (Linux/Mac - full test with auto-clone)
- ✅ `test-standalone.bat` (Windows - full test with auto-clone)  
- ✅ `dev-standalone.sh` (Linux/Mac - quick dev)
- ✅ `dev-standalone.bat` (Windows - quick dev)
- 📋 `STANDALONE-SETUP.md` (detailed guide)

### 3️⃣ Run the Script

**Linux/Mac:**
```bash
chmod +x test-standalone.sh
./test-standalone.sh
```

**Windows:**
```cmd
test-standalone.bat
```

✨ **Done!** The script handles everything:
- Clones the repository
- Installs dependencies  
- Runs tests
- Starts the server at http://localhost:3000
- Auto-cleans up when you're done

---

## 📝 Environment Configuration (.env)

### What is .env?

A `.env` file stores your sensitive configuration (API keys, passwords) so you don't have to type them every time or commit them to git.

### How to Create It

Place this in your **parent directory** (where your scripts are):

```env
# REQUIRED: Your Checkmarx API Key
# Get from: Checkmarx One > Settings > API Security > API Keys
CX_API_KEY=your_api_key_here

# OPTIONAL: Server settings
PORT=3000
SESSION_IDLE_MINUTES=480

# OPTIONAL: For Checkmarx on-premises or specific instances
# CX_BASE_URL=https://your-instance.checkmarx.net
# CX_IAM_URL=https://your-instance-iam.checkmarx.net  
# CX_TENANT=your-tenant-name
```

### 🔐 Security

- Your `.env` file is **never** sent to GitHub
- It stays **local** on your machine
- It's **safe** to store sensitive keys
- The `.gitignore` automatically excludes it

---

## 🔑 Getting Your Checkmarx API Key

1. **Log in** to Checkmarx One
2. Click **Settings** (⚙️ gear icon, top right)
3. Select **API Security** from the left menu
4. Click **API Keys**
5. Create a new key or copy an existing one
6. Paste it into your `.env` file

---

## 📂 Directory Structure After Setup

```
your-workspace/
├── .env                          ← Your API key (created once)
├── test-standalone.sh/.bat       ← Full test script
├── dev-standalone.sh/.bat        ← Quick dev script
├── STANDALONE-SETUP.md           ← Detailed guide
└── CxDetectionDateBaseReminder/  ← Repository (auto-cloned by test script)
    ├── .env                      ← Script copies your .env here
    ├── package.json
    ├── src/
    ├── public/
    └── ...
```

---

## 🚀 Two Workflow Options

### Option A: Full Test (Recommended First Time)

**When to use:** Fresh test, isolated environment, or new machine

```bash
./test-standalone.sh      # Linux/Mac
test-standalone.bat       # Windows
```

**What happens:**
- Creates temporary directory
- Clones repository
- Installs dependencies
- Runs all tests
- Starts the server
- **Auto-cleans up** after you stop (Ctrl+C)

**Time:** ~3-5 minutes  
**Cleanup:** Automatic

### Option B: Quick Development (After Initial Setup)

**When to use:** Iterating on code, faster rebuilds

```bash
./dev-standalone.sh       # Linux/Mac
dev-standalone.bat        # Windows
```

**Prerequisites:**
```bash
# First time only - clone the repo
git clone https://github.com/cxsmtp/CxDetectionDateBaseReminder.git
```

**What happens:**
- Uses existing repository
- Installs dependencies if needed
- Runs tests
- Starts the server
- **Keeps node_modules** for faster rebuilds

**Time:** ~1-2 minutes  
**Cleanup:** Manual (you keep the clone)

---

## 🎯 Testing the New Features

After the server starts at http://localhost:3000:

### Per-Initiator HTML Reports

The new feature sends individual HTML reports to each developer:

1. **Connect:** Enter your Checkmarx API key
2. **Fetch:** Click "Fetch Projects" and wait for data
3. **Select:** Choose projects or findings
4. **Send:** Select "HTML Report (Per Developer)"
5. **Results:** Each person gets their own personalized email

**What changed:**
- ✅ Emails grouped by developer instead of consolidated list
- ✅ Each person only sees their findings
- ✅ Personalized greeting in each email
- ✅ Status shows who received reports

---

## 🔧 Customization

### Change Server Port

Edit your `.env`:
```env
PORT=3001
```

### Use Checkmarx On-Premises

Edit your `.env`:
```env
CX_BASE_URL=https://your-instance.checkmarx.net
CX_IAM_URL=https://your-instance-iam.checkmarx.net
CX_TENANT=your-tenant-name
```

### Use AI-Powered Risk Insights

Edit your `.env`:
```env
CX_RISKS_PATH=/api/risks/ai-insights
```

For all options, see `.env.example` in the repository.

---

## 🐛 Troubleshooting

### "npm not found"
**Solution:** Install Node.js from https://nodejs.org/ (v18+ recommended)

### "git not found"  
**Solution:** Install Git from https://git-scm.com/

### Scripts won't run (Linux/Mac)
**Solution:** Make them executable
```bash
chmod +x *.sh
```

### Port 3000 already in use
**Solution:** Change port in `.env`
```env
PORT=3001
```

### ".env not found" error
**Solution:** Create `.env` in **parent directory** (not in repo)

### Tests fail
**Solution:** Check Node.js version
```bash
node --version  # Should be v18+
npm --version   # Should be v9+
```

---

## 📚 More Information

- **TESTING.md** - Testing and test scripts guide
- **STANDALONE-SETUP.md** - Detailed standalone setup guide  
- **README.md** - Project overview
- **.env.example** - All available environment variables

---

## ✅ Next Steps

1. ✅ Create `.env` file in parent directory
2. ✅ Download standalone scripts to same directory
3. ✅ Run `./test-standalone.sh` (or `.bat` on Windows)
4. ✅ Open http://localhost:3000 when server starts
5. ✅ Test the application

**You're all set!** 🎉

---

## 📧 For Help

Check the detailed guides:
- `STANDALONE-SETUP.md` - Complete setup walkthrough
- `TESTING.md` - Testing procedures
- `.env.example` - Configuration options

Or review the troubleshooting section above.
