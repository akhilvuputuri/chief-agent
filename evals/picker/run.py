"""Live eval of the tool-group picker against Jev on OpenRouter.

Run by hand: npm run eval:picker -- [--runs 3] [--split held-out] ...
Each call asks all 13 groups; picked groups are scored against the labels.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import math
import os
import random
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from picker import DOMAINS, load_config, pick, scenario_request  # noqa: E402

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CONFIG = ROOT / "config" / "tool-picker.json"
SCENARIOS = HERE / "scenarios.json"
ENDPOINT = "https://openrouter.ai/api/alpha/decisions"
SPLITS = ("tuning", "held-out")


def parse_args(config: dict[str, Any]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate the tool-group picker.")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--split", choices=("all", *SPLITS), default="all")
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--floor", type=float, default=0.97)
    parser.add_argument("--env-file", default=".env")
    # Lenient: a slow answer still tells us what the picker would choose.
    parser.add_argument("--timeout", type=float, default=config["timeoutMs"] * 4 / 1000)
    parser.add_argument("--seed", type=int)
    parser.add_argument("--out")
    args = parser.parse_args()
    if args.runs < 1 or args.concurrency < 1 or args.timeout <= 0:
        parser.error("--runs, --concurrency and --timeout must be positive")
    return args


def api_key(env_file: str) -> str | None:
    """OPENROUTER_API_KEY from the environment, else from KEY=VALUE lines."""
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


def schema_sizes() -> dict[str, Any]:
    output = subprocess.run(
        ["npx", "tsx", "evals/picker/sizes.ts"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return json.loads(output.strip().splitlines()[-1])


def git_revision() -> str | None:
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def call(
    config: dict[str, Any], key: str, scenario: dict[str, Any], run: int, timeout: float
) -> dict[str, Any]:
    """One decisions request. No retries: failures are part of the result."""
    state, questions = scenario_request(config, scenario, DOMAINS)
    body = json.dumps({"model": config["model"], "state": state, "questions": questions})
    request = urllib.request.Request(
        ENDPOINT,
        data=body.encode("utf-8"),
        method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    record: dict[str, Any] = {
        "run": run,
        "id": scenario["id"],
        "split": scenario["split"],
        "gold": scenario["gold"],
        "status": None,
        "error": None,
        "latency_ms": None,
        "model": None,
        "cost": None,
        "input_tokens": None,
        "probabilities": None,
        "picked": None,
    }
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            record["status"] = response.status
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        record["status"] = error.code
        detail = error.read().decode("utf-8", "replace")[:300]
        record["error"] = f"HTTP {error.code}: {detail}"
    except (OSError, http.client.HTTPException) as error:
        record["error"] = f"{type(error).__name__}: {error}"
    except ValueError:
        record["error"] = "response is not JSON"
    record["latency_ms"] = round((time.monotonic() - started) * 1000)
    if record["error"]:
        return record
    answers = payload.get("answers") if isinstance(payload, dict) else None
    if not isinstance(answers, dict):
        record["error"] = "response has no answers object"
        return record
    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    record["model"] = payload.get("model")
    record["cost"] = usage.get("cost")
    record["input_tokens"] = usage.get("input_tokens")
    record["probabilities"] = {
        d: answers[d].get("noul") if isinstance(answers.get(d), dict) else None
        for d in DOMAINS
    }
    missing = [d for d, p in record["probabilities"].items() if p is None]
    if missing:
        # Every group is asked, so a partial answer is a contract failure.
        record["error"] = f"no answer for {', '.join(missing)}"
    record["picked"] = pick(record["probabilities"], config, DOMAINS)
    return record


def percentile(values: list[float], share: float) -> float | None:
    """Nearest-rank percentile."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(1, math.ceil(len(ordered) * share)) - 1]


def metrics(records: list[dict[str, Any]], sizes: dict[str, Any], runs: int) -> dict[str, Any]:
    ok = [r for r in records if not r["error"]]
    gold_total = sum(len(r["gold"]) for r in ok)
    hit_total = sum(len(set(r["gold"]) & set(r["picked"])) for r in ok)
    covered = sum(set(r["gold"]) <= set(r["picked"]) for r in ok)
    extra = sum(len(set(r["picked"]) - set(r["gold"])) for r in ok)
    chars = [sizes["core"] + sum(sizes["domains"][d] for d in r["picked"]) for r in ok]
    by_scenario: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in ok:
        by_scenario[r["id"]].append(r)
    unstable = sorted(
        sid
        for sid, rs in by_scenario.items()
        if len({tuple(sorted(r["picked"])) for r in rs}) > 1
    )
    misses: dict[str, dict[str, Any]] = {}
    for sid, rs in sorted(by_scenario.items()):
        counts: dict[str, int] = defaultdict(int)
        runs_missed = 0
        for r in rs:
            missing = [g for g in r["gold"] if g not in r["picked"]]
            runs_missed += bool(missing)
            for g in missing:
                counts[g] += 1
        if runs_missed:
            misses[sid] = {"missing": dict(counts), "runs_missed": runs_missed, "runs": len(rs)}
    latencies = [r["latency_ms"] for r in ok]
    costs = [r["cost"] for r in records if isinstance(r["cost"], (int, float))]
    average_chars = sum(chars) / len(chars) if chars else None
    return {
        "calls": len(records),
        "errors": len(records) - len(ok),
        "scenarios": len({r["id"] for r in records}),
        "recall": hit_total / gold_total if gold_total else None,
        "needed_groups": gold_total,
        "fully_covered": covered,
        "fully_covered_share": covered / len(ok) if ok else None,
        "extra_per_scenario": extra / len(ok) if ok else None,
        "average_schema_chars": average_chars,
        "average_schema_share": average_chars / sizes["full"] if chars else None,
        "unstable_scenarios": unstable if runs > 1 else [],
        "latency_p50_ms": percentile(latencies, 0.5),
        "latency_p95_ms": percentile(latencies, 0.95),
        "cost": sum(costs),
        "misses": misses,
        "models": sorted({str(r["model"]) for r in ok}),
    }


