# PyInstaller spec for DriveGuardian's backend CLI.
# Run via: pyinstaller --clean core/driveguardian_cli.spec
# (see core/BUILD_SIDECAR.md for full instructions — this must be run
#  on Windows to produce a Windows executable.)

import sys
from pathlib import Path

block_cipher = None
repo_root = Path(SPECPATH).resolve().parent  # this file lives in core/, so parent = repo root

a = Analysis(
    ['cli.py'],
    pathex=['core'],
    binaries=[],
    datas=[
        (str(repo_root / 'database' / 'schema.sql'), 'database'),
    ],
    hiddenimports=[
        'core.database.db',
        'core.scanner.scanner',
        'core.scanner.duplicate_finder',
        'core.scanner.scoring',
        'core.scanner.operations',
        'core.scanner.categorizer',
        'core.ai.query_interpreter',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    # Tauri sidecar binaries must be named <name>-<target-triple>.exe on
    # Windows. This gets renamed to the correct triple in the build script
    # rather than hardcoded here, since the triple depends on the build
    # machine's architecture.
    name='driveguardian-cli',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,  # keep a console subsystem so stdout/stderr piping (our whole IPC mechanism) works correctly
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
