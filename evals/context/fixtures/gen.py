"""Builds the synthetic context-eval fixtures (all names and data are fictional).

Run: python3 evals/context/fixtures/gen.py
Each fx_*.py module defines FIXTURE = {"id", "description", "turns", "probes"}.
{"$fill": n} expands to neutral filler in replay.ts and never holds evidence.
"""
import importlib
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent


def fill(n):
    return {"$fill": n}


def turn(user, reply, *calls):
    return {"user": user, "calls": list(calls), "reply": reply}


def call(operation, args, result):
    return {"operation": operation, "args": args, "result": result}


def email(sender, subject, date, text, padding=2500):
    return {"from": sender, "subject": subject, "date": date, "snippet": text[:90], "body": [text, fill(padding)]}


def web(title, text, padding=6000):
    return {"title": title, "url": "https://news.example.com/" + re.sub(r"\W+", "-", title.lower()), "text": [text, fill(padding)]}


def chat(user, reply):
    return turn(user, reply)


FILLER_TOPICS = [
    ("any interesting tech news today?", "A few chip and cloud stories; nothing that affects your plans.", "Tech news roundup"),
    ("what's a good quick dinner idea?", "A soy-ginger salmon traybake takes about 25 minutes.", "Weeknight dinner ideas"),
    ("tips for sleeping better?", "Keep a fixed wake time, cut caffeine after 2pm and dim screens before bed.", "Sleep habits guide"),
    ("how do index funds work?", "They track a market index and hold its constituents at low cost.", "Index funds explained"),
    ("best stretches after running?", "Calf, hamstring and hip-flexor stretches, 30 seconds each.", "Post-run stretching"),
    ("what's new in the F1 standings?", "The championship gap narrowed after the last race.", "F1 standings update"),
]


def filler(k, start=0, padding=8000):
    """k unrelated web-lookup exchanges with large results, to push older turns out of context."""
    out = []
    for i in range(k):
        user, reply, title = FILLER_TOPICS[(start + i) % len(FILLER_TOPICS)]
        out.append(turn(user, reply, call("web_search", {"query": user}, {"results": [web(title, reply, padding)]})))
    return out


def probe(fid, n, after, message, slice_, evidence, accept, reject=(), note=""):
    return {"id": f"{fid}/{n}", "after": after, "message": message, "slice": slice_,
            "evidence": list(evidence), "accept": list(accept), "reject": list(reject), "note": note}


def strip_fills(value):
    if isinstance(value, dict):
        if set(value) == {"$fill"}:
            return ""
        return {k: strip_fills(v) for k, v in value.items()}
    if isinstance(value, list):
        return [strip_fills(v) for v in value]
    return value


def size(value):
    if isinstance(value, dict):
        return value["$fill"] if set(value) == {"$fill"} else sum(size(v) for v in value.values())
    if isinstance(value, list):
        return sum(size(v) for v in value)
    return len(str(value))


def validate(f, known_ops):
    ids = set()
    for c in (c for t in f["turns"] for c in t["calls"]):
        assert c["operation"] in known_ops, f"{f['id']}: unknown operation {c['operation']}"
    for p in f["probes"]:
        assert p["id"] not in ids, p["id"]
        ids.add(p["id"])
        assert 1 <= p["after"] <= len(f["turns"]), p["id"]
        seen = json.dumps(strip_fills(f["turns"][: p["after"]]), ensure_ascii=False)
        for e in p["evidence"]:
            assert e in seen, f"{p['id']}: evidence {e!r} not in turns[:{p['after']}]"
        for r in p["accept"] + p["reject"]:
            re.compile(r, re.I)


def main():
    protocol = (HERE.parents[2] / "src" / "protocol.ts").read_text()
    known = set(re.findall(r'operation: z\.literal\("([a-z_]+)"\)', protocol))
    for source in (HERE.parents[2] / "src").glob("*.ts"):
        known |= set(re.findall(r'"((?:parcel|library|canvas|media|research)_[a-z_]+)"', source.read_text()))
    assert known, "no operations parsed from protocol.ts"
    rows = []
    for module in sorted(HERE.glob("fx_*.py")):
        f = importlib.import_module(module.stem).FIXTURE
        validate(f, known)
        (HERE / f"{f['id']}.json").write_text(json.dumps(f, indent=1, ensure_ascii=False) + "\n")
        slices = {}
        for p in f["probes"]:
            slices[p["slice"]] = slices.get(p["slice"], 0) + 1
        results = sum(size(c["result"]) for t in f["turns"] for c in t["calls"])
        rows.append(f"{f['id']:24} turns {len(f['turns']):3}  probes {len(f['probes'])}  {slices}  result chars {results:,}")
    print("\n".join(rows))


if __name__ == "__main__":
    sys.path.insert(0, str(HERE))
    main()
