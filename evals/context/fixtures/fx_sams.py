from gen import call, chat, email, filler, probe, turn

ID = "two-sams"
T = [
    turn("any email from Sam?", "Two Sams wrote: Sam Okafor (work) moved the quarterly planning to Mon 12 Oct at 9:30 am; your cousin Sam Lee asked about Grandma's 80th on Sun 25 Oct.",
         call("gmail_search", {"query": "from:sam"}, [
             email("Sam Okafor <sam.okafor@northwind.example.com>", "Planning moved", "2026-09-30",
                   "Quarterly planning is now Mon 12 Oct at 9:30 am in Boardroom Orca. Please bring the Q3 churn numbers."),
             email("Sam Lee <samlee88@example.com>", "Grandma's 80th", "2026-09-30",
                   "Grandma's 80th is Sun 25 Oct, lunch at Jade Lotus, 12:30 pm. Can you bring the photo album?")])),
    chat("ok noted", "Noted."),
] + filler(6, start=3) + [
    turn("add grandma's lunch to my calendar", "Drafted: Grandma's 80th, Sun 25 Oct 12:30 pm at Jade Lotus.",
         call("calendar_draft", {"title": "Grandma's 80th", "start": "2026-10-25T12:30:00+08:00"}, {"draft": "d-602", "status": "pending approval"})),
    turn("what did work Sam want me to bring?", "Sam Okafor asked you to bring the Q3 churn numbers.",
         call("gmail_read", {"id": "m-okafor-1"}, {"from": "Sam Okafor", "body": "Please bring the Q3 churn numbers. Dial-in 6621 004 for remote folks."})),
]
N = len(T)
P = [
    probe(ID, 1, N, "and what's the dial-in?", "previous", ["6621 004"], [r"6621 ?004"]),
    probe(ID, 2, N, "what is Sam bringing up at lunch, what did he ask me to bring?", "same-word", ["photo album"], [r"photo album"], [r"churn"],
          "The previous exchange is about the other Sam."),
    probe(ID, 3, N, "which room is the planning meeting in?", "tool-detail", ["Boardroom Orca"], [r"orca"]),
    probe(ID, 4, N, "when is quarterly planning?", "distant", ["Mon 12 Oct at 9:30 am"], [r"12 oct|mon(day)?", r"9:30"], [r"12:30"]),
    probe(ID, 5, N, "where is grandma's lunch?", "gap", ["Jade Lotus"], [r"jade lotus"]),
    probe(ID, 6, N, "new topic: what time is my cousin's family lunch?", "switch", ["12:30 pm"], [r"12:30"], [r"9:30"]),
]
FIXTURE = {"id": ID, "description": "A colleague and a cousin both named Sam, with separate emails and events.", "turns": T, "probes": P}
