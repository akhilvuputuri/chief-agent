"""Reproduce the dated usage evidence from numeric exports, without credentials.

python3 analyze.py              # checks hashes/joins and writes summary.json
python3 analyze.py --chart      # also writes usage.png; requires matplotlib
"""

import argparse
import csv
import hashlib
import json
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent
METRICS = (
    "total_usage", "request_count", "tokens_prompt", "tokens_completion",
    "reasoning_tokens", "cached_tokens",
)
SOL = "GPT-5.6 Sol"


def load():
    metadata = json.loads((ROOT / "export-metadata.json").read_text())
    rows = {}
    expected = None
    for export in metadata["exports"]:
        path = ROOT / export["file"]
        assert hashlib.sha256(path.read_bytes()).hexdigest() == export["sha256"], path
        metric = path.stem.removeprefix("openrouter-")
        assert metric in METRICS
        seen = set()
        with path.open(newline="") as stream:
            reader = csv.DictReader(stream)
            assert reader.fieldnames == ["date__day", "model", metric]
            for row in reader:
                key = (row["date__day"], row["model"])
                date.fromisoformat(key[0])
                assert key not in seen, (path, key)
                seen.add(key)
                value = Decimal(row[metric])
                assert value.is_finite() and value >= 0
                if metric != "total_usage":
                    assert value == value.to_integral_value()
                rows.setdefault(key, {})[metric] = value
        assert len(seen) == export["rows"]
        if expected is None:
            expected = seen
        else:
            assert expected == seen, "Exports must have the same date/model keys"
    for row in rows.values():
        assert set(row) == set(METRICS)
        assert row["request_count"] > 0
        assert row["cached_tokens"] <= row["tokens_prompt"]
        # Reasoning is a subset of completion, never an extra addend.
        assert row["reasoning_tokens"] <= row["tokens_completion"]
    return rows


def aggregate(rows, start, end, model=None):
    selected = [r for (d, m), r in rows.items()
                if start <= d <= end and (model is None or m == model)]
    totals = {k: sum((r[k] for r in selected), Decimal(0)) for k in METRICS}
    days = Decimal((date.fromisoformat(end) - date.fromisoformat(start)).days + 1)
    n = totals["request_count"]
    prompt = totals["tokens_prompt"]
    totals.update({
        "days": int(days),
        "usd_per_day": totals["total_usage"] / days,
        "requests_per_day": n / days,
        "usd_per_request": totals["total_usage"] / n if n else None,
        "prompt_tokens_per_request": prompt / n if n else None,
        "cached_prompt_fraction": totals["cached_tokens"] / prompt if prompt else None,
    })
    return totals


def percent_decrease(before, after):
    return (1 - after / before) * 100 if before else None


def summarize(rows):
    windows = {
        "early_all": aggregate(rows, "2026-09-06", "2026-09-07"),
        "later_all": aggregate(rows, "2026-09-09", "2026-09-12"),
        "early_sol": aggregate(rows, "2026-09-06", "2026-09-07", SOL),
        "later_sol": aggregate(rows, "2026-09-09", "2026-09-12", SOL),
    }
    decreases = {}
    for group in ("all", "sol"):
        for metric in ("usd_per_day", "requests_per_day", "usd_per_request",
                       "prompt_tokens_per_request"):
            decreases[f"{group}_{metric}_percent_decrease"] = percent_decrease(
                windows[f"early_{group}"][metric], windows[f"later_{group}"][metric])
    days = [(date(2026, 9, 5) + timedelta(days=i)).isoformat() for i in range(9)]
    cutoff = json.loads((ROOT / "screenshot-cutoff.json").read_text(), parse_float=Decimal)
    later_charges = sum((r["reported_usd"] for r in cutoff["ledger"]
                         if r["period"] == "after_screenshot"), Decimal(0))
    screenshot_days = aggregate(rows, "2026-09-06", "2026-09-12")["total_usage"]
    reconciled = screenshot_days - later_charges
    assert reconciled.quantize(Decimal(".01")) == Decimal("15.70")
    return {
        "scope": "OpenRouter account daily/model exports; UTC buckets; unequal live workloads",
        "comparison": "Early Sep6-7 vs later Sep9-12. Sep7 includes the release boundary; not a controlled before/after experiment.",
        "daily": {d: aggregate(rows, d, d) for d in days},
        "windows": windows,
        "percent_decreases": decreases,
        "export_total": {k: sum((r[k] for r in rows.values()), Decimal(0)) for k in METRICS},
        "screenshot_date_labels_total_usd": screenshot_days,
        "screenshot_displayed_usd": Decimal("15.70"),
        "screenshot_raw_difference_usd": screenshot_days - Decimal("15.70"),
        "production_cost_after_inferred_screenshot_cutoff_usd": later_charges,
        "screenshot_time_adjusted_usd": reconciled,
        "screenshot_reconciliation": "Consistent to displayed cents after subtracting later production usage. Capture cutoff inferred from filename; account billing semantics not independently proved.",
    }


