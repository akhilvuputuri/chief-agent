from gen import call, chat, email, fill, filler, probe, turn

ID = "home-admin"
T = [
    turn("anything from my landlord?", "Mr Chua says the lease renewal is at SGD 3,450/month (up from 3,200) and he needs your answer by 15 Oct.",
         call("gmail_thread", {"query": "landlord lease"}, {"messages": [
             email("Daniel Chua <dchua@example.com>", "Lease renewal", "2026-09-26",
                   "Renewal at SGD 3,450/month from 1 Dec. Please confirm by 15 Oct. Aircon servicing is on me."),
             email("Daniel Chua <dchua@example.com>", "Re: Lease renewal", "2026-09-27",
                   "The diplomatic clause stays. Deposit remains two months.")], "quoted": fill(6000)})),
    turn("any bills due?", "SP Group electricity SGD 142.60 is due 10 Oct, and the Singtel bill SGD 58.90 is due 14 Oct.",
         call("gmail_search", {"query": "bill due"}, [
             email("SP Group <bills@spgroup.example.com>", "Your bill", "2026-09-29", "Amount due SGD 142.60 by 10 Oct. Account 5510-2277."),
             email("Singtel <billing@singtel.example.com>", "Bill ready", "2026-09-29", "SGD 58.90 due 14 Oct.")])),
] + filler(6, start=4) + [
    turn("add pay electricity to my list", "Added: pay SP Group electricity SGD 142.60 by 10 Oct.",
         call("item_save", {"title": "Pay SP Group electricity SGD 142.60 by 10 Oct"}, {"id": "item-51", "saved": True})),
    turn("did the insurer reply about the claim?", "Yes, Aviva approved claim CLM-30917 for SGD 380 and will pay within 7 working days.",
         call("gmail_search", {"query": "claim"}, [
             email("Aviva Claims <claims@aviva.example.com>", "Claim approved", "2026-09-30", "Claim CLM-30917 approved: SGD 380, paid within 7 working days.")])),
]
N = len(T)
P = [
    probe(ID, 1, N, "how much are they paying out?", "previous", ["SGD 380"], [r"380"]),
    probe(ID, 2, N, "what's the new rent?", "distant", ["SGD 3,450/month"], [r"3,?450"], [r"3,?200"]),
    probe(ID, 3, N, "what's my SP Group account number?", "tool-detail", ["5510-2277"], [r"5510-?2277"]),
    probe(ID, 4, N, "how much is the electricity bill?", "gap", ["SGD 142.60"], [r"142\.60"], [r"58\.90"]),
    probe(ID, 5, N, "does the diplomatic clause stay?", "tool-detail", ["The diplomatic clause stays"], [r"\b(stays|remains|is staying|will stay|is kept|keeps?)\b"], [r"not sure|unsure|don't know|can't (confirm|tell)|no mention"]),
    probe(ID, 6, N, "by when do I need to answer the landlord?", "switch", ["by 15 Oct"], [r"15 oct|oct(ober)? 15"], [r"7 working|10 oct"]),
]
FIXTURE = {"id": ID, "description": "Lease renewal, bills and an insurance claim interleaved with unrelated lookups.", "turns": T, "probes": P}
