"""
DriveGuardian - Duplicate File Finder (Phase 2)

Staged approach, cheapest check first:
  1. Group files by exact size (free — already in the DB from the scan)
  2. For files sharing a size, compute a cheap partial hash (first 64KB)
  3. For files that ALSO share a partial hash, compute a full-file hash
  4. Files sharing size + partial hash + full hash are true duplicates

This means the expensive full-file hash only ever runs on files that have
already passed two cheaper filters — on a typical drive this is a tiny
fraction of the total file count, not everything.
"""

import sys
import json
import argparse
from pathlib import Path
from collections import defaultdict

if not getattr(sys, "frozen", False):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # repo root, dev mode only
from core.database import db
from core.scanner.scanner import partial_hash, full_hash


def find_duplicates(drive: str | None = None, progress_callback=None) -> dict:
    db.init_db()

    with db.get_connection() as conn:
        filters = ["is_missing = 0", "size > 0"]
        params: list = []
        if drive:
            filters.append("drive = ?")
            params.append(drive)

        rows = conn.execute(
            f"SELECT id, path, size FROM files WHERE {' AND '.join(filters)}",
            params,
        ).fetchall()

        # Stage 1: group by size, drop groups of 1 (no possible duplicate)
        by_size: dict[int, list] = defaultdict(list)
        for r in rows:
            by_size[r["size"]].append(r)
        size_candidates = {sz: files for sz, files in by_size.items() if len(files) > 1}

        # Stage 2: partial hash within each size group
        by_partial: dict[tuple, list] = defaultdict(list)
        processed = 0
        stage2_total = sum(len(files) for files in size_candidates.values())
        if progress_callback:
            progress_callback({"stage": "partial_hash", "processed": 0, "total": stage2_total})
        for sz, files in size_candidates.items():
            for f in files:
                ph = partial_hash(f["path"])
                processed += 1
                if progress_callback and processed % 50 == 0:
                    progress_callback({"stage": "partial_hash", "processed": processed, "total": stage2_total})
                if ph is None:
                    continue
                by_partial[(sz, ph)].append(f)
                conn.execute("UPDATE files SET partial_hash = ? WHERE id = ?", (ph, f["id"]))
        conn.commit()

        partial_candidates = {k: v for k, v in by_partial.items() if len(v) > 1}

        # Stage 3: full hash within each partial-hash group
        by_full: dict[str, list] = defaultdict(list)
        processed = 0
        stage3_total = sum(len(files) for files in partial_candidates.values())
        if progress_callback:
            progress_callback({"stage": "full_hash", "processed": 0, "total": stage3_total})
        for _, files in partial_candidates.items():
            for f in files:
                fh = full_hash(f["path"])
                processed += 1
                if progress_callback and processed % 20 == 0:
                    progress_callback({"stage": "full_hash", "processed": processed, "total": stage3_total})
                if fh is None:
                    continue
                by_full[fh].append(f)
                conn.execute("UPDATE files SET full_hash = ? WHERE id = ?", (fh, f["id"]))
        conn.commit()

        duplicate_groups = [
            {
                "full_hash": h,
                "size": files[0]["size"],
                "count": len(files),
                "wasted_space": files[0]["size"] * (len(files) - 1),
                "files": [{"id": f["id"], "path": f["path"]} for f in files],
            }
            for h, files in by_full.items() if len(files) > 1
        ]
        duplicate_groups.sort(key=lambda g: g["wasted_space"], reverse=True)

    total_wasted = sum(g["wasted_space"] for g in duplicate_groups)
    return {
        "groups": duplicate_groups,
        "total_groups": len(duplicate_groups),
        "total_wasted_space": total_wasted,
    }


def main():
    parser = argparse.ArgumentParser(description="DriveGuardian duplicate finder")
    parser.add_argument("--drive", default=None)
    args = parser.parse_args()

    result = find_duplicates(
        args.drive,
        progress_callback=lambda p: print(json.dumps(p), file=sys.stderr, flush=True),
    )
    print(json.dumps(result))


if __name__ == "__main__":
    main()
