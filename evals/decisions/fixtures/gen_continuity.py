"""Builds continuity.json: does the latest message need the previous exchange?

All names and data are fictional. Label `needs_previous` is true when a correct answer
depends on the previous exchange (an elliptical follow-up, an answer to Chief's question,
a correction, a pronoun), and false when the message stands on its own.

Run: python3 evals/decisions/fixtures/gen_continuity.py
Splits are by conversation (prior), never by message, so no prior leaks across splits.
"""

from __future__ import annotations

import json
import random
from pathlib import Path

HERE = Path(__file__).resolve().parent

# (domain, previous user message, previous reply, previous-exchange characters including
#  tool results as sent today, follow-ups that need it, same-domain messages that do not)
PRIORS = [
    ("email", "any reply from the landlord?", "Yes — Daniel Chua replied on 27 Sep: the renewal is SGD 3,450/month from 1 Dec and he needs your answer by 15 Oct.", 9400,
     ["what was the deadline again?", "can you check if he mentioned aircon servicing", "reply-wise, what did he say about the deposit?"],
     ["did my bank send anything this week?"]),
    ("email", "find the email from Grab about my interview", "Lina Tan from Grab confirmed your system design round on Fri 9 Oct, 3 pm, with Marcus Webb. Zoom ID 884 213 0071.", 8200,
     ["who's the interviewer?", "what's the zoom id", "is there a dress code mentioned in it?"],
     ["any newsletters I haven't read?"]),
    ("email", "summarise my unread mail", "6 unread: 2 bank alerts, a Shopee promo, a DHL delivery notice, a GitHub security alert and a note from your sister about Sunday lunch.", 11200,
     ["what did my sister say exactly?", "open the DHL one", "and the GitHub alert — is it urgent?"],
     ["search my mail for the insurance renewal"]),
    ("email", "did Aviva reply about the claim?", "Aviva approved claim CLM-30917 for SGD 380, paid within 7 working days.", 6100,
     ["when will the money arrive then?", "what was the claim number", "great, can you remind me to check my account next friday"],
     ["anything from my dentist?"]),
    ("parcels", "what am I waiting on?", "Three parcels: the Aeron chair (Ninja Van, Mon 12 Oct), running shoes (J&T, tomorrow) and a lens cap (Qxpress, delayed).", 7300,
     ["which one's delayed?", "track the chair", "the shoes arrived today"],
     ["is my Lazada order shipped yet?"]),
    ("parcels", "where's my DHL package?", "DHL shows it at the Changi hub; delivery window Thu 8 Oct, 9 am–1 pm.", 5200,
     ["can they deliver after 6 instead?", "what's the tracking number", "ok mark it delivered, it came early"],
     ["check my email for the IKEA delivery date"]),
    ("parcels", "record a new parcel: headphones from Shopee, J&T JT889120", "Saved: headphones (Shopee, J&T JT889120). No delivery date stated yet.", 2100,
     ["actually the tracking is JT889121", "add that it's a gift for mum", "when will it come?"],
     ["list all my parcels"]),
    ("calendar", "am I free thursday afternoon?", "Thursday 8 Oct: free from 1 pm to 4:30 pm; you have a 4:30 pm call with Priya.", 3100,
     ["book 2 to 3 for the dentist then", "move the call to 5?", "what about friday?"],
     ["what's on my calendar next week?"]),
    ("calendar", "add lunch with Wei Ling on the 14th", "What time should the lunch with Wei Ling on Wed 14 Oct start, and how long?", 900,
     ["12:30 for an hour", "1pm", "make it the 15th instead, same time is fine"],
     ["add a dentist appointment on 20 Oct at 9am"]),
    ("calendar", "draft my leave from 2 to 6 Nov", "Draft saved: all-day 'Leave' from Mon 2 Nov to Fri 6 Nov. Approve it with the card to create it.", 1400,
     ["label it Bali trip instead", "oh include the 9th too", "did it go through?"],
     ["when is my next meeting with Priya?"]),
    ("stocks", "how's my watchlist?", "AAPL $231.10 (−0.4%), NVDA $188.40 (+1.2%), D05 $41.02 (+0.3%). Thresholds: AAPL 5%, NVDA 7%.", 2600,
     ["set NVDA to 5% too", "why is D05 up?", "pause AAPL for this week"],
     ["add TSLA with a 6% alert"]),
    ("stocks", "add MSFT", "MSFT matches Nasdaq (MSFT) and a Frankfurt listing (MSF). Which exchange?", 1200,
     ["nasdaq", "the US one", "frankfurt please"],
     ["remove AAPL from my watchlist"]),
    ("stocks", "only monitor AAPL from the US open until midnight", "Done: AAPL is checked 21:30–24:00 SGT on trading days. Next checks: Mon 5 Oct 21:30–24:00.", 2300,
     ["make that 1am instead of midnight", "do the same for NVDA", "and weekends?"],
     ["what's my default drop threshold?"]),
    ("news", "follow techcrunch.com", "Following TechCrunch. Latest: 'Chip startups raise record round', 'EU fines cloud provider', 'New phone teardown'.", 2000,
     ["also theverge", "remove it again", "send me an edition now with those"],
     ["what time does my bulletin arrive?"]),
    ("news", "set my bulletin to 7am with topics AI and chips", "Bulletin set for 07:00 SGT with topics AI and chips; next edition Fri 2 Oct.", 1300,
     ["add climate to the topics", "make it 6:30", "how many items will it have?"],
     ["follow arstechnica.com"]),
    ("jobs", "which roles have I saved?", "Four: Stripe backend (applied), Grab platform (interviewing), Wise payments (saved), Canva infra (rejected).", 5100,
     ["mark Wise as applied", "what's the salary for the Stripe one?", "delete the Canva one"],
     ["save this role: https://jobs.example.com/acme-sre"]),
    ("jobs", "how well do I fit the Grab platform role?", "Strong fit on distributed systems and Go; gaps: Kubernetes operators and on-call leadership. 3 prep topics suggested.", 12800,
     ["make a prep plan from those gaps", "what were the 3 topics?", "save it to my prep sheet"],
     ["how many roles have I applied to this month?"]),
    ("library", "is Project Hail Mary available at the library?", "Yes: 4 Lucky Day copies to borrow now (7 days, no holds). The regular copies have a 129-day wait. Checked 10:02.", 2700,
     ["what about the audiobook?", "and Klara and the Sun?", "how long is the wait again?"],
     ["what's on my library shelf?"]),
    ("library", "how many days left on my loans?", "Two loans: 'The Overstory' (3 days) and 'Piranesi' (11 days).", 1900,
     ["which one expires first?", "can I renew the first one?", "ok and holds?"],
     ["is Tomorrow, and Tomorrow, and Tomorrow available?"]),
    ("daily", "remind me to call mum at 7pm", "Reminder set for today 7:00 pm: call mum.", 900,
     ["make it 8", "and every sunday too", "cancel that"],
     ["what's on my to-do list?"]),
    ("daily", "what's on my to-do list?", "Open: pay SP Group electricity SGD 142.60 by 10 Oct; buy birthday gift for Ana; book car servicing.", 1600,
     ["mark the first one done", "when is the gift due?", "add renew passport to it"],
     ["set a morning briefing at 7:30"]),
    ("daily", "set a daily briefing at 7:30", "Daily briefing scheduled for 07:30 SGT with calendar and unread email.", 1100,
     ["include the weather too", "change it to weekdays only", "what will it include?"],
     ["remind me tomorrow at 9 to pay rent"]),
    ("web", "what time does the MRT stop running tonight?", "Most lines close around 11:30 pm–midnight; last trains from city stations are about 11:45 pm.", 4300,
     ["what about the circle line specifically?", "is it different on saturday?", "source?"],
     ["what's the weather tomorrow?"]),
    ("web", "who won the F1 race today?", "Lando Norris won the Singapore GP; Leclerc second, Verstappen third.", 4700,
     ["how many points does that put him on?", "and the constructors?", "when's the next race?"],
     ["any big tech news today?"]),
    ("web", "what's a good quick dinner?", "A soy-ginger salmon traybake: 25 minutes, one tray, serve with rice.", 3900,
     ["what do I need for it?", "something vegetarian instead?", "for 4 people?"],
     ["how do index funds work?"]),
    ("media", "[Attached image: receipt.jpg attachmentId=…] how much did I spend?", "The receipt from Cold Storage totals SGD 87.45 on 28 Sep, including 9% GST.", 4100,
     ["what was the most expensive item?", "is the GST included?", "add it to my expenses note"],
     ["[Attached image: menu.jpg attachmentId=…] translate this"]),
    ("media", "[Attached PDF: lease.pdf sourceId=…] what's the notice period?", "Two months' written notice (clause 7.2, page 3). The diplomatic clause allows early exit after 12 months.", 6200,
     ["what does the diplomatic clause need?", "which page was that?", "summarise the rest of it"],
     ["[Attached PDF: payslip.pdf sourceId=…] what's my net pay?"]),
    ("research", "compare the Aeron and Embody chairs", "Both have 12-year warranties; Embody suits slouching postures, Aeron breathes better. Embody costs ~SGD 300 more.", 13500,
     ["which would you pick for me?", "any second-hand deals?", "cite your sources"],
     ["research the best running shoes for flat feet"]),
    ("chat", "tips for sleeping better?", "Keep a fixed wake time, cut caffeine after 2pm and dim screens an hour before bed.", 700,
     ["what if I work late shifts?", "why the caffeine one?", "thanks, any more?"],
     ["how do I get rid of hiccups?"]),
    ("chat", "explain what a credit spread is", "Buying and selling options of the same type at different strikes; you collect or pay the difference, with capped risk.", 900,
     ["give me an example", "is it risky?", "simpler please"],
     ["what's the difference between ETFs and unit trusts?"]),
    ("canvas", "save the Grab prep plan as a canvas", "Saved canvas 'Grab platform prep' with 3 sections; open it from the button.", 3300,
     ["add a section on behavioural questions", "rename it", "can I share it?"],
     ["show my canvases"]),
    ("work", "research coffee machines under $500 in the background", "Started a background task: shortlist coffee machines under SGD 500 with reviews. I'll report back.", 2200,
     ["how's that going?", "stop it", "add grinders too"],
     ["what tasks are running?"]),
    ("email", "check both inboxes for my passport renewal", "Primary: ICA confirmed your appointment on 21 Oct, 10:15 am. Secondary: nothing found.", 8800,
     ["what do I need to bring?", "where is it?", "add it to my calendar"],
     ["anything from Singtel?"]),
    ("parcels", "did my IKEA order ship?", "IKEA says your bed frame ships on 6 Oct; no carrier or tracking yet.", 5600,
     ["let me know when it does", "what about the mattress in that order?", "track it"],
     ["what's arriving this week?"]),
    ("calendar", "what's on tomorrow?", "Fri 2 Oct: 9:30 standup, 12:00 lunch with Arjun, 4 pm dentist.", 2800,
     ["cancel the dentist", "where's the lunch?", "anything after 6?"],
     ["schedule a call with Priya next tuesday 3pm"]),
    ("stocks", "why didn't I get an alert for NVDA?", "NVDA fell 4.1% yesterday versus your 5% threshold, so no alert fired.", 2400,
     ["lower it to 4 then", "what was the closing price?", "is 4% too sensitive for it?"],
     ["show me my alert history"]),
    ("jobs", "save the Wise payments role", "Saved: Wise, Payments Engineer (status saved). No salary listed.", 3000,
     ["actually mark it applied", "add a note that the recruiter is Tom", "what's the link?"],
     ["list roles I'm interviewing for"]),
    ("library", "any new books by Ted Chiang?", "No new titles; 'Exhalation' is borrowable now and 'Stories of Your Life' has a 40-day wait.", 2500,
     ["borrow the first one", "put me on hold for the other", "is there an audio version?"],
     ["check if Dune is available"]),
    ("daily", "add buy milk", "Added to your list: buy milk.", 500,
     ["and eggs", "remove it", "make it urgent"],
     ["what's due this week?"]),
    ("news", "why did my bulletin have no AI stories?", "None of today's 31 items from your 4 sites matched 'AI' strongly enough; 2 chip stories ranked first.", 2100,
     ["can you lower the bar for that topic?", "which sites did it check?", "ok show me those chip stories"],
     ["unfollow engadget"]),
]

