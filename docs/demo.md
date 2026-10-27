# Five-minute demo

Use an isolated database, a test Telegram bot and synthetic personal information. Never record the production bot, real mail, real holdings or real invoices. The goal is to show inspectable behaviour and its control boundaries, not to imply measured quality.

1. **Conversation and memory.** "Remember that I prefer short morning briefings." Restart the gateway, then ask what it has saved.
2. **Voice.** Send a short voice note: "Remind me to renew my passport next Friday at 9." Then show the saved reminder in `/items` or `/schedules`.
3. **Approval.** "Put a 30-minute call with Sam on Thursday at 3pm on my calendar." Show the approval card, deny it, and confirm that nothing was created. Then approve a fresh request if a test calendar is connected.
4. **Tracking.** "Add a streaming service, 15 SGD monthly, renews on the 5th. Remind me three days before." Ask what renews in the next 30 days, and open the Mini App's Subscriptions tab.
5. **Delegation and evidence.** Ask for a tracked, multi-step public research task, for example comparing three sources on one question. Open `/status` to show its steps, the agent run and its source-backed evidence.
6. **Local data.** If Singapore keys are configured: "Is it raining near Orchard right now?" or "When is the next bus at stop 01012?"
7. **Coding (optional).** On a test repository, describe a small change. Show the plan card, and show that nothing is built until it is approved.
8. **Trace.** Show the sanitized operational log lines for the turn. Explain that identity, tools, approvals and budgets belong to the host, not the model.

Before recording: verify live provider access, keep keys out of the terminal, redact personal data and label synthesized speech. Do not claim performance, usage or quality numbers that have not been measured. Pair the demo with the README architecture diagram, and with one real failure from the [engineering journal](journey/README.md) and how it was fixed.