def fmt(value: Any, kind: str = "") -> str:
    if value is None:
        return "n/a"
    if kind == "pct":
        return f"{value * 100:.1f}%"
    if kind == "float":
        return f"{value:.2f}"
    if kind == "int":
        return f"{value:,.0f}"
    if kind == "cost":
        return f"${value:.5f}"
    return str(value)


def markdown(report: dict[str, Any]) -> str:
    sections = report["metrics"]
    names = list(sections)
    rows = [
        ("Calls", "calls", ""),
        ("Errors", "errors", ""),
        ("Recall of needed groups", "recall", "pct"),
        ("Fully covered calls", "fully_covered", ""),
        ("Fully covered share", "fully_covered_share", "pct"),
        ("Extra groups per call", "extra_per_scenario", "float"),
        ("Average schema chars", "average_schema_chars", "int"),
        ("Share of full schema", "average_schema_share", "pct"),
        ("Scenarios unstable across runs", "unstable_scenarios", "count"),
        ("Latency p50 ms", "latency_p50_ms", "int"),
        ("Latency p95 ms", "latency_p95_ms", "int"),
        ("Cost", "cost", "cost"),
    ]
    settings = report["settings"]
    lines = [
        "# Tool picker eval",
        "",
        f"Model {settings['model']}, {settings['runs']} run(s), split {settings['split']}, "
        f"seed {report['seed']}, floor {settings['floor']}.",
        f"Config sha256 {report['config_sha256'][:12]}, revision {report['git_revision'] or 'unknown'}.",
        f"Models reported: {', '.join(sections['pooled']['models']) or 'none'}.",
        "",
        "| Metric | " + " | ".join(names) + " |",
        "| --- |" + " --- |" * len(names),
    ]
    for label, key, kind in rows:
        cells = [
            str(len(sections[n][key])) if kind == "count" else fmt(sections[n][key], kind)
            for n in names
        ]
        lines.append(f"| {label} | " + " | ".join(cells) + " |")
    pooled = sections["pooled"]
    lines += ["", "## Misses", ""]
    if pooled["misses"]:
        for sid, miss in pooled["misses"].items():
            groups = ", ".join(f"{g} ({n}/{miss['runs']})" for g, n in miss["missing"].items())
            lines.append(f"- {sid}: {groups}")
    else:
        lines.append("None.")
    if pooled["unstable_scenarios"]:
        lines += ["", "## Unstable across runs", "", ", ".join(pooled["unstable_scenarios"])]
    errors = [r for r in report["records"] if r["error"]]
    if errors:
        lines += ["", "## Errors", ""]
        lines += [f"- run {r['run']} {r['id']}: {r['error']}" for r in errors[:20]]
        if len(errors) > 20:
            lines.append(f"- and {len(errors) - 20} more")
    lines += ["", f"Result: {report['result']}."]
    return "\n".join(lines) + "\n"


def main() -> int:
    config = load_config(CONFIG)
    args = parse_args(config)
    key = api_key(args.env_file)
    if not key:
        print(
            f"OPENROUTER_API_KEY is not set in the environment or {args.env_file}.",
            file=sys.stderr,
        )
        return 2
    seed = args.seed if args.seed is not None else random.SystemRandom().randrange(2**32)
    print(f"seed {seed}", flush=True)
    scenarios = json.loads(SCENARIOS.read_text(encoding="utf-8"))
    if args.split != "all":
        scenarios = [s for s in scenarios if s["split"] == args.split]
    sizes = schema_sizes()
    rng = random.Random(seed)
    records: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        for run in range(1, args.runs + 1):
            order = scenarios[:]
            rng.shuffle(order)
            records += pool.map(
                lambda s, run=run: call(config, key, s, run, args.timeout), order
            )
            failed = sum(bool(r["error"]) for r in records if r["run"] == run)
            print(f"run {run}/{args.runs}: {len(order)} calls, {failed} failed", flush=True)
    splits = SPLITS if args.split == "all" else (args.split,)
    sections = {
        split: metrics([r for r in records if r["split"] == split], sizes, args.runs)
        for split in splits
    }
    sections["pooled"] = metrics(records, sizes, args.runs)
    pooled = sections["pooled"]
    passed = pooled["errors"] == 0 and (pooled["recall"] or 0) >= args.floor
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = Path(args.out) if args.out else ROOT / "eval-results" / f"picker-{stamp}"
    report = {
        "settings": {
            "model": config["model"],
            "runs": args.runs,
            "split": args.split,
            "concurrency": args.concurrency,
            "floor": args.floor,
            "timeout_s": args.timeout,
            "threshold": config["threshold"],
            "cap": config["cap"],
            "fallbackMin": config["fallbackMin"],
            "endpoint": ENDPOINT,
        },
        "seed": seed,
        "config_sha256": hashlib.sha256(CONFIG.read_bytes()).hexdigest(),
        "git_revision": git_revision(),
        "sizes": sizes,
        "metrics": sections,
        "result": "pass" if passed else "fail",
        "records": records,
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    summary = markdown(report)
    (out / "report.md").write_text(summary, encoding="utf-8")
    print(summary)
    print(f"Wrote {out}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
