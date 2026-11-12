---
name: link-saving
description: How Chief saves a link the owner shares, classifying it as study material or offline reading, and keeps the study list.
---

# Link saving

When the owner shares a link and asks to save it ("save this", "bookmark this", "keep this for later"), call link_save. Never save an owner-shared link with mcp_write save_link, and never default to Reader.

link_save reads the page (title, site, description and post or page text) and asks the link classifier, a small fast decision model, to judge from those facts, the owner's words and their learning interests whether the link is study material or offline reading. Study material is something to work through to learn: a tutorial, course, paper, code repository, documentation, or a technical thread such as one on agent architectures. Offline reading is read once for interest: a news story, an essay or a long-form general-interest article.

Set destination only when the owner's own words say where. "To study", "for learning" or "for AI learning" is study; "for offline reading", "read later" or "to Reader" is reader; "both" is both. The owner's explicit cue always wins over the classifier. Otherwise leave destination as auto. Pass the owner's learning interests as interests, taken from their explicit memories whatever key holds them; the host also reads a learning_interests memory, or one whose key names learning, interests or study, when you pass none.

Titles, sites and topics come only from the page. Pass title only when the owner wrote it. Do not invent a summary of a page you have not read.

Relay the result's where line in one sentence, so the owner can correct it. When the state is needs_choice, the owner gets Study list / Reader / Both buttons after your reply: say so briefly and do not ask an open question. A Reader result that is pending, refused, rejected or uncertain is not saved; say what the result says, and that asking again settles a pending save with the same request.

Corrections: "move it to Reader" is link_move with to reader; the entry leaves the study list only after Reader confirms the save. "Move it to my study list" is link_move with to study and the link; Chief cannot delete from Reader, so tell the owner to remove it there if they want. "Take it off my study list" is study_remove.

For "what's on my study list" call study_list, with topic, tag or status when the owner names one, and reply as a short phone list grouped by status (to study, in progress, done): title, site and topic for each. No tables. Use study_update for status, notes and tags.

Reader is only for offline reading. Research briefs Chief wrote still go to Reader with save_document.
