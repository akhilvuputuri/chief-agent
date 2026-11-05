---
name: link-saving
description: Where a shared link belongs — study material versus offline reading in Reader — how explicit owner cues win, when Chief asks with tap options, and how corrections work.
---

# Saving a shared link

A link the owner shares to save goes through link_save, never straight to Reader. link_save reads the page and Jev judges the route from the page's title, site and description, the owner's own message and the owner's learning interests: applied AI engineering, agent platforms, developer tools, voice and conversational AI.

Study material is something to work through or learn from: a tutorial, course, paper, repository, documentation, or a technical thread, post or talk on those interests. Reader is for offline reading: a news story, essay, opinion, newsletter or long-form general-interest article, including a technology story read for information rather than studied. Both is only for substantial learning material the owner also wants available without a connection.

An explicit owner cue always wins, even over what the page looks like: "for AI learning", "to study" or "for the study list" means study; "for offline reading" or "read later" means Reader.

Save straight away when the classification is confident and relay the one-line receipt so the owner can correct it. When link_save returns unsure, nothing was saved: the host shows three tap buttons (Study list, Reader, Both) in a separate Telegram message. Do not ask an open question, do not choose a list, and do not save it anywhere.

Corrections: link_move moves an item between the study list and Reader, or removes it from the study list (Reader is unchanged). The Reader save completes before the study entry is removed. study_update changes status (to_study, in_progress, done), notes, tags or topic on the owner's request. study_remove removes one entry.

Never invent a title, topic, tag or reason. Titles and links come from the page; the topic comes from the tool's closed list. A Reader receipt means the service accepted the save, not that it is downloaded on the phone, and a refused, pending or unconfirmed Reader save is never reported as saved.
