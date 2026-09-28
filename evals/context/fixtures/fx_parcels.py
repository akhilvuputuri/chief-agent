from gen import call, chat, fill, filler, probe, turn

ID = "parcels-and-stocks"
T = [
    turn("what am I still waiting on?", "Three parcels: the Aeron chair (Ninja Van, Mon 12 Oct), running shoes (J&T, tomorrow) and a lens cap (Qxpress, delayed).",
         call("parcel_list", {}, [
             {"item": "Aeron chair", "carrier": "Ninja Van", "tracking": "NV-77120-SG", "eta": "Mon 12 Oct", "log": fill(8000)},
             {"item": "Running shoes", "carrier": "J&T", "tracking": "JT559023", "eta": "tomorrow", "log": fill(5000)},
             {"item": "Lens cap", "carrier": "Qxpress", "status": "delayed at sorting hub", "log": fill(4000)}])),
    turn("how's my watchlist?", "AAPL $231.10 (-0.4%), NVDA $188.40 (+1.2%), D05 $41.02 (+0.3%). Alert thresholds: AAPL 5%, NVDA 7%.",
         call("watchlist_list", {}, {"items": [
             {"ticker": "AAPL", "price": 231.1, "change": "-0.4%", "threshold": "5%"},
             {"ticker": "NVDA", "price": 188.4, "change": "+1.2%", "threshold": "7%"},
             {"ticker": "D05", "price": 41.02, "change": "+0.3%", "threshold": "3.5%"}], "history": fill(6000)})),
    chat("nice", "Anything else?"),
] + filler(7, start=2) + [
    turn("set NVDA alert to 5%", "Done, NVDA now alerts on a 5% drop.",
         call("watchlist_update", {"ticker": "NVDA", "threshold": "5%"}, {"ticker": "NVDA", "threshold": "5%", "updated": True})),
    chat("and how's D05 doing?", "D05 is at $41.02, up 0.3% today."),
    turn("track the chair please", "The Aeron chair is at the Ninja Van hub; delivery window Mon 12 Oct, 2-6 pm.",
         call("parcel_list", {"tracking": "NV-77120-SG"}, {"item": "Aeron chair", "status": "at hub", "window": "Mon 12 Oct, 2-6 pm", "log": fill(9000)})),
]
N = len(T)
P = [
    probe(ID, 1, N, "what time window was that?", "previous", ["2-6 pm"], [r"2 ?(-|to|–) ?6 ?pm|2pm|14:00"]),
    probe(ID, 2, N, "what's my NVDA alert threshold now?", "gap", ["NVDA now alerts on a 5% drop"], [r"5 ?%"], [r"7 ?%"]),
    probe(ID, 3, N, "what's the tracking number for the running shoes?", "tool-detail", ["JT559023"], [r"JT559023"]),
    probe(ID, 4, N, "which parcel was delayed?", "distant", ["Lens cap"], [r"lens cap"], [r"chair"]),
    probe(ID, 5, N, "what's D05's alert threshold?", "tool-detail", ["3.5%"], [r"(?<![\d.])3\.5 ?%"], [r"(?<![\d.])(5|7) ?%"]),
    probe(ID, 6, N, "unrelated: which carrier has my shoes?", "switch", ["J&T"], [r"j ?& ?t"], [r"ninja"]),
]
FIXTURE = {"id": ID, "description": "Parcel tracking and stock watchlist checks interleaved with unrelated lookups.", "turns": T, "probes": P}
