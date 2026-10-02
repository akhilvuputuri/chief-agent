"""Tool-group picker contract shared with the TypeScript runtime.

One Jev "noul" question per tool group; groups whose probability clears the
threshold are loaded. Everything here is pure: no network, no secrets.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

DOMAINS = (
    "gmail",
    "calendar",
    "daily",
    "jobs",
    "work",
    "research",
    "media",
    "canvas",
    "subscriptions",
    "parcels",
    "library",
    "watchlist",
    "news",
    "routines",
    "responsibilities",
    "skills",
)


def _number(value: Any) -> bool:
    # bool is an int subclass in Python; it is never a probability or setting.
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(f"tool-picker config: {message}")


def load_config(path: str | Path) -> dict[str, Any]:
    """Read and validate the keys the picker uses."""
    try:
        config = json.loads(Path(path).read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"tool-picker config: invalid JSON ({error})") from error
    _require(isinstance(config, dict), "must be an object")
    _require(
        isinstance(config.get("model"), str) and config["model"] != "",
        "model must be a non-empty string",
    )
    for key in ("threshold", "fallbackMin"):
        _require(
            _number(config.get(key)) and 0 <= config[key] <= 1,
            f"{key} must be a number from 0 to 1",
        )
    _require(
        isinstance(config.get("cap"), int)
        and not isinstance(config["cap"], bool)
        and config["cap"] >= 1,
        "cap must be a positive integer",
    )
    _require(
        _number(config.get("timeoutMs")) and config["timeoutMs"] > 0,
        "timeoutMs must be a positive number",
    )
    state = config.get("state")
    _require(isinstance(state, dict), "state must be an object")
    for key in ("previousTurns", "messageChars", "previousUserChars", "assistantChars"):
        value = state.get(key)
        _require(
            isinstance(value, int) and not isinstance(value, bool) and value >= 0,
            f"state.{key} must be a non-negative integer",
        )
    question = config.get("question")
    _require(isinstance(question, dict), "question must be an object")
    for key in ("instructions", "true", "false"):
        _require(
            isinstance(question.get(key), str), f"question.{key} must be a string"
        )
    _require(
        isinstance(config.get("alwaysAvailable"), str),
        "alwaysAvailable must be a string",
    )
    domains = config.get("domains")
    _require(isinstance(domains, dict), "domains must be an object")
    _require(
        tuple(domains) == DOMAINS,
        f"domains must be exactly {', '.join(DOMAINS)} in that order",
    )
    for name, domain in domains.items():
        _require(isinstance(domain, dict), f"domains.{name} must be an object")
        for key in ("description", "examples"):
            _require(
                isinstance(domain.get(key), str),
                f"domains.{name}.{key} must be a string",
            )
    return config


def clip(text: str, n: int) -> str:
    """First n Unicode code points (not UTF-16 units)."""
    return text[:n]


def _unique(items: list[str]) -> list[str]:
    return list(dict.fromkeys(items))


def build_state(
    config: dict[str, Any],
    message: str,
    previous: list[dict[str, Any]],
    pending_approvals: list[str],
    active_task: str | None,
    recent_tools: list[str],
) -> dict[str, Any]:
    """The Jev state object; key order is part of the contract."""
    limits = config["state"]
    kept = previous[max(0, len(previous) - limits["previousTurns"]) :]
    return {
        "latest_user_message": clip(message, limits["messageChars"]),
        "previous_turns": [
            {
                "user": clip(turn["user"], limits["previousUserChars"]),
                "assistant": clip(turn["assistant"], limits["assistantChars"]),
                "tools_used": list(turn.get("tools", [])),
            }
            for turn in kept
        ],
        "pending_approvals": list(pending_approvals),
        "active_background_task": active_task,
        "tools_used_last_hour": _unique(list(recent_tools)),
        "always_available": config["alwaysAvailable"],
    }


def build_questions(
    config: dict[str, Any], domains: list[str] | set[str]
) -> dict[str, dict[str, Any]]:
    """One noul question per requested domain, in canonical order."""
    question = config["question"]
    wanted = set(domains)
    questions: dict[str, dict[str, Any]] = {}
    for domain, info in config["domains"].items():
        if domain not in wanted:
            continue
        questions[domain] = {
            "type": "noul",
            "instructions": question["instructions"].replace("{domain}", domain),
            "criteria": {
                "true": question["true"]
                .replace("{description}", info["description"])
                .replace("{examples}", info["examples"]),
                "false": question["false"],
            },
        }
    return questions


def pick(
    probabilities: dict[str, Any],
    config: dict[str, Any],
    domains: list[str] | set[str],
) -> list[str]:
    """Groups to load: >= threshold (at most cap), else the best above fallbackMin."""
    order = {domain: i for i, domain in enumerate(config["domains"])}
    wanted = set(domains)
    scored = sorted(
        (
            (value, domain)
            for domain, value in probabilities.items()
            if domain in wanted and domain in order and _number(value)
        ),
        key=lambda item: (-item[0], order[item[1]]),
    )
    chosen = [domain for value, domain in scored if value >= config["threshold"]]
    if chosen:
        return chosen[: config["cap"]]
    if scored and scored[0][0] >= config["fallbackMin"]:
        return [scored[0][1]]
    return []


def scenario_request(
    config: dict[str, Any], scenario: dict[str, Any], domains: list[str] | set[str]
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    """(state, questions) for one labelled scenario."""
    signals = scenario.get("signals", {})
    state = build_state(
        config,
        scenario["message"],
        scenario.get("prior", []),
        signals.get("pending_approvals", []),
        signals.get("active_background_task"),
        signals.get("tools_used_last_hour", []),
    )
    return state, build_questions(config, domains)
