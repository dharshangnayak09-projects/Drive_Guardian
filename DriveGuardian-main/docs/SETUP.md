# DriveGuardian — Setup Guide (Windows + VS Code)

This gets Phase 1 (drive scan + dashboard) running from a clean machine.

## 1. Install prerequisites

### Rust
1. Download and run **rustup-init.exe** from https://rustup.rs
2. Accept the default installation (stable toolchain).
3. Restart your terminal, then verify:
   ```
   rustc --version
   cargo --version
   ```

### Node.js
1. Install Node.js LTS (20.x) from https://nodejs.org
2. Verify:
   ```
   node --version
   npm --version
   ```

### Tauri CLI
```
npm install -g @tauri-apps/cli
```

### WebView2 Runtime
Windows 10/11 usually ships with this already. If `npx tauri dev` complains it's
missing, install the Evergreen Bootstrapper from:
https://developer.microsoft.com/microsoft-edge/webview2/

### Python
1. Install Python 3.11+ from https://python.org (check "Add to PATH" during install).
2. Verify:
   ```
   python --version
   ```
3. From the repo root:
   ```
   cd core
   python -m venv .venv
   .venv\Scripts\activate
   pip install -r requirements.txt
   ```
   (Phase 1 scanner only needs the standard library — the venv matters more
   starting Phase 2 when NumPy/Pandas/scikit-learn come in.)

### VS Code extensions
Open the repo folder in VS Code — it will prompt you to install the
recommended extensions (`.vscode/extensions.json`): Tauri, rust-analyzer,
Python, and a SQLite viewer so you can inspect `driveguardian.db` directly.

## 2. Install frontend dependencies

```
cd apps/desktop
npm install
```

## 3. Run in dev mode

From `apps/desktop`:
```
npm run tauri dev
```

This starts Vite (React) on `localhost:1420` and launches the Tauri window.
First launch downloads Rust dependencies — can take a few minutes.

## 4. Verify Phase 1 works

1. The app window opens and lists your drives (C:, D:, etc.) with free space.
2. Click **Scan Drive** on a drive. First scans of C: can take a while
   depending on file count — this is expected (staged hashing keeps it
   from being as slow as it could be, but Phase 1 has no incremental scan
   yet, so every scan is a full walk).
3. After the scan completes, the Storage Breakdown pie chart and Largest
   Files table populate.
4. Check `%USERPROFILE%\.driveguardian\driveguardian.db` exists — that's
   your local SQLite database. Open it with the SQLite VS Code extension
   to inspect the `files` and `scan_jobs` tables directly.

## 5. Common issues

- **`scan_drive` fails immediately**: the Rust command currently shells out
  to `python` on PATH using a relative path to `core/scanner/scanner.py`.
  If you get a "file not found," confirm you're running `npm run tauri dev`
  from `apps/desktop` (so the relative path resolves) and that `python`
  (not `python3`) is on PATH — on Windows this is usually already the case
  after installing from python.org.
- **Permission errors during scan**: expected for some system folders —
  Phase 1 logs and skips them (`errors_count` in the scan summary) rather
  than crashing. Protected system paths are pruned before traversal.
- **First scan of C: is slow**: normal for Phase 1 (full walk every time,
  metadata-only, staged partial-hash only touches first 64KB). Incremental
  scanning and full hashing for duplicate candidates land in Phase 2.

## Next steps

Once this is running cleanly, Phase 2 (spec section 24) adds usage
tracking, classification, temporal fingerprints, and the duplicate engine.
Come back and we'll build that layer next.