# Messages that never need a previous exchange, to pair across domains.
# Messages that never need a previous exchange. Each split has its own pool, so no
# standalone message appears in both tuning and held-out.
STANDALONE = {
    "tuning": [
        ("chat", "thanks!"),
        ("chat", "good morning"),
        ("chat", "how are you today?"),
        ("web", "what's the exchange rate SGD to JPY?"),
        ("web", "when is Deepavali this year?"),
        ("web", "best ramen near Tanjong Pagar?"),
        ("daily", "remind me to water the plants every saturday at 9"),
        ("calendar", "when's my next free evening?"),
        ("email", "anything new from the bank?"),
        ("parcels", "what parcels are pending?"),
        ("stocks", "how's the market today?"),
        ("jobs", "how many roles have I saved?"),
        ("library", "what am I borrowing right now?"),
        ("news", "send me today's bulletin"),
        ("research", "find the best budget mechanical keyboards"),
        ("chat", "tell me a fun fact"),
    ],
    "held-out": [
        ("chat", "cheers, that's all for now"),
        ("chat", "hey, you around?"),
        ("chat", "can you explain how compound interest works?"),
        ("web", "is it going to rain in Singapore this afternoon?"),
        ("web", "how long is the flight from Singapore to Osaka?"),
        ("web", "what's a good beginner climbing gym in the west?"),
        ("daily", "remind me to renew my gym membership on the 30th"),
        ("calendar", "do I have anything on saturday morning?"),
        ("email", "did the condo management email about the lift works?"),
        ("parcels", "any deliveries expected today?"),
        ("stocks", "add Sea Ltd to my watchlist at 8%"),
        ("jobs", "save the Shopee data platform role from LinkedIn"),
        ("library", "can I borrow The Three-Body Problem now?"),
        ("news", "pause my news bulletin for a week"),
        ("research", "compare the top three robot vacuums under $600"),
        ("chat", "recommend a podcast about history"),
    ],
}


