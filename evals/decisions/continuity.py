"""Decision 1: does the latest message need the previous exchange?

Today Chief always keeps the previous exchange in context. A backend that can tell a new
topic from a follow-up lets Chief drop it, saving its characters, but a wrong drop loses
context the answer needed. So recall on follow-ups is the safety metric and characters
saved on standalone messages is the gain.
"""

from __future__ import annotations

import re
from typing import Any

import backends

NAME = "continuity"
FIXTURES = "continuity.json"

JEV_QUESTION = {
    "needs_previous": {
        "type": "noul",
        "instructions": "Does answering `latest_user_message` correctly require the previous exchange (`previous_user_message` and `previous_assistant_reply`)?",
        "criteria": {
            "true": "It refers back to the previous exchange: a pronoun or 'the other one', an answer to the assistant's question, a correction or change to what was just done, 'and…' or 'what about…' continuing the same subject, or a question about details just given.",
            "false": "It stands on its own: a new request or question that names its own subject, small talk, or a request in the same area that does not depend on what was just said.",
        },
    }
}

LLM_SYSTEM = """You decide whether a personal assistant needs the previous exchange to answer the user's latest message.
Answer true when the latest message refers back to it: a pronoun or "the other one", an answer to the assistant's question, a correction or change to what was just done, "and..." or "what about..." continuing the same subject, or a question about details just given.
Answer false when it stands on its own: a new request or question naming its own subject, small talk, or a request in the same area that does not depend on what was just said.
Reply with JSON only: {"needs_previous": true|false, "confidence": number from 0 to 1}"""

# Word cues for the rule baseline: references back, continuations and very short replies.
CUES = re.compile(
    r"\b(it|its|that|those|them|this one|the (first|other|second|last) one|which one|again|too|also|instead|then|same|"
    r"either|both|there|he|she|they|his|her|their|why|source|sources|more)\b|^(and|also|ok|okay|yes|no|actually|what about|how about|make it|make that)\b",
    re.I,
)


def state(case: dict[str, Any]) -> dict[str, Any]:
    return {
        "previous_user_message": case["previous"]["user"][:500],
        "previous_assistant_reply": case["previous"]["assistant"][:600],
        "latest_user_message": case["message"][:2000],
    }


def rule(case: dict[str, Any]) -> dict[str, Any]:
    message = case["message"].strip()
    words = len(message.split())
    needs = bool(CUES.search(message)) or words <= 3
    return {"probability": 1.0 if needs else 0.0, "latency_ms": 0, "cost": 0.0, "error": None}


def keep(case: dict[str, Any]) -> dict[str, Any]:
    return {"probability": 1.0, "latency_ms": 0, "cost": 0.0, "error": None}


def jev(case: dict[str, Any], key: str) -> dict[str, Any]:
    r = backends.jev(key, state(case), JEV_QUESTION)
    answer = (r["answers"] or {}).get("needs_previous") if not r["error"] else None
    p = answer.get("noul") if isinstance(answer, dict) else None
    return {
        "probability": p if isinstance(p, (int, float)) else None,
        "latency_ms": r["latency_ms"],
        "cost": r["cost"],
        "error": r["error"] or (None if p is not None else "no needs_previous answer"),
        "model": r["model"],
    }


def flash(case: dict[str, Any], key: str) -> dict[str, Any]:
    s = state(case)
    user = (
        f"Previous user message: {s['previous_user_message']}\n"
        f"Previous assistant reply: {s['previous_assistant_reply']}\n"
        f"Latest user message: {s['latest_user_message']}"
    )
    r = backends.chat_json(key, LLM_SYSTEM, user)
    p = None
    if not r["error"] and isinstance(r["answer"], dict):
        needs = r["answer"].get("needs_previous")
        confidence = r["answer"].get("confidence", 1)
        if isinstance(needs, bool) and isinstance(confidence, (int, float)):
            confidence = min(1.0, max(0.0, float(confidence)))
            p = confidence if needs else 1 - confidence
    return {
        "probability": p,
        "latency_ms": r["latency_ms"],
        "cost": r["cost"],
        "error": r["error"] or (None if p is not None else "unparseable answer"),
        "model": r["model"],
    }


BACKENDS = {"keep": keep, "rule": rule, "jev": jev, "flash": flash}
PAID = {"jev", "flash"}


def label(case: dict[str, Any]) -> bool:
    return case["needs_previous"]


def gain(case: dict[str, Any]) -> float:
    """Characters avoided when the previous exchange is dropped for this case."""
    return float(case["previous"]["chars"])
