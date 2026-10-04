"""
DriveGuardian - AI Query Interpreter (Phase 6)

Read-only natural language search over the file index. Deliberately
constrained: the LLM never sees or writes SQL, and never triggers a file
operation. It only fills in a fixed JSON filter schema; we validate and
execute that ourselves. This means a malicious or malformed filename in
the index can't manipulate the query (nothing from file content/names
reaches the LLM's own instruction-following context — only the user's
question does), and the AI has no path to move or delete anything.

Requires Ollama running locally (https://ollama.com) — free, local,
no API key, no cost. If it's not running, callers get a clear error
telling the user how to start it.
"""

import sys
import json
import argparse
import urllib.request
import urllib.error
from pathlib import Path

if not getattr(sys, "frozen", False):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # repo root, dev mode only
from core.database import db

OLLAMA_URL = "http://localhost:11434"

# Explicitly bypass any system/VPN proxy for these calls. urllib respects
# HTTP_PROXY/HTTPS_PROXY environment variables by default even for
# localhost, which silently breaks local-only requests like this on many
# Windows setups (corporate VPN, etc.) even though the service itself is
# reachable — confirmed separately by `ollama list` working fine in a
# terminal (a different tool, not subject to the same proxy logic).
_NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

FILTER_SCHEMA_PROMPT = """You are a query interpreter for a file management tool. Convert the user's request into ONLY a JSON object (no other text, no markdown fences) with these fields, all optional except where noted:

{
  "category": one of ["video","image","audio","document","spreadsheet","presentation","archive","installer","code","database","font","system","other"] or null,
  "min_size_mb": number or null (minimum file size in megabytes),
  "max_size_mb": number or null (maximum file size in megabytes),
  "min_age_days": integer or null (at least this many days since last modified),
  "max_age_days": integer or null (at most this many days since last modified),
  "classification": one of ["KEEP","REVIEW","ARCHIVE","DELETE_CANDIDATE","QUARANTINED"] or null,
  "name_contains": string or null (substring to search in filename),
  "sort_by": one of ["size_desc","size_asc","age_desc","age_asc"] (default "size_desc"),
  "limit": integer (default 25, max 200)
}

Examples:
"find my biggest old videos" -> {"category": "video", "min_age_days": 180, "sort_by": "size_desc", "limit": 25}
"show me duplicate photos over 50mb" -> {"category": "image", "min_size_mb": 50, "sort_by": "size_desc", "limit": 25}
"what can I delete" -> {"classification": "DELETE_CANDIDATE", "sort_by": "size_desc", "limit": 25}
"recent documents" -> {"category": "document", "max_age_days": 30, "sort_by": "age_desc", "limit": 25}

Respond with ONLY the JSON object, nothing else."""


def check_ollama_running() -> bool:
    try:
        _NO_PROXY_OPENER.open(f"{OLLAMA_URL}/api/tags", timeout=3)
        return True
    except (urllib.error.URLError, OSError):
        return False


def check_ollama_running_verbose() -> tuple[bool, str | None]:
    """Like check_ollama_running but returns the actual error too, so a
    persistent connection failure can be diagnosed instead of just
    showing a generic 'not running' message."""
    try:
        _NO_PROXY_OPENER.open(f"{OLLAMA_URL}/api/tags", timeout=3)
        return True, None
    except (urllib.error.URLError, OSError) as e:
        return False, str(e)


def list_models() -> list[str]:
    try:
        with _NO_PROXY_OPENER.open(f"{OLLAMA_URL}/api/tags", timeout=3) as resp:
            data = json.loads(resp.read())
            return [m["name"] for m in data.get("models", [])]
    except (urllib.error.URLError, OSError, json.JSONDecodeError):
        return []


def _call_ollama(model: str, system: str, user_message: str) -> str:
    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_message},
        ],
        "stream": False,
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat", data=payload,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with _NO_PROXY_OPENER.open(req, timeout=60) as resp:
        data = json.loads(resp.read())
        return data.get("message", {}).get("content", "")


def _parse_filter_json(raw: str) -> dict:
    # Models sometimes wrap JSON in ```json fences despite instructions —
    # strip those defensively rather than failing the whole query.
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
    text = text.strip()
    return json.loads(text)


