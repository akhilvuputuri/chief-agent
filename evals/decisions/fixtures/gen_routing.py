"""Builds routing.json from the picker scenarios: which single agent can handle a message?

Gold is one agent type from Chief's catalogue, or "chief" when Chief must handle it itself
(small talk, memory, several agents at once, canvases, background work, skills, job fit and
preparation). Splits are kept from the picker eval.

Run: python3 evals/decisions/fixtures/gen_routing.py
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCENARIOS = HERE.parents[1] / "picker" / "scenarios.json"

AGENT = {
    "gmail": "email",
    "calendar": "calendar",
    "daily": "daily",
    "routines": "daily",
    "jobs": "jobs",
    "research": "research",
    "media": "media",
    "parcels": "parcels",
    "library": "library",
    "watchlist": "stocks",
    "news": "news",
}
# Domains the coordinator keeps; a message needing one is Chief's to handle.
CHIEF = {"canvas", "work", "skills"}
# Unlabelled public-web questions now go to the web agent.
WEB = {"none-6", "none-7", "res-4", "t-none-8", "t-res-3"}
# Job fit, preparation and the prep Sheet stay on Chief (job alignment is Chief's workflow).
JOB_ALIGNMENT = {"jobs-1", "jobs-5", "jobs-6", "jobs-7", "t-jobs-3", "fu-5"}


def gold(scenario: dict) -> str:
    if scenario["id"] in WEB:
        return "web"
    if scenario["id"] in JOB_ALIGNMENT:
        return "chief"
    domains = set(scenario["gold"])
    if not domains or domains & CHIEF:
        return "chief"
    agents = {AGENT[d] for d in domains}
    return agents.pop() if len(agents) == 1 else "chief"


def main() -> None:
    cases = [
        {
            "id": s["id"],
            "split": s["split"],
            "message": s["message"],
            "prior": s.get("prior", []),
            "gold": gold(s),
        }
        for s in json.loads(SCENARIOS.read_text(encoding="utf-8"))
    ]
    (HERE / "routing.json").write_text(json.dumps(cases, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    counts: dict[str, int] = {}
    for c in cases:
        counts[c["gold"]] = counts.get(c["gold"], 0) + 1
    print(len(cases), "cases", dict(sorted(counts.items())))


if __name__ == "__main__":
    main()
