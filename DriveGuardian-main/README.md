# DriveGuardian 🛡️

DriveGuardian is a privacy-first desktop application for intelligent drive storage analysis, file scoring, duplicate detection, and space optimization. Built with a **Tauri (Rust + React/Vite)** frontend and powered by a standalone **Python CLI sidecar engine**, it runs entirely offline on your local machine.

---

## 🚀 Features

* **Storage Dashboard:** Visualizes drive capacity, folder distributions, and scan metrics in real time.
* **Smart Scanning & File Scoring:** Evaluates file metrics, detects duplicate content, and ranks files to simplify cleanup.
* **AI Natural Language Queries:** Integrated local AI interpreter to query files and storage patterns using simple prompts.
* **100% Local & Offline:** Local SQLite database management ensures your file metadata never leaves your machine.
* **Zero-Dependency Distribution:** The Python backend is compiled into a standalone executable sidecar binary—no Python installation required on client systems.

---

## 🏗️ Project Structure

```
DriveGuardian/
├── apps/
│   └── desktop/               # Tauri + React/Vite Desktop Frontend
│       ├── src/               # React UI components & app logic
│       ├── src-tauri/         # Rust backend, Tauri configuration, & sidecar binaries
│       └── package.json
├── core/                      # Python Processing Engine
│   ├── ai/                    # Natural language query interpretation
│   ├── database/              # SQLite database management
│   ├── scanner/               # File scanning, duplicate detection & scoring
│   ├── cli.py                 # Core CLI entry point
│   └── driveguardian_cli.spec # PyInstaller specification file
├── .github/
│   └── workflows/
│       └── release.yml        # CI/CD pipeline for release builds
├── build_sidecar.bat          # Batch script to bundle Python engine into executable
└── README.md
```

---

## 🛠️ Prerequisites

* [Node.js](https://nodejs.org/) (v20+)
* [Python](https://www.python.org/) (v3.10+)
* [Rust Toolchain](https://www.rust-lang.org/tools/install) (`stable-x86_64-pc-windows-msvc`)
* PyInstaller (`pip install pyinstaller`)

---

## ⚙️ Development & Build Guide

### 1. Build the Python Sidecar
Run the build script from the root directory to generate the standalone sidecar executable for Tauri:

```powershell
.\build_sidecar.bat
```

*This compiles `driveguardian-cli.exe` using PyInstaller and places the target-triple binary directly into `apps/desktop/src-tauri/binaries/`.*

### 2. Run Desktop App Locally
Launch the application in development mode:

```powershell
cd apps/desktop
npm install
npm run tauri dev
```

### 3. Package Production Installers (`.msi` / `.exe`)
Compile the release installer packages:

```powershell
cd apps/desktop
npm run tauri build
```

Generated installer bundles will be located in:
`apps/desktop/src-tauri/target/release/bundle/`

---

## 📦 Automated Release Pipeline

DriveGuardian includes an automated GitHub Actions workflow (`.github/workflows/release.yml`). Pushing a version tag triggers a Windows build runner that packages the sidecar executable, compiles the Tauri app, and publishes draft `.msi` and `.exe` installers to GitHub Releases.

```powershell
git tag v0.1.0
git push origin v0.1.0
```

---

## 📄 License

This project is licensed under the MIT License - see the `LICENSE` file for details.