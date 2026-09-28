from gen import call, chat, email, fill, filler, probe, turn, web

ID = "wedding-mixup"
T = [
    turn("any wedding invites in my email?",
         "Two invites: Maya & Jonas on Sat 17 Oct, and Priya & Tom on Sat 14 Nov.",
         call("gmail_search", {"query": "wedding invitation"}, [
             email("Maya Lin <maya@lin-family.example.com>", "Maya & Jonas - save the date", "2026-09-02",
                   "Ceremony Sat 17 Oct 2026 at 11:00 am, Lumen Glasshouse. Dress code: garden formal. RSVP by 3 Oct."),
             email("Priya Nair <priya@nairtom.example.com>", "Priya & Tom are getting married", "2026-09-05",
                   "Ceremony Sat 14 Nov 2026 at 4:30 pm, Harbourline Pavilion. Black tie optional. RSVP to rsvp@priyatom.example.com by 30 Oct."),
         ])),
    turn("add Maya's one to my calendar", "Added Maya & Jonas's wedding on 17 Oct at 11:00 am, Lumen Glasshouse.",
         call("calendar_draft", {"title": "Maya & Jonas wedding", "start": "2026-10-17T11:00:00+08:00"}, {"draft": "d-551", "status": "pending approval"})),
    chat("thanks", "You're welcome!"),
    turn("where are my parcels at?", "Two parcels: the Keychron keyboard arrives Thursday and the blender is still at customs.",
         call("parcel_list", {}, [{"item": "Keychron keyboard", "carrier": "DHL", "eta": "Thursday", "log": fill(9000)},
                                  {"item": "Blender", "carrier": "Ninja Van", "status": "held at customs", "log": fill(7000)}])),
    turn("how is NVDA doing today?", "NVDA is up 1.2% today at $188.40.",
         call("watchlist_list", {}, {"items": [{"ticker": "NVDA", "price": 188.4, "change": "+1.2%"}], "notes": fill(3000)})),
    turn("gift ideas for a wedding, around $150?", "Popular picks: a ceramic serving set, a framed map print, or a cooking class voucher.",
         call("web_search", {"query": "wedding gift ideas 150"}, {"results": [web("Wedding gift guide", "Ceramic serving sets, map prints, class vouchers.", 12000)]})),
    turn("add to my list: silk scarf from Kiln & Loom for Priya", "Saved: silk scarf from Kiln & Loom for Priya.",
         call("item_save", {"title": "Silk scarf from Kiln & Loom for Priya"}, {"id": "item-88", "saved": True})),
    chat("what's the dress code for Maya's again?", "Garden formal."),
    turn("weather this weekend?", "Showers on Saturday, clearing Sunday.",
         call("web_search", {"query": "Singapore weekend weather"}, {"results": [web("Weekend forecast", "Showers Saturday, clear Sunday.", 9000)]})),
    chat("ok cool", "Anything else?"),
    turn("any update from Tom about transport?", "Yes, Tom says a shuttle leaves Orchard Point Hotel at 3:15 pm on the wedding day.",
         call("gmail_search", {"query": "from:tom shuttle"}, [
             email("Tom Reyes <tom@nairtom.example.com>", "Shuttle for 14 Nov", "2026-09-20",
                   "A shuttle will leave Orchard Point Hotel at 3:15 pm for the Harbourline Pavilion.")])),
]
# Unrelated lookups push the invites 12+ turns back.
T = T[:2] + filler(8) + T[2:]
N = len(T)
P = [
    probe(ID, 1, N, "and where does it leave from?", "previous", ["Orchard Point Hotel"], [r"orchard point"]),
    probe(ID, 2, N, "what was I going to get Priya?", "gap", ["silk scarf from Kiln & Loom"], [r"silk scarf|kiln"]),
    probe(ID, 3, N, "what's the RSVP email for Priya and Tom?", "tool-detail", ["rsvp@priyatom.example.com"], [r"rsvp@priyatom\.example\.com"]),
    probe(ID, 4, N, "when do I have to RSVP to Maya by?", "distant", ["RSVP by 3 Oct"], [r"\b3(rd)? oct|oct(ober)? 3(rd)?\b"], [r"30 oct|oct(ober)? 30"]),
    probe(ID, 5, N, "what time is the October wedding ceremony?", "same-word", ["11:00 am"], [r"11(:00)? ?am"], [r"4:30|3:15"],
          "Two weddings; the previous exchange mentions 3:15 pm for the November one."),
    probe(ID, 6, N, "different thing: when is the keyboard arriving?", "switch", ["Thursday"], [r"thursday"], [r"3:15|14 nov"]),
]
FIXTURE = {"id": ID, "description": "Two weddings a month apart with different times, venues and RSVPs, interleaved with parcels, stocks and gift planning.", "turns": T, "probes": P}
