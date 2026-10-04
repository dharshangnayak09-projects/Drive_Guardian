"""
DriveGuardian - File Scanner (Phase 1)

Stages per spec section 6:
  drive discovery -> directory traversal -> metadata extraction ->
  database insertion/update -> candidate hashing (staged, deferred)

Phase 1 scope: metadata scan only. Partial/full hashing is wired but only
triggered for duplicate-size-candidates, kept minimal here and expanded
in Phase 2 (Duplicate Engine).
"""

import os
import sys
import hashlib
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

if not getattr(sys, "frozen", False):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # repo root, dev mode only
from core.database import db
from core.scanner.categorizer import categorize

# Directories we should never traverse into - protects system paths per
# spec section 15 (Safety Engine) even though Phase 1 is read-only.
PROTECTED_PREFIXES = [
    "windows", "program files", "program files (x86)", "programdata",
    "$recycle.bin", "system volume information",
]

# Build/dependency/cache folders: these generate huge numbers of files with
# near-identical sizes (compiled object files, package trees) which makes
# duplicate detection needlessly slow and the results useless — nobody
# wants DriveGuardian recommending they delete half of node_modules.
# Skipped by exact folder name match, wherever they appear.
EXCLUDED_DIR_NAMES = {
    "node_modules", "target", ".git", "__pycache__", ".venv", "venv",
    ".cache", "dist", "build", ".next", ".turbo", "vendor",
}

PARTIAL_HASH_BYTES = 1024 * 64  # first 64KB, staged hashing
FULL_HASH_CHUNK = 1024 * 1024   # 1MB streaming chunks for full-file hash


def full_hash(path: str) -> str | None:
    """Full-file SHA-256. Only called for partial-hash collision candidates
    (Phase 2 duplicate engine), never during the base metadata scan —
    hashing every file on a 500GB drive up front would make scans far
    slower for no benefit until we know which files are even candidates."""
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            while chunk := f.read(FULL_HASH_CHUNK):
                h.update(chunk)
        return h.hexdigest()
    except (OSError, PermissionError):
        return None


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def is_protected_path(path: str) -> bool:
    lower = path.lower()
    return any(f"{os.sep}{p}{os.sep}" in f"{os.sep}{lower}{os.sep}" or lower.startswith(p)
               for p in PROTECTED_PREFIXES)


def partial_hash(path: str) -> str | None:
    try:
        with open(path, "rb") as f:
            chunk = f.read(PARTIAL_HASH_BYTES)
        return hashlib.sha256(chunk).hexdigest()
    except (OSError, PermissionError):
        return None


