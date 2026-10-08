"""Read-only repository navigation with bounded argv execution and safe paths."""

from __future__ import annotations

import fnmatch
import hashlib
import json
from typing import Any

from .protocol import Json, validate_path
from .workspace import Workspace


class InspectionError(ValueError):
    def __init__(self, code: str, hint: str) -> None:
        super().__init__(hint)
        self.code, self.hint = code, hint


def matches(path: str, pattern: str) -> bool:
    return fnmatch.fnmatchcase(path, pattern) or (
        pattern.startswith("**/") and fnmatch.fnmatchcase(path, pattern[3:])
    )


async def paths(workspace: Workspace, pattern: str) -> list[str]:
    result = await workspace.command(
        "git", ["ls-files", "-co", "--exclude-standard", "-z"], max_output=500000
    )
    if result.exit_code or result.truncated:
        raise InspectionError(
            "listing_too_large",
            "Narrow the repository task; the path inventory exceeded its supported bound.",
        )
    selected = []
    for value in sorted(set(result.text().split("\0"))):
        if not value or not matches(value, pattern):
            continue
        try:
            validate_path(value)
            p = workspace.path(value)
            if p.is_file():
                selected.append(value)
        except (ValueError, OSError):
            continue
    return selected


async def glob(workspace: Workspace, pattern: str, offset: int, limit: int) -> Json:
    values = await paths(workspace, pattern)
    page = values[offset : offset + limit]
    return {
        "paths": page,
        "nextOffset": offset + len(page) if offset + len(page) < len(values) else None,
        "total": len(values),
    }


async def grep(
    workspace: Workspace,
    pattern: str,
    file_glob: str,
    offset: int,
    limit: int,
    regex: bool,
    case_sensitive: bool,
) -> Json:
    selected = await paths(workspace, file_glob)
    if len(selected) > 1000:
        raise InspectionError(
            "search_scope_too_large",
            "Narrow the glob to at most 1,000 repository files.",
        )
    if not selected:
        return {"matches": [], "nextOffset": None, "total": 0}
    args = [
        "--json",
        "--max-count",
        "100",
        "--max-columns",
        "1000",
        "--max-columns-preview",
    ]
    if not regex:
        args.append("--fixed-strings")
    if not case_sensitive:
        args.append("--ignore-case")
    result = await workspace.command(
        "rg", [*args, "--", pattern, *selected], timeout_seconds=15, max_output=500000
    )
    if result.truncated:
        raise InspectionError(
            "search_results_too_large",
            "Narrow the pattern or glob; search output exceeded its bound.",
        )
    if result.exit_code not in (0, 1):
        raise InspectionError(
            "search_failed",
            "Check the regex or use a literal pattern and a narrower glob; grep requires ripgrep.",
        )
    found: list[Json] = []
    for line in result.text().splitlines():
        try:
            item = json.loads(line)
            if item.get("type") != "match":
                continue
            data = item["data"]
            path, text = data["path"].get("text"), data["lines"].get("text")
            if path not in selected or not isinstance(text, str):
                continue
            found.append(
                {"path": path, "line": data["line_number"], "text": text[:1000]}
            )
        except (KeyError, ValueError, TypeError):
            raise InspectionError(
                "invalid_search_output", "Retry a narrower literal search."
            ) from None
    page = found[offset : offset + limit]
    return {
        "matches": page,
        "nextOffset": offset + len(page) if offset + len(page) < len(found) else None,
        "total": len(found),
        "perFileMatchLimit": 100,
        "notice": "At most 100 matching lines per file are scanned; narrow a file or pattern if more are needed.",
    }


async def read(
    workspace: Workspace,
    path: str,
    offset: int,
    limit: int,
    start_line: int | None,
    end_line: int | None,
) -> dict[str, Any]:
    p = workspace.path(path)
    if not p.is_file():
        raise InspectionError(
            "not_a_file", "Use glob to discover regular repository files."
        )
    if p.stat().st_size > 2000000:
        raise InspectionError(
            "file_too_large",
            "Use grep to find a small relevant section; this file exceeds the bounded reader.",
        )
    raw = p.read_bytes()
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeError:
        raise InspectionError(
            "binary_file", "Read a UTF-8 source file instead."
        ) from None
    if "\0" in text:
        raise InspectionError("binary_file", "Read a UTF-8 source file instead.")
    stop = len(text)
    if start_line is not None:
        lines = text.splitlines(keepends=True)
        if start_line > max(1, len(lines)):
            raise InspectionError(
                "invalid_range",
                "Choose a line within the file or search with grep first.",
            )
        offset = sum(map(len, lines[: start_line - 1]))
        stop = sum(map(len, lines[:end_line])) if end_line is not None else len(text)
    if offset > len(text):
        raise InspectionError(
            "invalid_range",
            "Use the returned nextOffset; this offset is beyond the file.",
        )
    page = text[offset : min(stop, offset + limit)]
    end = offset + len(page)
    return {
        "text": page,
        "nextOffset": end if end < stop else None,
        "fingerprint": hashlib.sha256(raw).hexdigest(),
        "start": offset,
        "end": end,
        "unit": "characters",
        "lineStart": text[:offset].count("\n") + 1,
        "lineEnd": text[:end].count("\n") + (0 if page.endswith("\n") else 1),
        "notice": "Offsets are Unicode characters. A nextOffset continues file content; line ranges select the initial section. The fingerprint identifies these source bytes.",
    }
