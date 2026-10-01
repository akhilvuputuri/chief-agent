"""Decision backends: Jev on OpenRouter's decisions API and a small chat model.

Each call returns one record with the answer, latency, reported cost and any error.
Failures are results, not exceptions: an eval must see how often a backend fails.
"""

from __future__ import annotations

import http.client
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

DECISIONS = "https://openrouter.ai/api/alpha/decisions"
CHAT = "https://openrouter.ai/api/v1/chat/completions"
JEV = "typesafe/jev-1.13-20260917"
FLASH = "google/gemini-3.8-flash"


def api_key(env_file: str = ".env") -> str | None:
    """OPENROUTER_API_KEY from the environment, else from KEY=VALUE lines in env_file."""
    if os.environ.get("OPENROUTER_API_KEY"):
        return os.environ["OPENROUTER_API_KEY"]
    path = Path(env_file)
    if not path.is_file():
        return None
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        key, sep, value = line.partition("=")
        if sep and key.strip() == "OPENROUTER_API_KEY":
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            return value or None
    return None


def _post(url: str, key: str, body: dict[str, Any], timeout: float) -> tuple[dict[str, Any] | None, str | None, int]:
    """One request; a provider rate limit (429) is retried with backoff because it measures
    the harness's request rate, not the backend. Latency is the final attempt's."""
    for attempt in range(6):
        payload, error, latency = _post_once(url, key, body, timeout)
        if not (error and error.startswith("HTTP 429")) or attempt == 5:
            return payload, error, latency
        time.sleep(2 * 2**attempt)
    return payload, error, latency


def _post_once(url: str, key: str, body: dict[str, Any], timeout: float) -> tuple[dict[str, Any] | None, str | None, int]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return payload, None, round((time.monotonic() - started) * 1000)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:300]
        return None, f"HTTP {error.code}: {detail}", round((time.monotonic() - started) * 1000)
    except (OSError, http.client.HTTPException) as error:
        return None, f"{type(error).__name__}: {error}", round((time.monotonic() - started) * 1000)
    except ValueError:
        return None, "response is not JSON", round((time.monotonic() - started) * 1000)


def jev(
    key: str,
    state: dict[str, Any],
    questions: dict[str, dict[str, Any]],
    *,
    model: str = JEV,
    timeout: float = 6.0,
) -> dict[str, Any]:
    """One decisions request. Returns answers keyed by question name."""
    payload, error, latency = _post(
        DECISIONS, key, {"model": model, "state": state, "questions": questions}, timeout
    )
    record: dict[str, Any] = {"latency_ms": latency, "error": error, "answers": None, "cost": None, "model": None}
    if error:
        return record
    answers = payload.get("answers") if isinstance(payload, dict) else None
    if not isinstance(answers, dict):
        record["error"] = "response has no answers object"
        return record
    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    record.update(answers=answers, cost=usage.get("cost"), model=payload.get("model"))
    return record


def chat_json(
    key: str,
    system: str,
    user: str,
    *,
    model: str = FLASH,
    timeout: float = 20.0,
) -> dict[str, Any]:
    """One chat completion that must answer with a single JSON object."""
    payload, error, latency = _post(
        CHAT,
        key,
        {
            "model": model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "response_format": {"type": "json_object"},
            # Flash requires reasoning; the lowest effort keeps it a quick classifier.
            "reasoning": {"effort": "low"},
            "max_tokens": 1200,
            "temperature": 0,
            "usage": {"include": True},
        },
        timeout,
    )
    record: dict[str, Any] = {"latency_ms": latency, "error": error, "answer": None, "cost": None, "model": None}
    if error:
        return record
    try:
        content = payload["choices"][0]["message"]["content"]
        match = re.search(r"\{.*\}", content, re.S)
        record["answer"] = json.loads(match.group(0) if match else content)
    except (KeyError, IndexError, TypeError, ValueError):
        record["error"] = "unparseable answer"
    usage = payload.get("usage") if isinstance(payload, dict) else None
    record["cost"] = usage.get("cost") if isinstance(usage, dict) else None
    record["model"] = payload.get("model") if isinstance(payload, dict) else None
    return record
