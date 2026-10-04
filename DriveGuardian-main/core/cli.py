"""
DriveGuardian - Unified CLI (for the bundled/installed build)

Dev mode (npm run tauri dev) keeps calling the individual scripts directly
via system Python — fast iteration, no rebuild needed when Python code
changes. This file exists ONLY for the installed/bundled build, where
Rust calls one packaged executable (built via PyInstaller) instead of
requiring the end user to have Python installed at all.

Subcommands mirror the individual scripts exactly:
  scan, dashboard              -> core/scanner/scanner.py
  duplicates                   -> core/scanner/duplicate_finder.py
  score, recommendations       -> core/scanner/scoring.py
  quarantine, restore, ops-list -> core/scanner/operations.py
  ai-status, ai-query          -> core/ai/query_interpreter.py

This is a thin router — all real logic stays in the existing modules,
so there's exactly one implementation of each behavior, not two.
"""

import sys
import json
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from scanner import scanner as _scanner
from scanner import duplicate_finder as _dupes
from scanner import scoring as _scoring
from scanner import operations as _ops
from ai import query_interpreter as _ai


def main():
    parser = argparse.ArgumentParser(description="DriveGuardian unified CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("scan")
    p.add_argument("drive")

    p = sub.add_parser("dashboard")
    p.add_argument("--drive", default=None)
    p.add_argument("--category", default=None)

    p = sub.add_parser("duplicates")
    p.add_argument("--drive", default=None)

    p = sub.add_parser("score")
    p.add_argument("--drive", default=None)

    p = sub.add_parser("recommendations")
    p.add_argument("--drive", default=None)
    p.add_argument("--classification", default="DELETE_CANDIDATE")
    p.add_argument("--limit", type=int, default=50)

    p = sub.add_parser("quarantine")
    p.add_argument("--ids", required=True)

    p = sub.add_parser("restore")
    p.add_argument("--operation-id", type=int, required=True)

    p = sub.add_parser("ops-list")
    p.add_argument("--status", default=None)
    p.add_argument("--limit", type=int, default=100)

    p = sub.add_parser("ai-status")

    p = sub.add_parser("ai-query")
    p.add_argument("--question", required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--drive", default=None)

    args = parser.parse_args()

    def progress(p):
        print(json.dumps(p), file=sys.stderr, flush=True)

    if args.command == "scan":
        print(json.dumps(_scanner.scan_drive(args.drive, progress_callback=progress)))
    elif args.command == "dashboard":
        print(json.dumps(_scanner.get_dashboard_data(args.drive, args.category)))
    elif args.command == "duplicates":
        print(json.dumps(_dupes.find_duplicates(args.drive, progress_callback=progress)))
    elif args.command == "score":
        print(json.dumps(_scoring.compute_scores(args.drive, progress_callback=progress)))
    elif args.command == "recommendations":
        print(json.dumps(_scoring.get_recommendations(args.drive, args.classification, args.limit)))
    elif args.command == "quarantine":
        ids = [int(x) for x in args.ids.split(",") if x.strip()]
        print(json.dumps(_ops.quarantine_batch(ids, progress_callback=progress)))
    elif args.command == "restore":
        print(json.dumps(_ops.restore_operation(args.operation_id)))
    elif args.command == "ops-list":
        print(json.dumps(_ops.list_operations(args.status, args.limit)))
    elif args.command == "ai-status":
        running, error = _ai.check_ollama_running_verbose()
        print(json.dumps({"running": running, "models": _ai.list_models() if running else [], "error": error}))
    elif args.command == "ai-query":
        print(json.dumps(_ai.run_query(args.question, args.model, args.drive)))


if __name__ == "__main__":
    main()
