"""
DriveGuardian - Scoring Engine (Phase 3)

Computes two scores per file, both in [0, 1]:

  AFUS (Adaptive File Utility Score) — "how valuable is this file right now"
    Combines recency of activity, whether it's actively changing across
    scans, and a category weight (code/documents matter more by default
    than installers/system junk).

  FAP (Future Access Probability) — "how likely are you to need this again"
    A longer-horizon recency decay — a file can have low AFUS (not used
    lately) but still reasonably high FAP (a tax document you'll need
    again next April).

These feed a plain-language classification (KEEP / REVIEW / ARCHIVE /
DELETE_CANDIDATE) used only as a SUGGESTION — Phase 3 never deletes,
moves, or modifies anything. That's Phase 5, and even then only with
explicit confirmation per the Safety Engine design.
"""

import sys
import json
import argparse
import math
from pathlib import Path

if not getattr(sys, "frozen", False):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # repo root, dev mode only
from core.database import db

# How many days of no activity before a file's recency contribution halves.
# AFUS uses a shorter half-life (recent relevance decays faster) than FAP
# (long-term "might still need this" decays slower).
AFUS_HALF_LIFE_DAYS = 90
FAP_HALF_LIFE_DAYS = 270

# Baseline importance by category — a starting point, not a judgment.
# Deliberately conservative: nothing here defaults below 0.1, since a
# wrong "this is junk" call is worse than a missed cleanup opportunity.
CATEGORY_WEIGHTS = {
    "code": 1.0, "document": 1.0, "spreadsheet": 1.0, "database": 0.9,
    "presentation": 0.9, "image": 0.7, "font": 0.6, "audio": 0.6,
    "video": 0.6, "archive": 0.5, "other": 0.5, "system": 0.3, "installer": 0.2,
}

# Classification thresholds on AFUS. DELETE_CANDIDATE additionally requires
# a minimum size so we're not suggesting cleanup of thousands of tiny,
# harmless, low-score files that would clutter a review list for no gain.
DELETE_CANDIDATE_MIN_SIZE = 10 * 1024 * 1024  # 10MB


def _recency_days(modified_at: str | None, last_accessed: str | None) -> float:
    from datetime import datetime, timezone
    timestamps = [t for t in (modified_at, last_accessed) if t]
    if not timestamps:
        return 9999.0
    most_recent = max(datetime.fromisoformat(t) for t in timestamps)
    now = datetime.now(timezone.utc)
    return max(0.0, (now - most_recent).total_seconds() / 86400)


def _decay(days: float, half_life: float) -> float:
    return 0.5 ** (days / half_life)


def compute_afus(modified_at: str | None, last_accessed: str | None,
                  category: str, has_changed_across_scans: bool) -> float:
    days = _recency_days(modified_at, last_accessed)
    recency_score = _decay(days, AFUS_HALF_LIFE_DAYS)
    frequency_score = 1.0 if has_changed_across_scans else 0.0
    category_weight = CATEGORY_WEIGHTS.get(category, 0.5)
    return round(0.5 * recency_score + 0.3 * frequency_score + 0.2 * category_weight, 4)


def compute_fap(modified_at: str | None, last_accessed: str | None) -> float:
    days = _recency_days(modified_at, last_accessed)
    return round(_decay(days, FAP_HALF_LIFE_DAYS), 4)


def classify(afus: float, size: int, is_duplicate_copy: bool) -> str:
    if is_duplicate_copy:
        return "DELETE_CANDIDATE"  # a non-primary copy of an exact duplicate
    if afus >= 0.6:
        return "KEEP"
    if afus >= 0.3:
        return "REVIEW"
    if afus >= 0.15:
        return "ARCHIVE"
    if size >= DELETE_CANDIDATE_MIN_SIZE:
        return "DELETE_CANDIDATE"
    return "ARCHIVE"  # low score but too small to bother flagging for deletion


