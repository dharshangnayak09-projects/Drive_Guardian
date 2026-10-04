"""
DriveGuardian - Safe Operations Engine (Phase 5)

Every operation follows copy -> verify -> delete-original, never a raw
move or delete:
  1. Copy the file to <drive>\\DriveGuardian_Quarantine\\<relative path>
  2. Verify the copy (size match)
  3. Only THEN remove the original
  4. Log the operation to the DB journal BEFORE step 3, so even a crash
     mid-operation leaves us with two copies (safe) rather than zero
     (unrecoverable) — never the other way around.

Restore reverses this exactly: copy back, verify, remove the quarantine
copy, update the journal. Nothing here is a permanent delete — that's a
deliberate, separate, later action (not built yet, by design).
"""

import os
import sys
import shutil
import json
import argparse
from pathlib import Path

if not getattr(sys, "frozen", False):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # repo root, dev mode only
from core.database import db
from core.scanner.scanner import is_protected_path

QUARANTINE_DIR_NAME = "DriveGuardian_Quarantine"


def _quarantine_root(drive: str) -> str:
    return os.path.join(drive, QUARANTINE_DIR_NAME)


def _quarantine_dest_path(original_path: str, drive: str) -> str:
    """Mirrors the original folder structure under the quarantine root so
    restore can reconstruct the exact original location, and so browsing
    quarantine is intuitive (not a flat dump of files with no context)."""
    rel = os.path.relpath(original_path, drive)
    dest = os.path.join(_quarantine_root(drive), rel)
    return dest


def _unique_path(path: str) -> str:
    """Appends ' (2)', ' (3)', ... if path already exists, so quarantining
    two same-named files from different folders never overwrites either."""
    if not os.path.exists(path):
        return path
    base, ext = os.path.splitext(path)
    n = 2
    while os.path.exists(f"{base} ({n}){ext}"):
        n += 1
    return f"{base} ({n}){ext}"


def _quick_verify(src: str, dst: str) -> bool:
    """Size check is the fast baseline; a full hash re-check would be more
    thorough but doubles I/O for every quarantine operation. Size mismatch
    alone is enough to catch a truncated/failed copy, which is the realistic
    failure mode here (not bit-level corruption on a local same-drive copy)."""
    try:
        return os.path.getsize(src) == os.path.getsize(dst)
    except OSError:
        return False


def quarantine_file(conn, file_row) -> dict:
    """Moves a single file to quarantine. file_row needs: id, path, drive, size."""
    original_path = file_row["path"]
    drive = file_row["drive"]

    if is_protected_path(original_path):
        return {"file_id": file_row["id"], "status": "failed", "error": "Refused: protected system path"}
    if not os.path.exists(original_path):
        return {"file_id": file_row["id"], "status": "failed", "error": "File no longer exists at recorded path"}
    if QUARANTINE_DIR_NAME in original_path:
        return {"file_id": file_row["id"], "status": "failed", "error": "Already in quarantine"}

    dest = _unique_path(_quarantine_dest_path(original_path, drive))

    try:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copy2(original_path, dest)
    except (OSError, PermissionError) as e:
        return {"file_id": file_row["id"], "status": "failed", "error": f"Copy failed: {e}"}

    if not _quick_verify(original_path, dest):
        # Verification failed — clean up the bad copy, leave the original
        # untouched. Never delete the source on an unverified copy.
        try:
            os.remove(dest)
        except OSError:
            pass
        return {"file_id": file_row["id"], "status": "failed", "error": "Copy verification failed (size mismatch)"}

    # Log the journal entry BEFORE removing the original — if anything
    # crashes between here and os.remove, we still have both copies and
    # a record of what was in progress, which is the safe failure state.
    cur = conn.execute(
        """INSERT INTO operations (file_id, original_path, quarantine_path, size, status, performed_at)
           VALUES (?, ?, ?, ?, 'completed', datetime('now'))""",
        (file_row["id"], original_path, dest, file_row["size"]),
    )
    operation_id = cur.lastrowid

    try:
        os.remove(original_path)
    except (OSError, PermissionError) as e:
        # Copy succeeded and is verified, but we couldn't remove the
        # original. Not a data-loss risk (both copies exist) — just leave
        # the operation logged as completed-with-note; the quarantine copy
        # is still valid and the user still has the original too.
        conn.execute("UPDATE operations SET error = ? WHERE id = ?",
                      (f"Original not removed: {e}", operation_id))

    conn.execute(
        "UPDATE files SET path = ?, classification = 'QUARANTINED' WHERE id = ?",
        (dest, file_row["id"]),
    )

    return {"file_id": file_row["id"], "status": "completed", "operation_id": operation_id,
            "quarantine_path": dest, "size": file_row["size"]}