def application_summary():
    metadata = json.loads((ROOT / "application-metadata.json").read_text())
    source = {}
    for item in metadata["files"]:
        path = ROOT / item["file"]
        assert hashlib.sha256(path.read_bytes()).hexdigest() == item["sha256"]
        source[path.stem] = [json.loads(line, parse_float=Decimal)
                             for line in path.read_text().splitlines()]
        assert len(source[path.stem]) == item["rows"]
    charges = source["application-charges"]
    events = source["application-model-events"]
    runs = source["application-runs"]

    def measure(rows, cost_key):
        known = [r[cost_key] for r in rows if r[cost_key] is not None]
        result = {"records": len(rows), "known_cost_records": len(known),
                  "unknown_cost_records": len(rows) - len(known),
                  "reported_usd_known_subtotal": sum(known, Decimal(0))}
        for key in ("prompt_tokens", "completion_tokens", "cached_prompt_tokens", "reasoning_tokens"):
            values = [r[key] for r in rows if r[key] is not None]
            result[key] = sum(values) if values else None
            result[f"{key}_known_records"] = len(values)
        return result

    main = [r for r in charges if r["channel"] == "main"]
    post = [r for r in events if not r["before_first_ledger_record"]]
    assert measure(main, "actual_usd")["reported_usd_known_subtotal"] == measure(post, "usage_cost_usd")["reported_usd_known_subtotal"]
    incident = [r for r in events if r["run_ordinal"] == 8]
    incident_run = next(r for r in runs if r["run_ordinal"] == 8)
    assert len(incident) == 16 and incident_run["used_tools"] == 100
    assert measure(incident, "usage_cost_usd")["prompt_tokens"] == 326051
    return {
        "captured_at_utc": metadata["captured_at_utc"],
        "ledger": measure(charges, "actual_usd"),
        "ledger_by_channel": {c: measure([r for r in charges if r["channel"] == c], "actual_usd")
                              for c in sorted({r["channel"] for r in charges})},
        "pre_ledger_completed_model_events": measure([r for r in events if r["before_first_ledger_record"]], "usage_cost_usd"),
        "post_ledger_completed_model_events_overlap_main_charges": measure(post, "usage_cost_usd"),
        "historical_incident_run_8": {"run": incident_run, "model_events": measure(incident, "usage_cost_usd")},
        "daily_ledger_utc": {d: measure([r for r in charges if r["day_utc"] == d], "actual_usd")
                             for d in sorted({r["day_utc"] for r in charges})},
        "warning": "Do not add overlapping events to ledger. Reservations are not confirmed API requests; missing actual charges stay unknown. No task-quality or causal estimate.",
    }


def chart(rows):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.ticker import StrMethodFormatter

    days = [(date(2026, 9, 6) + timedelta(days=i)).isoformat() for i in range(8)]
    groups = [(SOL, "#3366b0"), ("Gemini 3.8 Flash", "#28977e"),
              ("Other", "#727c86")]
    fig, axes = plt.subplots(2, 1, figsize=(11, 7.4), sharex=True)
    for ax, metric, label in zip(axes, ["total_usage", "request_count"],
                                 ["Reported spend (USD)", "Requests"]):
        base = [0.0] * len(days)
        for model, color in groups:
            values = []
            for d in days:
                values.append(float(sum((r[metric] for (rd, m), r in rows.items()
                    if rd == d and ((model == "Other" and m not in [SOL, "Gemini 3.8 Flash"])
                                    or m == model)), Decimal(0))))
            ax.bar(range(len(days)), values, bottom=base, color=color, label=model, width=.63)
            base = [a + b for a, b in zip(base, values)]
        for x, value in enumerate(base):
            ax.text(x, value + max(base) * .035,
                    f"${value:.2f}" if metric == "total_usage" else str(int(value)),
                    ha="center", fontsize=10)
        ax.set_ylabel(label)
        ax.set_ylim(0, max(base) * 1.22)
        ax.grid(axis="y", alpha=.16)
        ax.set_axisbelow(True)
        ax.spines[["top", "right"]].set_visible(False)
    axes[0].yaxis.set_major_formatter(StrMethodFormatter("${x:.0f}"))
    axes[0].legend(loc="upper right", frameon=False, fontsize=10)
    axes[1].set_xticks(range(len(days)), [f"Sep {int(d[-2:])}" + ("*" if d.endswith("13") else "") for d in days])
    fig.suptitle("Lower spending coincided with far fewer requests", x=.08, ha="left", fontsize=17)
    fig.text(.08, .917, "Actual OpenRouter exports by model and UTC day. Cost changes are not a matched-workload experiment.", fontsize=10)
    fig.text(.08, .025,
        "Cost release: Sep 7, 16:54 UTC (Sep 8, 00:54 SGT); the Sep 7 bar spans both configurations.\n"
        "* Sep 13 is partial, through 17:03 UTC. Sep 8 has no exported rows. Source: numeric CSVs in this folder.", fontsize=9)
    fig.subplots_adjust(left=.08, right=.98, top=.87, bottom=.14, hspace=.2)
    fig.savefig(ROOT / "usage.png", dpi=160)
    plt.close(fig)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chart", action="store_true")
    args = parser.parse_args()
    data = load()
    report = summarize(data)
    report["application"] = application_summary()
    (ROOT / "summary.json").write_text(json.dumps(report, indent=2, default=str) + "\n")
    if args.chart:
        chart(data)
    print(f"Verified {len(data)} date/model rows across {len(METRICS)} exports; wrote summary.json")
