@echo off
REM DriveGuardian - builds the Python backend into a single .exe and places
REM it where Tauri expects "sidecar" binaries (src-tauri/binaries/), with
REM the required target-triple suffix in the filename.
REM
REM Run this from the REPO ROOT (the DriveGuardian folder), not from core/.
REM Must run on Windows - PyInstaller builds a native executable for
REM whatever OS it runs on; it cannot cross-compile a Windows .exe from Linux.

echo Installing PyInstaller (one-time)...
pip install pyinstaller --quiet

echo.
echo Building driveguardian-cli.exe (this can take a minute)...
pyinstaller --clean --noconfirm core\driveguardian_cli.spec

if not exist "dist\driveguardian-cli.exe" (
    echo.
    echo BUILD FAILED - dist\driveguardian-cli.exe was not created.
    echo Check the output above for errors.
    exit /b 1
)

echo.
echo Detecting target triple...
for /f "delims=" %%i in ('rustc -Vv ^| findstr "host:"') do set RUSTC_HOST_LINE=%%i
set TARGET_TRIPLE=%RUSTC_HOST_LINE:host: =%

echo Target triple: %TARGET_TRIPLE%

if not exist "apps\desktop\src-tauri\binaries" mkdir "apps\desktop\src-tauri\binaries"

copy /Y "dist\driveguardian-cli.exe" "apps\desktop\src-tauri\binaries\driveguardian-cli-%TARGET_TRIPLE%.exe"

echo.
echo Done. Sidecar binary placed at:
echo   apps\desktop\src-tauri\binaries\driveguardian-cli-%TARGET_TRIPLE%.exe
echo.
echo You can now run "npm run tauri build" from apps\desktop to produce the installer.