def scan_drive(drive: str, progress_callback=None) -> dict:
    """
    Recursively scan `drive` (e.g. 'C:\\\\'), upsert file metadata into SQLite.
    Returns a summary dict. Emits progress via progress_callback(dict) if given,
    so the Tauri frontend can stream live progress.
    """
    db.init_db()
    errors = []
    files_scanned = files_added = files_updated = 0

    # Guards against infinite recursion from Windows junctions / reparse
    # points that loop back to an ancestor (e.g. AppData\Local\Application
    # Data). Without this, os.walk can hang indefinitely on a full C: scan.
    visited_real_paths: set[str] = set()

    with db.get_connection() as conn:
        scan_id = db.create_scan_job(conn, drive, scan_type="full")

        for root, dirs, files in os.walk(drive, onerror=lambda e: errors.append(str(e))):
            try:
                real_root = os.path.realpath(root)
            except OSError:
                real_root = root
            if real_root in visited_real_paths:
                dirs[:] = []
                continue
            visited_real_paths.add(real_root)

            # prune protected / inaccessible / already-visited / build-cache dirs before descending
            kept_dirs = []
            for d in dirs:
                if d.lower() in EXCLUDED_DIR_NAMES:
                    continue
                dpath = os.path.join(root, d)
                if is_protected_path(dpath):
                    continue
                try:
                    if os.path.islink(dpath):
                        continue  # never follow symlinks/junctions
                    real_d = os.path.realpath(dpath)
                except OSError:
                    continue
                if real_d in visited_real_paths:
                    continue
                kept_dirs.append(d)
            dirs[:] = kept_dirs

            for fname in files:
                fpath = os.path.join(root, fname)
                try:
                    stat = os.stat(fpath)
                except (OSError, PermissionError) as e:
                    errors.append(f"{fpath}: {e}")
                    continue

                ext = os.path.splitext(fname)[1].lower()
                record = {
                    "path": fpath,
                    "name": fname,
                    "extension": ext,
                    "size": stat.st_size,
                    "created_at": _iso(stat.st_ctime),
                    "modified_at": _iso(stat.st_mtime),
                    "last_accessed": _iso(stat.st_atime),
                    "drive": drive,
                    "folder": root,
                    "category": categorize(ext),
                    "scan_id": scan_id,
                    # Partial/full hashing is deliberately NOT done here —
                    # see core/scanner/duplicate_finder.py. Hashing every
                    # file during the base scan would add an open+read to
                    # every single file even when 99% have no duplicates.
                    # Staged hashing only touches files that already share
                    # an exact size with another file.
                    "partial_hash": None,
                }

                result, file_id = db.upsert_file(conn, record)
                db.insert_usage_snapshot(
                    conn, file_id, scan_id,
                    record["last_accessed"], record["modified_at"], record["size"],
                )
                files_scanned += 1
                if result == "added":
                    files_added += 1
                else:
                    files_updated += 1

                if progress_callback and files_scanned % 500 == 0:
                    progress_callback({
                        "scan_id": scan_id,
                        "files_scanned": files_scanned,
                        "current_folder": root,
                    })

            # commit in batches instead of once per file
            if files_scanned % 1000 == 0:
                conn.commit()

        conn.commit()
        files_removed = db.mark_missing_files(conn, drive, scan_id)

        db.finish_scan_job(
            conn, scan_id,
            status="completed" if not errors else "completed",
            files_scanned=files_scanned,
            files_added=files_added,
            files_updated=files_updated,
            files_removed=files_removed,
            errors_count=len(errors),
            error_log=json.dumps(errors[:200]) if errors else None,
        )

    return {
        "scan_id": scan_id,
        "drive": drive,
        "files_scanned": files_scanned,
        "files_added": files_added,
        "files_updated": files_updated,
        "files_removed": files_removed,
        "errors_count": len(errors),
    }


def get_dashboard_data(drive: str | None = None, category: str | None = None) -> dict:
    """Aggregate data for the dashboard UI: category breakdown + largest files + age distribution."""
    db.init_db()
    with db.get_connection() as conn:
        summary_rows = db.get_storage_summary(conn, drive)
        largest_rows = db.get_largest_files(conn, drive, limit=25, category=category)
        age_rows = db.get_age_distribution(conn, drive)

    return {
        "categories": [dict(r) for r in summary_rows],
        "largest_files": [dict(r) for r in largest_rows],
        "age_distribution": [dict(r) for r in age_rows],
    }


def main():
    parser = argparse.ArgumentParser(description="DriveGuardian scanner CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    scan_p = sub.add_parser("scan", help="Scan a drive")
    scan_p.add_argument("drive", help=r"Drive root, e.g. C:\ ")

    dash_p = sub.add_parser("dashboard", help="Print dashboard JSON for a drive")
    dash_p.add_argument("--drive", default=None)
    dash_p.add_argument("--category", default=None)

    args = parser.parse_args()

    if args.command == "scan":
        result = scan_drive(args.drive, progress_callback=lambda p: print(json.dumps(p), file=sys.stderr, flush=True))
        print(json.dumps(result))
    elif args.command == "dashboard":
        print(json.dumps(get_dashboard_data(args.drive, args.category)))


if __name__ == "__main__":
    main()