def compute_scores(drive: str | None = None, progress_callback=None) -> dict:
    db.init_db()
    with db.get_connection() as conn:
        filters = ["is_missing = 0"]
        params: list = []
        if drive:
            filters.append("drive = ?")
            params.append(drive)

        rows = conn.execute(
            f"""SELECT id, modified_at, last_accessed, category, size, full_hash
                FROM files WHERE {' AND '.join(filters)}""",
            params,
        ).fetchall()

        # A file "has changed across scans" if it has 2+ snapshots with
        # different modified_at values — a real (if simple) usage signal
        # that works even without last-access tracking enabled.
        changed_ids = {
            r["file_id"]
            for r in conn.execute(
                """SELECT file_id, COUNT(DISTINCT modified_at) as distinct_count
                   FROM usage_snapshots GROUP BY file_id HAVING distinct_count > 1"""
            ).fetchall()
        }

        # Duplicate groups: within each full_hash group, the oldest file
        # (by modified_at) is treated as primary/KEEP; the rest are flagged
        # as duplicate copies regardless of their own AFUS.
        dup_rows = conn.execute(
            """SELECT id, full_hash, modified_at FROM files
               WHERE is_missing = 0 AND full_hash IS NOT NULL"""
        ).fetchall()
        by_hash: dict[str, list] = {}
        for r in dup_rows:
            by_hash.setdefault(r["full_hash"], []).append(r)
        duplicate_copy_ids = set()
        for group in by_hash.values():
            if len(group) < 2:
                continue
            sorted_group = sorted(group, key=lambda r: r["modified_at"] or "")
            for r in sorted_group[1:]:  # keep the oldest, flag the rest
                duplicate_copy_ids.add(r["id"])

        processed = 0
        counts = {"KEEP": 0, "REVIEW": 0, "ARCHIVE": 0, "DELETE_CANDIDATE": 0}
        reclaimable_bytes = 0
        total = len(rows)

        if progress_callback:
            progress_callback({"processed": 0, "total": total})

        for r in rows:
            afus = compute_afus(
                r["modified_at"], r["last_accessed"], r["category"], r["id"] in changed_ids
            )
            fap = compute_fap(r["modified_at"], r["last_accessed"])
            label = classify(afus, r["size"], r["id"] in duplicate_copy_ids)

            conn.execute(
                "UPDATE files SET utility_score = ?, future_access_probability = ?, classification = ? WHERE id = ?",
                (afus, fap, label, r["id"]),
            )
            counts[label] += 1
            if label == "DELETE_CANDIDATE":
                reclaimable_bytes += r["size"]

            processed += 1
            if progress_callback and processed % 100 == 0:
                progress_callback({"processed": processed, "total": total})

        conn.commit()

    return {
        "total_scored": len(rows),
        "counts": counts,
        "potentially_reclaimable_bytes": reclaimable_bytes,
    }


def get_recommendations(drive: str | None = None, classification: str = "DELETE_CANDIDATE",
                         limit: int = 50) -> list[dict]:
    db.init_db()
    with db.get_connection() as conn:
        filters = ["is_missing = 0", "classification = ?"]
        params: list = [classification]
        if drive:
            filters.append("drive = ?")
            params.append(drive)
        params.append(limit)

        rows = conn.execute(
            f"""SELECT id, path, name, size, category, modified_at, utility_score,
                       future_access_probability, classification
                FROM files WHERE {' AND '.join(filters)}
                ORDER BY size DESC LIMIT ?""",
            params,
        ).fetchall()
        return [dict(r) for r in rows]


def main():
    parser = argparse.ArgumentParser(description="DriveGuardian scoring engine")
    sub = parser.add_subparsers(dest="command", required=True)

    score_p = sub.add_parser("score", help="Compute AFUS/FAP scores for all files")
    score_p.add_argument("--drive", default=None)

    rec_p = sub.add_parser("recommendations", help="List files by classification")
    rec_p.add_argument("--drive", default=None)
    rec_p.add_argument("--classification", default="DELETE_CANDIDATE")
    rec_p.add_argument("--limit", type=int, default=50)

    args = parser.parse_args()

    if args.command == "score":
        result = compute_scores(args.drive, progress_callback=lambda p: print(json.dumps(p), file=sys.stderr, flush=True))
        print(json.dumps(result))
    elif args.command == "recommendations":
        print(json.dumps(get_recommendations(args.drive, args.classification, args.limit)))


if __name__ == "__main__":
    main()
