"""Paired evaluation of decision backends on labelled fixtures.

Run: npm run eval:decisions -- continuity [--runs 3] [--backends keep,rule,jev,flash]
Paid backends (Jev, Flash) call OpenRouter with OPENROUTER_API_KEY.

Method (see README.md):
- Every backend answers the same cases, so comparisons are paired.
- Production makes one decision call per message, so every call is scored on its own;
  --runs repeats each case to add samples and show run-to-run spread.
- A threshold is chosen on tuning calls only, under a safety bar, and every reported
  number is on held-out calls.
- Intervals resample whole clusters (a conversation, or a case's repeated calls), and
  backend differences use an exact McNemar test on per-case majority correctness.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
import backends as backend_api  # noqa: E402


def collect(decision, backend: str, cases: list[dict[str, Any]], runs: int, key: str | None, concurrency: int):
    fn = decision.BACKENDS[backend]
    paid = backend in decision.PAID
    jobs = [(case, run) for run in range(runs if paid else 1) for case in cases]

    def one(job):
        case, run = job
        record = fn(case, key) if paid else fn(case)
        return {"id": case["id"], "run": run, **record}

    with ThreadPoolExecutor(max_workers=concurrency if paid else 1) as pool:
        return list(pool.map(one, jobs))


def harness_hash() -> str:
    """Content hash of the harness and fixtures, so a report names the exact code that made it."""
    digest = hashlib.sha256()
    # Production inputs a decision reads (agent definitions, word cues) are part of the fingerprint.
    files = [
        *HERE.glob("*.py"),
        *HERE.glob("*.ts"),
        *(HERE / "fixtures").glob("*"),
        ROOT / "plugins" / "core" / "plugin.json",
        ROOT / "plugins" / "public-research" / "plugin.json",
        ROOT / "src" / "tool-domains.ts",
        ROOT / "config" / "decisions.json",
    ]
    for path in sorted(p for p in files if p.is_file()):
        digest.update(str(path.relative_to(ROOT)).encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()[:16]


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate decision backends.")
    parser.add_argument("decision")
    parser.add_argument("--backends", help="comma-separated; default: every backend the decision defines")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--concurrency", type=int, default=3)
    parser.add_argument("--min-recall", type=float, default=1.0)
    parser.add_argument("--min-precision", type=float, default=1.0)
    parser.add_argument("--env-file", default=str(ROOT / ".env"))
    parser.add_argument("--out")
    parser.add_argument("--rescore", help="re-score the calls in a saved report instead of making new ones")
    args = parser.parse_args()
    decision = importlib.import_module(args.decision)
    cases = json.loads((HERE / "fixtures" / decision.FIXTURES).read_text(encoding="utf-8"))
    names = [b for b in args.backends.split(",") if b] if args.backends else list(decision.BACKENDS)
    key = backend_api.api_key(args.env_file)
    if any(b in decision.PAID for b in names) and not key and not args.rescore:
        sys.exit("OPENROUTER_API_KEY is required for paid backends")
    raw = {}
    if args.rescore:
        saved = json.loads(Path(args.rescore).read_text(encoding="utf-8"))
        raw = {name: saved["records"][name] for name in names}
        args.runs = saved["runs"]
    else:
        for name in names:
            raw[name] = collect(decision, name, cases, args.runs, key, args.concurrency)
            print(f"{name}: done", file=sys.stderr)
    results, comparisons, text = decision.evaluate(cases, raw, args)
    report = {
        "decision": decision.NAME,
        "at": datetime.now(timezone.utc).isoformat(),
        **({"rescored_from": Path(args.rescore).name} if args.rescore else {}),
        "revision": subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip(),
        "harness_sha256": harness_hash(),
        "runs": args.runs,
        "min_recall": args.min_recall,
        "min_precision": args.min_precision,
        "cases": {
            "tuning": sum(c["split"] == "tuning" for c in cases),
            "held_out": sum(c["split"] == "held-out" for c in cases),
        },
        "results": results,
        "comparisons": comparisons,
        "records": raw,
    }
    out = Path(args.out) if args.out else HERE / "results" / f"{decision.NAME}-{datetime.now().strftime('%Y%m%d-%H%M')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    print(text)
    print(f"\nFull report: {out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}")


if __name__ == "__main__":
    main()