def build(seed: int = 11) -> list[dict]:
    rng = random.Random(seed)
    cases: list[dict] = []
    order = list(range(len(PRIORS)))
    rng.shuffle(order)
    held_out = set(order[: len(PRIORS) * 2 // 5])
    for i, (domain, user, reply, chars, follow, same) in enumerate(PRIORS):
        split = "held-out" if i in held_out else "tuning"
        prior = {"user": user, "assistant": reply, "domain": domain, "chars": chars}
        add = lambda message, label, kind: cases.append(  # noqa: E731
            {
                "id": f"c{i:02d}-{len([c for c in cases if c['prior_index'] == i])}",
                "prior_index": i,
                "split": split,
                "previous": prior,
                "message": message,
                "needs_previous": label,
                "kind": kind,
            }
        )
        for message in follow:
            add(message, True, "follow-up")
        for message in same:
            add(message, False, "same-domain new topic")
        others = [s for s in STANDALONE[split] if s[0] != domain]
        for _, message in rng.sample(others, 2):
            add(message, False, "new topic")
    return cases


def main() -> None:
    cases = build()
    (HERE / "continuity.json").write_text(json.dumps(cases, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    by = {}
    for c in cases:
        by[(c["split"], c["needs_previous"])] = by.get((c["split"], c["needs_previous"]), 0) + 1
    print(len(cases), "cases", dict(sorted(by.items())))


if __name__ == "__main__":
    main()
