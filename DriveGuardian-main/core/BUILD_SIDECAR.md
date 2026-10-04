# Building the bundled backend (for the installer)

This step packages the Python backend into one standalone .exe so the
final DriveGuardian installer works on machines with no Python installed
at all. **Dev mode (`npm run tauri dev`) doesn't need any of this** — it
keeps using your system Python directly, unchanged, for fast iteration.

You only need to do this once before building the real installer
(`npm run tauri build`), and again any time the Python backend changes.

## Steps (run on Windows, from the repo root — `D:\DriveGuardian`)

1. Make sure PyInstaller can install:
   ```
   python --version
   ```
   (any Python 3.10+ works — this is only used to build the .exe, the
   end user installing DriveGuardian later won't need Python at all)

2. Run the build script:
   ```
   build_sidecar.bat
   ```
   This installs PyInstaller if needed, builds `driveguardian-cli.exe`,
   detects your Rust target triple, and copies the binary into
   `apps\desktop\src-tauri\binaries\` with the correct filename Tauri
   expects (e.g. `driveguardian-cli-x86_64-pc-windows-msvc.exe`).

3. Confirm the file exists:
   ```
   dir apps\desktop\src-tauri\binaries
   ```

4. Now build the real installer:
   ```
   cd apps\desktop
   npm run tauri build
   ```
   This produces both an `.msi` and an `.exe` (NSIS) installer under
   `apps\desktop\src-tauri\target\release\bundle\`.

## Sanity-checking the bundled exe directly (optional but recommended)

Before trusting it inside the full installer, you can run the sidecar
executable directly to confirm it works standalone:

```
apps\desktop\src-tauri\binaries\driveguardian-cli-<your-triple>.exe dashboard --drive D:\
```

If that prints JSON (even an empty result), the bundling worked. If it
errors, the problem is in the PyInstaller build, not in Tauri or Rust —
paste the exact error and it can be diagnosed precisely.

## Re-building after Python changes

Any time you or I change a file under `core/`, re-run `build_sidecar.bat`
before your next `npm run tauri build`. Dev mode (`npm run tauri dev`)
never needs this — only the packaged installer does.
