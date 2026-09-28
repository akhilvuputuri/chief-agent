from gen import call, chat, email, filler, probe, turn

ID = "wrong-meeting"
cal = {"events": [
    {"title": "Design review with Aisha Karim", "start": "Tue 6 Oct 2:00 pm", "room": "Level 12 Room Kestrel", "link": "meet.example.com/kst-4410"},
    {"title": "Dentist - Dr Lowe", "start": "Thu 8 Oct 9:40 am", "place": "Bright Smile Dental, Tanjong Pagar"},
]}
T = [
    turn("what's on my calendar next week?", "Design review with Aisha on Tue 6 Oct at 2:00 pm, and the dentist on Thu 8 Oct at 9:40 am.",
         call("calendar_list", {"from": "2026-10-05", "to": "2026-10-11"}, cal)),
    turn("did Aisha send an agenda?", "Yes: review the onboarding flow, then the pricing page. She wants the Figma file shared beforehand.",
         call("gmail_search", {"query": "from:aisha agenda"}, [
             email("Aisha Karim <aisha@northwind.example.com>", "Agenda for Tuesday", "2026-09-28",
                   "1) onboarding flow 2) pricing page. Please share the Figma file by Monday.")])),
] + filler(6) + [
    turn("remind me to renew my passport", "Saved a reminder to renew your passport.",
         call("item_save", {"title": "Renew passport"}, {"id": "item-12", "saved": True})),
    chat("what room is the design review in?", "Level 12 Room Kestrel."),
    turn("Ben emailed about a coffee catch-up?", "Ben Ortiz suggests coffee at Tiong Bahru Bakery, any morning next week, and says he is free Wed 7 Oct at 10:30 am.",
         call("gmail_search", {"query": "from:ben coffee"}, [
             email("Ben Ortiz <ben@ortiz.example.com>", "coffee?", "2026-09-29",
                   "Coffee at Tiong Bahru Bakery next week? I'm free Wed 7 Oct at 10:30 am.")])),
]
N = len(T)
P = [
    probe(ID, 1, N, "where did he want to meet?", "previous", ["Tiong Bahru Bakery"], [r"tiong bahru"]),
    probe(ID, 2, N, "put the coffee with Ben in my calendar", "switch", ["Wed 7 Oct at 10:30 am"], [r"7 oct|wed(nesday)?", r"10:30"],
          [r"kestrel|2:00 ?pm|aisha"], "Must not reuse the design review's time, room or attendee."),
    probe(ID, 3, N, "what time is the design review?", "distant", ["Tue 6 Oct 2:00 pm"], [r"2(:00)? ?pm|14:00"], [r"10:30"]),
    probe(ID, 4, N, "what's the meeting link for Tuesday?", "tool-detail", ["meet.example.com/kst-4410"], [r"kst-4410"]),
    probe(ID, 5, N, "what did Aisha want before the meeting?", "distant", ["share the Figma file by Monday"], [r"figma"]),
    probe(ID, 6, N, "which meeting is on Wednesday?", "same-word", ["Wed 7 Oct at 10:30 am"], [r"ben|coffee"], [r"design review|aisha"]),
]
FIXTURE = {"id": ID, "description": "A design review is discussed, then a different coffee meeting must be scheduled without reusing the first meeting's details.", "turns": T, "probes": P}
