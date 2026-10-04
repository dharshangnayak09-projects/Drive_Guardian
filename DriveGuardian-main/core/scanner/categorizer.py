"""File categorization by extension. Simple lookup table for Phase 1.
Later phases can replace this with content-aware / ML classification."""

CATEGORY_MAP = {
    "video": {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v"},
    "image": {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg", ".heic", ".tiff"},
    "audio": {".mp3", ".wav", ".flac", ".aac", ".ogg", ".wma", ".m4a"},
    "document": {".pdf", ".doc", ".docx", ".txt", ".rtf", ".odt", ".md"},
    "spreadsheet": {".xls", ".xlsx", ".csv", ".ods"},
    "presentation": {".ppt", ".pptx", ".odp"},
    "archive": {".zip", ".rar", ".7z", ".tar", ".gz", ".iso", ".bz2"},
    "installer": {".exe", ".msi", ".msix", ".appx"},
    "code": {".py", ".js", ".ts", ".tsx", ".jsx", ".rs", ".java", ".c", ".cpp",
             ".h", ".cs", ".go", ".rb", ".php", ".html", ".css", ".json", ".yaml", ".yml"},
    "database": {".db", ".sqlite", ".sqlite3", ".sql"},
    "font": {".ttf", ".otf", ".woff", ".woff2"},
    "system": {".dll", ".sys", ".log", ".tmp", ".cache"},
}

EXT_TO_CATEGORY = {ext: cat for cat, exts in CATEGORY_MAP.items() for ext in exts}


def categorize(extension: str) -> str:
    if not extension:
        return "other"
    return EXT_TO_CATEGORY.get(extension.lower(), "other")
