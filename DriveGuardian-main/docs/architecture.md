# Architecture Notes

## Why SQLite stays local (and Supabase doesn't replace it)

DriveGuardian's core job is scanning potentially hundreds of thousands of
local files fast, offline, with no network round-trip per row. SQLite is
the source of truth for `files`, `scan_jobs`, and (Phase 5+) `operations` /
transaction journal. This is a hard constraint, not a style choice.

If cloud sync is added later (Phase 7+), Supabase's role should stay
narrow and explicit:
- **Sync**: user_preferences, protected_paths config, scan job summaries
  (counts/timestamps — not full path lists)
- **Auth**: only needed if a companion web dashboard is built
- **Never**: raw file paths/names at scale — that's a real privacy surface
  and also pointless network overhead for data that's only useful locally

## Data flow (Phase 1)

```
Tauri (Rust) --invoke--> React UI
     |
     +--Command::new("python")--> core/scanner/scanner.py
                                        |
                                        +--> os.walk() over drive
                                        +--> categorize + partial hash
                                        +--> core/database/db.py --> SQLite (~/.driveguardian/driveguardian.db)
```

The Rust layer never touches file content or the DB directly in Phase 1 —
it only enumerates drives (via `sysinfo`) and shells out to Python, which
owns all filesystem walking and all writes. This keeps a single source of
truth for scanning logic and avoids duplicating traversal/hashing logic
in two languages. Performance-critical pieces (per spec: hashing loops,
large-scale traversal) can be moved into Rust later without touching the
schema or the frontend contract, since the Tauri commands
(`scan_drive`, `get_dashboard`) already form a stable boundary.

## Protected paths (Phase 1 subset)

Full protected-path config (spec section 15) lands in Phase 5's Safety
Engine. Phase 1 only prunes traversal into system directories
(`Windows`, `Program Files`, `ProgramData`, etc.) since it's read-only —
there's nothing to protect against yet, just noise to avoid indexing.