def quarantine_batch(file_ids: list[int], progress_callback=None) -> dict:
    db.init_db()
    results = []
    with db.get_connection() as conn:
        placeholders = ",".join("?" * len(file_ids))
        rows = conn.execute(
            f"SELECT id, path, drive, size FROM files WHERE id IN ({placeholders})",
            file_ids,
        ).fetchall()

        for i, row in enumerate(rows):
            result = quarantine_file(conn, row)
            results.append(result)
            conn.commit()  # commit per-file so a crash mid-batch doesn't lose earlier successes
            if progress_callback:
                progress_callback({"processed": i + 1, "total": len(rows)})

    succeeded = [r for r in results if r["status"] == "completed"]
    failed = [r for r in results if r["status"] == "failed"]
    freed_bytes = sum(r.get("size", 0) for r in succeeded)

    return {
        "total": len(results),
        "succeeded": len(succeeded),
        "failed": len(failed),
        "freed_bytes": freed_bytes,
        "failures": failed,
    }


def restore_operation(operation_id: int) -> dict:
    db.init_db()
    with db.get_connection() as conn:
        op = conn.execute("SELECT * FROM operations WHERE id = ?", (operation_id,)).fetchone()
        if op is None:
            return {"status": "failed", "error": "Operation not found"}
        if op["status"] == "restored":
            return {"status": "failed", "error": "Already restored"}
        if not os.path.exists(op["quarantine_path"]):
            return {"status": "failed", "error": "Quarantine copy no longer exists"}

        dest = op["original_path"]
        if os.path.exists(dest):
            dest = _unique_path(dest)  # something now occupies the original spot

        try:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.copy2(op["quarantine_path"], dest)
        except (OSError, PermissionError) as e:
            return {"status": "failed", "error": f"Restore copy failed: {e}"}

        if not _quick_verify(op["quarantine_path"], dest):
            try:
                os.remove(dest)
            except OSError:
                pass
            return {"status": "failed", "error": "Restore verification failed"}

        try:
            os.remove(op["quarantine_path"])
        except (OSError, PermissionError):
            pass  # non-fatal — restored copy is valid either way

        conn.execute(
            "UPDATE operations SET status = 'restored', restored_at = datetime('now') WHERE id = ?",
            (operation_id,),
        )
        if op["file_id"] is not None:
            conn.execute(
                "UPDATE files SET path = ?, classification = NULL WHERE id = ?",
                (dest, op["file_id"]),
            )
        conn.commit()

    return {"status": "restored", "restored_path": dest}


def list_operations(status: str | None = None, limit: int = 100) -> list[dict]:
    db.init_db()
    with db.get_connection() as conn:
        if status:
            rows = conn.execute(
                "SELECT * FROM operations WHERE status = ? ORDER BY performed_at DESC LIMIT ?",
                (status, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM operations ORDER BY performed_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]


def main():
    parser = argparse.ArgumentParser(description="DriveGuardian safe operations")
    sub = parser.add_subparsers(dest="command", required=True)

    q_p = sub.add_parser("quarantine", help="Move files to quarantine")
    q_p.add_argument("--ids", required=True, help="Comma-separated file IDs")

    r_p = sub.add_parser("restore", help="Restore a quarantined file")
    r_p.add_argument("--operation-id", type=int, required=True)

    l_p = sub.add_parser("list", help="List operations")
    l_p.add_argument("--status", default=None)
    l_p.add_argument("--limit", type=int, default=100)

    args = parser.parse_args()

    if args.command == "quarantine":
        ids = [int(x) for x in args.ids.split(",") if x.strip()]
        result = quarantine_batch(ids, progress_callback=lambda p: print(json.dumps(p), file=sys.stderr, flush=True))
        print(json.dumps(result))
    elif args.command == "restore":
        print(json.dumps(restore_operation(args.operation_id)))
    elif args.command == "list":
        print(json.dumps(list_operations(args.status, args.limit)))


if __name__ == "__main__":
    main()
