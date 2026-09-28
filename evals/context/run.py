#!/usr/bin/env python3
"""Context recall eval for Chief (manual; the answer mode is paid).

Replays synthetic multi-topic conversations through the real context pipeline
(evals/context/replay.ts) and scores, per probe slice:
  - visible: every evidence string is in the model's first-call input;
  - correct (answer mode): the reply matches an accept pattern and no reject pattern;
  - confused (answer mode): the reply matches a known-confusion reject pattern;
  - searched: the model called conversation_search/conversation_read/observation_read.

Usage:
  npm run eval:context                      # context mode, free
  npm run eval:context -- --mode answer     # real model answers (~$0.02-0.05 per probe)
  npm run eval:context -- --probe wedding-mixup/3
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import statistics
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SEARCH_TOOLS = {"conversation_search", "conversation_read", "observation_read"}


def read_env_key(path: Path) -> str | None:
    if not path.is_file():
        return None
    for line in path.read_text().splitlines():
        line = line.strip().removeprefix("export ").strip()
        if line.startswith("OPENROUTER_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"") or None
    return None


def grade(row: dict) -> dict:
    reply = row.get("reply") or ""
    matches = lambda patterns: any(re.search(p, reply, re.I) for p in patterns)
    visible = all(v == "context" for v in row["evidence"].values())
    reachable = all(v in ("context", "pointer") for v in row["evidence"].values())
    out = {"visible": visible, "reachable": reachable, "searched": bool(SEARCH_TOOLS & set(row["toolCalls"]))}
    if row["mode"] == "answer":
        # Every accept pattern must match. A reply that also matches a known confusion is
        # "hedged", counted apart from correct (it may only be contrast: "3,450, up from 3,200").
        answered = bool(row["accept"]) and all(re.search(p, reply, re.I) for p in row["accept"])
        rejected = matches(row["reject"])
        out["correct"] = answered and not rejected
        out["hedged"] = answered and rejected
        out["confused"] = rejected and not answered
    return out


def pct(values: list[bool]) -> str:
    return f"{100 * sum(values) / len(values):.0f}% ({sum(values)}/{len(values)})" if values else "-"


def summarise(rows: list[dict]) -> str:
    answer = rows and rows[0]["mode"] == "answer"
    by_slice: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        by_slice[row["slice"]].append(row)
    by_slice["all"] = rows
    head = "| Slice | Probes | Evidence visible | One read away |" + (" Correct | Hedged | Confused | Searched |" if answer else "")
    lines = [head, "|" + " --- |" * (8 if answer else 4)]
    for name in [*sorted(k for k in by_slice if k != "all"), "all"]:
        group = by_slice[name]
        g = [r["grade"] for r in group]
        cells = [name, str(len(group)), pct([x["visible"] for x in g]), pct([x["reachable"] for x in g])]
        if answer:
            cells += [pct([x[k] for x in g]) for k in ("correct", "hedged", "confused", "searched")]
        lines.append("| " + " | ".join(cells) + " |")
    sizes = [r["sizes"] for r in rows if r["sizes"]["fixed"] is not None]
    lines += [
        "",
        f"Median fixed characters {statistics.median(s['fixed'] for s in sizes):,.0f}; "
        f"median serialized {statistics.median(s['serialized'] for s in sizes):,.0f}; "
        f"median omitted messages {statistics.median(s['omitted'] for s in sizes):,.0f}.",
    ]
    if answer:
        lines.append(f"Total cost ${sum(r['costUsd'] for r in rows):.4f}; median latency {statistics.median(r['latencyMs'] for r in rows) / 1000:.1f} s.")
    misses = [r for r in rows if not r["grade"]["visible"] or (answer and not r["grade"]["correct"])]
    if misses:
        lines += ["", "Probes not visible" + (" or not answered correctly" if answer else "") + ":"]
        for r in misses:
            absent = [k for k, v in r["evidence"].items() if v != "context"]
            detail = f"absent {absent}" if absent else "visible"
            if answer:
                verdict = next((k for k in ("correct", "hedged", "confused") if r["grade"][k]), "wrong")
                detail += f"; {verdict}; tools {r['toolCalls']}"
            lines.append(f"- {r['probe']} ({r['slice']}): {detail}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mode", choices=["context", "answer"], default="context")
    parser.add_argument("--probe")
    parser.add_argument("--fixtures")
    parser.add_argument("--model")
    parser.add_argument("--env-file", default=".env")
    parser.add_argument("--out")
    args = parser.parse_args()

    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = Path(args.out) if args.out else REPO / "eval-results" / f"context-{args.mode}-{stamp}"
    out.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    if args.mode == "answer" and not env.get("OPENROUTER_API_KEY"):
        key = read_env_key(Path(args.env_file))
        if not key:
            print("answer mode needs OPENROUTER_API_KEY (environment or --env-file)", file=sys.stderr)
            return 2
        env["OPENROUTER_API_KEY"] = key
    command = ["npx", "tsx", "evals/context/replay.ts", "--mode", args.mode, "--out", str(out / "rows.jsonl")]
    for flag in ("probe", "fixtures", "model"):
        if getattr(args, flag):
            command += [f"--{flag}", getattr(args, flag)]
    subprocess.run(command, cwd=REPO, env=env, check=True)

    rows = [json.loads(line) for line in (out / "rows.jsonl").read_text().splitlines() if line.strip()]
    for row in rows:
        row["grade"] = grade(row)
    revision = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO, capture_output=True, text=True).stdout.strip()
    summary = f"# Context recall eval\n\nMode {args.mode}, {len(rows)} probes, revision {revision[:12] or 'unknown'}.\n\n{summarise(rows)}\n"
    (out / "report.md").write_text(summary)
    (out / "rows.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    print(summary)
    print(f"Wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
