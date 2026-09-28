from gen import call, chat, email, fill, filler, probe, turn

ID = "job-search"
T = [
    turn("which roles have I saved?", "Four saved roles: Stripe backend (applied), Grab platform (interviewing), Wise payments (not applied), Canva infra (rejected).",
         call("job_list", {}, [
             {"company": "Stripe", "title": "Backend Engineer", "status": "applied", "salary": "SGD 180-210k", "notes": fill(4000)},
             {"company": "Grab", "title": "Platform Engineer", "status": "interviewing", "salary": "SGD 160-190k", "notes": fill(4000)},
             {"company": "Wise", "title": "Payments Engineer", "status": "saved", "salary": "SGD 170-200k", "notes": fill(4000)},
             {"company": "Canva", "title": "Infra Engineer", "status": "rejected", "notes": fill(3000)}])),
    turn("any recruiter emails?", "Grab's recruiter Lina Tan confirmed your system design round on Fri 9 Oct at 3:00 pm with interviewer Marcus Webb.",
         call("gmail_search", {"query": "grab interview"}, [
             email("Lina Tan <lina@grab-careers.example.com>", "System design round", "2026-09-29",
                   "Your system design round is Fri 9 Oct at 3:00 pm with Marcus Webb. Zoom ID 884 213 0071.")])),
    chat("great, thanks", "Good luck!"),
] + filler(6, start=1) + [
    turn("remind me to prep rate limiting on Thursday evening", "Reminder set for Thu 8 Oct, 7 pm: prep rate limiting.",
         call("schedule_create", {"text": "prep rate limiting", "at": "2026-10-08T19:00:00+08:00"}, {"id": "sch-41", "created": True})),
    chat("what topics should I cover for system design?", "Rate limiting, idempotent payments, queues and back-pressure, and caching strategy."),
    turn("mark Canva as rejected and note they want more Go experience", "Updated Canva: rejected, note added about Go experience.",
         call("job_update", {"company": "Canva", "status": "rejected", "note": "wants more Go experience"}, {"updated": True})),
]
N = len(T)
P = [
    probe(ID, 1, N, "what did they want more of?", "previous", ["more Go experience"], [r"\bgo\b|golang", r"experience"]),
    probe(ID, 2, N, "when is my prep reminder?", "gap", ["Thu 8 Oct, 7 pm"], [r"thu(rsday)?|8 oct", r"7 ?pm|19:00"]),
    probe(ID, 3, N, "what's the Zoom ID for the Grab interview?", "tool-detail", ["884 213 0071"], [r"884 ?213 ?0071"]),
    probe(ID, 4, N, "who is interviewing me at Grab?", "distant", ["Marcus Webb"], [r"marcus"], [r"lina"]),
    probe(ID, 5, N, "what's the salary range for the Wise role?", "tool-detail", ["SGD 170-200k"], [r"170", r"200"], [r"180|160"]),
    probe(ID, 6, N, "switching topics: when is the Grab round?", "switch", ["Fri 9 Oct at 3:00 pm"], [r"fri(day)?|9 oct", r"3(:00)? ?pm|15:00"], [r"7 ?pm"]),
]
FIXTURE = {"id": ID, "description": "Job applications and interview prep interleaved with reminders and unrelated lookups.", "turns": T, "probes": P}
