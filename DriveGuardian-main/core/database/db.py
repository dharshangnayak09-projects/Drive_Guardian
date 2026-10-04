"""
DriveGuardian - SQLite access layer.

Single source of truth for schema + connection handling. Keep this the
only module that talks to sqlite3 directly, so later phases (operations,
rollback, learning) don't each reinvent connection handling.
"""

import sqlite3
import sys
from pathlib import Path
from contextlib import contextmanager
from datetime import datetime, timezone

APP_DIR = Path.home() / ".driveguardian"
DB_PATH = APP_DIR / "driveguardian.db"
def _resolve_schema_path() -> Path:
    """PyInstaller's frozen runtime extracts bundled data files to
    sys._MEIPASS, not the original repo layout — __file__-based relative
    paths don't point anywhere real once frozen. Dev mode (running
    straight from source) keeps using the real filesystem path."""
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "database" / "schema.sql"  # type: ignore[attr-defined]
    return Path(__file__).resolve().parents[2] / "database" / "schema.sql"


SCHEMA_PATH = _resolve_schema_path()


def ensure_app_dir() -> None:
    APP_DIR.mkdir(parents=True, exist_ok=True)


def init_db(db_path: Path = DB_PATH) -> None:
    """Create the database file and apply schema.sql if not already present."""
    ensure_app_dir()
    with get_connection(db_path) as conn:
        schema_sql = SCHEMA_PATH.read_text(encoding="utf-8")
        conn.executescript(schema_sql)
        conn.commit()


@contextmanager
def get_connection(db_path: Path = DB_PATH):
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 30000")  # wait up to 30s for locks instead
                                                    # of failing immediately if a scan
                                                    # and duplicate-finder run at once
    try:
        yield conn
    finally:
        conn.close()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------- scan_jobs ----------

def create_scan_job(conn: sqlite3.Connection, drive: str, scan_type: str = "full") -> int:
    cur = conn.execute(
        "INSERT INTO scan_jobs (drive, status, scan_type, started_at) VALUES (?, 'running', ?, ?)",
        (drive, scan_type, now_iso()),
    )
    conn.commit()
    return cur.lastrowid


def finish_scan_job(conn: sqlite3.Connection, scan_id: int, *, status: str,
                     files_scanned: int, files_added: int, files_updated: int,
                     files_removed: int, errors_count: int, error_log: str | None) -> None:
    conn.execute(
        """UPDATE scan_jobs
           SET status=?, finished_at=?, files_scanned=?, files_added=?,
               files_updated=?, files_removed=?, errors_count=?, error_log=?
           WHERE id=?""",
        (status, now_iso(), files_scanned, files_added, files_updated,
         files_removed, errors_count, error_log, scan_id),
    )
    conn.commit()


# ---------- files ----------

def upsert_file(conn: sqlite3.Connection, record: dict) -> tuple[str, int]:
    """Insert or update a file row by unique path. Returns (status, file_id)
    where status is 'added' or 'updated' — file_id lets the caller record a
    usage_snapshots row in the same pass without a second lookup query."""
    existing = conn.execute(
        "SELECT id, size, modified_at FROM files WHERE path = ?", (record["path"],)
    ).fetchone()

    if existing is None:
        cur = conn.execute(
            """INSERT INTO files
               (path, name, extension, size, created_at, modified_at, last_accessed,
                drive, folder, category, is_missing, last_seen_scan_id, created_row_at, updated_row_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)""",
            (record["path"], record["name"], record["extension"], record["size"],
             record["created_at"], record["modified_at"], record["last_accessed"],
             record["drive"], record["folder"], record["category"],
             record["scan_id"], now_iso(), now_iso()),
        )
        return "added", cur.lastrowid
    else:
        conn.execute(
            """UPDATE files SET name=?, extension=?, size=?, created_at=?, modified_at=?,
               last_accessed=?, category=?, is_missing=0, last_seen_scan_id=?, updated_row_at=?
               WHERE path=?""",
            (record["name"], record["extension"], record["size"], record["created_at"],
             record["modified_at"], record["last_accessed"], record["category"],
             record["scan_id"], now_iso(), record["path"]),
        )
        return "updated", existing["id"]


def mark_missing_files(conn: sqlite3.Connection, drive: str, scan_id: int) -> int:
    """Any file on this drive not touched by this scan is flagged missing (not deleted)."""
    cur = conn.execute(
        "UPDATE files SET is_missing = 1, updated_row_at = ? WHERE drive = ? AND last_seen_scan_id != ?",
        (now_iso(), drive, scan_id),
    )
    conn.commit()
    return cur.rowcount


def get_storage_summary(conn: sqlite3.Connection, drive: str | None = None) -> list[sqlite3.Row]:
    query = """
        SELECT category, COUNT(*) as file_count, SUM(size) as total_size
        FROM files
        WHERE is_missing = 0 {drive_filter}
        GROUP BY category
        ORDER BY total_size DESC
    """.format(drive_filter="AND drive = ?" if drive else "")
    params = (drive,) if drive else ()
    return conn.execute(query, params).fetchall()


def insert_usage_snapshot(conn: sqlite3.Connection, file_id: int, scan_id: int,
                           last_accessed: str | None, modified_at: str, size: int) -> None:
    conn.execute(
        """INSERT INTO usage_snapshots (file_id, scan_id, last_accessed, modified_at, size, captured_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (file_id, scan_id, last_accessed, modified_at, size, now_iso()),
    )


def get_age_distribution(conn: sqlite3.Connection, drive: str | None = None) -> list[sqlite3.Row]:
    """Buckets files by days since modified_at. Uses modified_at (not
    last_accessed) as the primary signal because Windows disables
    last-access-time tracking by default — modified_at is reliable on
    every system regardless of that setting."""
    filters = ["is_missing = 0"]
    params: list = []
    if drive:
        filters.append("drive = ?")
        params.append(drive)

    query = f"""
        SELECT
            CASE
                WHEN julianday('now') - julianday(modified_at) <= 7 THEN 'last_7_days'
                WHEN julianday('now') - julianday(modified_at) <= 30 THEN 'last_30_days'
                WHEN julianday('now') - julianday(modified_at) <= 90 THEN 'last_90_days'
                WHEN julianday('now') - julianday(modified_at) <= 365 THEN 'last_year'
                ELSE 'over_a_year'
            END AS bucket,
            COUNT(*) as file_count,
            SUM(size) as total_size
        FROM files
        WHERE {' AND '.join(filters)}
        GROUP BY bucket
    """
    return conn.execute(query, params).fetchall()


def get_snapshot_count(conn: sqlite3.Connection, file_id: int) -> int:
    """How many scans have captured this file. >1 means we have real
    cross-scan history to compare, not just a single point-in-time read."""
    row = conn.execute(
        "SELECT COUNT(*) as c FROM usage_snapshots WHERE file_id = ?", (file_id,)
    ).fetchone()
    return row["c"] if row else 0
def get_largest_files(conn: sqlite3.Connection, drive: str | None = None, limit: int = 50,
                       category: str | None = None) -> list[sqlite3.Row]:
    filters = ["is_missing = 0"]
    params: list = []
    if drive:
        filters.append("drive = ?")
        params.append(drive)
    if category:
        filters.append("category = ?")
        params.append(category)
    params.append(limit)

    query = f"""
        SELECT path, name, size, category, modified_at, drive
        FROM files
        WHERE {' AND '.join(filters)}
        ORDER BY size DESC
        LIMIT ?
    """
    return conn.execute(query, params).fetchall()