ALLOWED_CATEGORIES = {
    "video", "image", "audio", "document", "spreadsheet", "presentation",
    "archive", "installer", "code", "database", "font", "system", "other",
}
ALLOWED_CLASSIFICATIONS = {"KEEP", "REVIEW", "ARCHIVE", "DELETE_CANDIDATE", "QUARANTINED"}
ALLOWED_SORT = {"size_desc", "size_asc", "age_desc", "age_asc"}


def _validate_filter(f: dict) -> dict:
    """Whitelist every field — anything unexpected or out-of-range is
    dropped rather than trusted, since this dict drives a real SQL query."""
    clean = {}
    if f.get("category") in ALLOWED_CATEGORIES:
        clean["category"] = f["category"]
    for key in ("min_size_mb", "max_size_mb"):
        v = f.get(key)
        if isinstance(v, (int, float)) and v >= 0:
            clean[key] = float(v)
    for key in ("min_age_days", "max_age_days"):
        v = f.get(key)
        if isinstance(v, (int, float)) and v >= 0:
            clean[key] = int(v)
    if f.get("classification") in ALLOWED_CLASSIFICATIONS:
        clean["classification"] = f["classification"]
    if isinstance(f.get("name_contains"), str) and 0 < len(f["name_contains"]) <= 200:
        clean["name_contains"] = f["name_contains"]
    clean["sort_by"] = f.get("sort_by") if f.get("sort_by") in ALLOWED_SORT else "size_desc"
    limit = f.get("limit", 25)
    clean["limit"] = min(max(int(limit), 1), 200) if isinstance(limit, (int, float)) else 25
    return clean


def _execute_filter(filt: dict, drive: str | None) -> list[dict]:
    filters = ["is_missing = 0"]
    params: list = []

    if drive:
        filters.append("drive = ?")
        params.append(drive)
    if "category" in filt:
        filters.append("category = ?")
        params.append(filt["category"])
    if "min_size_mb" in filt:
        filters.append("size >= ?")
        params.append(filt["min_size_mb"] * 1024 * 1024)
    if "max_size_mb" in filt:
        filters.append("size <= ?")
        params.append(filt["max_size_mb"] * 1024 * 1024)
    if "min_age_days" in filt:
        filters.append("julianday('now') - julianday(modified_at) >= ?")
        params.append(filt["min_age_days"])
    if "max_age_days" in filt:
        filters.append("julianday('now') - julianday(modified_at) <= ?")
        params.append(filt["max_age_days"])
    if "classification" in filt:
        filters.append("classification = ?")
        params.append(filt["classification"])
    if "name_contains" in filt:
        filters.append("name LIKE ?")
        params.append(f"%{filt['name_contains']}%")

    sort_map = {
        "size_desc": "size DESC", "size_asc": "size ASC",
        "age_desc": "modified_at ASC", "age_asc": "modified_at DESC",
    }
    order = sort_map[filt["sort_by"]]
    params.append(filt["limit"])

    query = f"""
        SELECT id, path, name, size, category, modified_at, classification
        FROM files WHERE {' AND '.join(filters)}
        ORDER BY {order} LIMIT ?
    """
    db.init_db()
    with db.get_connection() as conn:
        rows = conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]


def run_query(question: str, model: str, drive: str | None = None) -> dict:
    if not check_ollama_running():
        return {
            "status": "error",
            "error": "Ollama isn't running. Start the Ollama app, then try again.",
        }

    try:
        raw = _call_ollama(model, FILTER_SCHEMA_PROMPT, question)
        filt = _validate_filter(_parse_filter_json(raw))
    except (json.JSONDecodeError, urllib.error.URLError, OSError, KeyError) as e:
        return {"status": "error", "error": f"Couldn't interpret that request: {e}"}

    results = _execute_filter(filt, drive)
    return {"status": "ok", "interpreted_filter": filt, "results": results, "result_count": len(results)}


def main():
    parser = argparse.ArgumentParser(description="DriveGuardian AI query interpreter")
    sub = parser.add_subparsers(dest="command", required=True)

    status_p = sub.add_parser("status", help="Check Ollama availability + list models")

    q_p = sub.add_parser("query", help="Run a natural language query")
    q_p.add_argument("--question", required=True)
    q_p.add_argument("--model", required=True)
    q_p.add_argument("--drive", default=None)

    args = parser.parse_args()

    if args.command == "status":
        running, error = check_ollama_running_verbose()
        print(json.dumps({"running": running, "models": list_models() if running else [], "error": error}))
    elif args.command == "query":
        print(json.dumps(run_query(args.question, args.model, args.drive)))


if __name__ == "__main__":
    main()
