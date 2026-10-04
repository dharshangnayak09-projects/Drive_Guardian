-- DriveGuardian Phase 1 schema
-- Source of truth: local SQLite. See docs/architecture.md for rationale.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS files (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    path                        TEXT NOT NULL UNIQUE,
    name                        TEXT NOT NULL,
    extension                   TEXT,
    size                        INTEGER NOT NULL DEFAULT 0,
    created_at                  TEXT,
    modified_at                 TEXT,
    last_accessed               TEXT,
    partial_hash                TEXT,
    full_hash                   TEXT,
    drive                       TEXT NOT NULL,
    folder                      TEXT NOT NULL,
    category                    TEXT,               -- video/image/doc/archive/installer/code/other
    utility_score               REAL,                -- AFUS, Phase 3
    future_access_probability   REAL,                -- FAP, Phase 3
    classification               TEXT,                -- KEEP/MOVE/ARCHIVE/DELETE, Phase 4+
    is_missing                  INTEGER NOT NULL DEFAULT 0,  -- set 1 if not seen on latest scan
    last_seen_scan_id           INTEGER,
    created_row_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_row_at              TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (last_seen_scan_id) REFERENCES scan_jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_files_drive ON files(drive);
CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder);
CREATE INDEX IF NOT EXISTS idx_files_size ON files(size);
CREATE INDEX IF NOT EXISTS idx_files_extension ON files(extension);
CREATE INDEX IF NOT EXISTS idx_files_category ON files(category);
CREATE INDEX IF NOT EXISTS idx_files_partial_hash ON files(partial_hash);
CREATE INDEX IF NOT EXISTS idx_files_full_hash ON files(full_hash);

CREATE TABLE IF NOT EXISTS scan_jobs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    drive               TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'running', -- running/completed/failed/cancelled
    scan_type           TEXT NOT NULL DEFAULT 'full',     -- full/incremental
    started_at          TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at         TEXT,
    files_scanned       INTEGER NOT NULL DEFAULT 0,
    files_added         INTEGER NOT NULL DEFAULT 0,
    files_updated       INTEGER NOT NULL DEFAULT 0,
    files_removed       INTEGER NOT NULL DEFAULT 0,
    errors_count        INTEGER NOT NULL DEFAULT 0,
    error_log           TEXT
);

-- Later phases (relationships, operations, preferences) will extend this
-- file further. usage_snapshots (below) is Phase 2's usage-tracking piece.

-- Captures last_accessed/modified_at at every scan, per file. Comparing
-- consecutive snapshots is how we build real usage history over time —
-- a single scan can't tell you if a file is "still used", but a growing
-- series of snapshots can show whether modified_at/last_accessed ever
-- change between scans. This is what Phase 3's AFUS/FAP scoring reads.
CREATE TABLE IF NOT EXISTS usage_snapshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id         INTEGER NOT NULL,
    scan_id         INTEGER NOT NULL,
    last_accessed   TEXT,
    modified_at     TEXT,
    size            INTEGER NOT NULL,
    captured_at     TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
    FOREIGN KEY (scan_id) REFERENCES scan_jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_usage_snapshots_file ON usage_snapshots(file_id);
CREATE INDEX IF NOT EXISTS idx_usage_snapshots_scan ON usage_snapshots(scan_id);

-- Phase 5: Safe Operations. Every quarantine move is logged here BEFORE
-- the original file is deleted, and only after the copy is verified —
-- see core/scanner/operations.py. This is what makes restore possible:
-- nothing is ever a raw delete, everything is copy -> verify -> remove
-- original, with the journal entry as the source of truth for undo.
CREATE TABLE IF NOT EXISTS operations (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id            INTEGER,
    original_path      TEXT NOT NULL,
    quarantine_path    TEXT NOT NULL,
    size               INTEGER NOT NULL,
    status             TEXT NOT NULL DEFAULT 'completed', -- completed/restored/failed
    performed_at       TEXT NOT NULL DEFAULT (datetime('now')),
    restored_at        TEXT,
    error              TEXT,
    FOREIGN KEY (file_id) REFERENCES files(id)
);

CREATE INDEX IF NOT EXISTS idx_operations_status ON operations(status);
CREATE INDEX IF NOT EXISTS idx_operations_file ON operations(file_id);
