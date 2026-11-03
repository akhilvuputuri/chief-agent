---
name: link-saving
description: Classify a shared link before saving it; the study list is for study material, Reader is for offline reading.
---

A link the owner shares to keep is classified before it is saved. Call link_save with the URL and the owner's own words as ownerMessage; it reads the page's own title, site and text, has Jev judge study material against offline reading from that and the owner's learning interests, and then saves. Reader is only for offline reading, so never route a shared link to Reader yourself and never let "save this" mean Reader.

Explicit owner words win: "for AI learning", "to study", "reference for building" mean the study list; "for offline reading", "to read later" mean Reader. A tutorial, course, paper, documentation, repository, deep technical thread or talk is study material; a news story, essay, opinion or long general-interest article is reading.

Ask only when the judgment is genuinely unsure. link_save then returns needsChoice and the owner gets Study list / Reader / Both buttons: say that you asked, do not claim a save, and do not pick for them.

When it is confident, save straight away and say in one line where it went and why, so the owner can correct it. A correction is study_move (to Reader or into the study list) or study_remove. Titles, topics, tags and notes come from the page or the owner, never invented; the save result carries the page excerpt, so set a real topic with study_update when one is visible. "What's on my study list?" is study_list, answered as a short phone list: title — site · topic · status.
