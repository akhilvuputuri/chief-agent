# 110 — Can Chief draft IBKR orders without being able to trade?

Work date: 2026-10-20. Written: 2026-10-20.
Status: released in `ac94d23` on 21 October 2026 (SGT). Owner reconnect and live acceptance pending.

## User-visible problem and preceding iteration

[Journal 59](59-ibkr-portfolio.md) gave Chief read-only IBKR holdings. The owner connected on 15 October, and the holdings matched their IBKR app. On 20 October the owner noticed IBKR's "AI Instructions" tab: an assistant can propose an order, and the owner turns it into a real order with Review & Submit in an IBKR app. The owner asked Chief to use it, with every trade still needing their approval in the app.

The owner set the rules during the work: review-and-approve only, no autonomous trading; whole shares only, no options; each draft worth at most USD 200, then lowered to USD 100. They asked for no further restrictions.

## Evidence

All measured on 20 October 2026 with a new operator probe, [`scripts/ibkr-trade-probe.mjs`](../../scripts/ibkr-trade-probe.mjs), on the owner's Mac with a separate owner consent. Only structure, ids and draft terms were printed; no account values or tokens.

- **Measured: IBKR refuses the direct-order scope.** Requesting `mcp.read mcp.write mcp.orders.submit` was granted `mcp.read mcp.write`. Access tokens lasted 299 s.
- **Measured: IBKR added live-order tools.** The catalogue grew from 34 tools (2 October) to 45, including `submit_order`, `modify_order`, `cancel_order`, `preview_order`, `answer_order_question` and `get_flow_type`. Their descriptions say each session is `AUTONOMOUS` (live orders with real money, no review) or `REVIEW_AND_APPROVE` (instructions only).
- **Measured: the consent was review-and-approve.** `get_flow_type` returned `REVIEW_AND_APPROVE`.
- **Measured and reported: drafts reach the owner's app.** Two identical one-share limit drafts were created (the owner ran the command twice); each create returned an id and an IBKR deep link. The owner reported both under AI Instructions in IBKR Mobile. IBKR set each draft to expire after 7 days, although it was a day order.
- **Measured, unexplained:** one listing straight after a create returned no drafts; a later listing showed both.
- **Measured:** contract search for a US ticker also returned Mexican and Canadian listings.
- **Corrected during the work:** a lost reply was first suspected when two drafts appeared; the owner's terminal showed two runs, each with its correct id.

## Diagnosis and alternatives

The earlier statement to the owner that no IBKR tool places a live order was true on 2 October and false on 20 October. Read-only safety cannot rest on IBKR's catalogue staying the same; it rests on Chief's allowlist and scope check.

- **Accept every scope IBKR grants** (owner's first instinct, "full potential"). Rejected by the owner once the autonomous flow was found: a direct-order scope would let a future IBKR tool skip the owner's review, and Chief's USD cap only guards the draft tool.
- **A Telegram approval before each draft.** Dropped at the owner's request: IBKR's Review & Submit is already the human gate.
- **One connection with read and write, or a separate drafting connection.** One connection was chosen: one consent, one token, and the existing refresh machinery. Holdings keep working on an older read-only grant. Whether two consents for one account coexist was not settled.
- **Limit-only, day-only, count caps, no short sales.** Proposed, then left out at the owner's request.

## Implementation and review

- `permitted()` in [`src/ibkr/oauth.ts`](../../src/ibkr/oauth.ts) accepts `mcp.read`, plus `mcp.write` only with drafts on, at connect and on every refresh; anything else is revoked and refused.
- [`src/ibkr/catalogue.ts`](../../src/ibkr/catalogue.ts) lists every callable IBKR tool; [`src/ibkr/mcp.ts`](../../src/ibkr/mcp.ts) refuses all others and runs multi-step sessions.
- [`src/ibkr/orders.ts`](../../src/ibkr/orders.ts) drafts: review-and-approve check, one US stock listing, USD cap, a single create, and a lookup instead of a retry after a lost reply.
- A separate `core/brokerage` agent owns the four new tools and appears only when drafts are on; the holdings agent is unchanged apart from wording.
- `IBKR_ORDER_DRAFTS=on` and `IBKR_DRAFT_MAX_USD=100` are in `config/runtime.json`. No migration, no Compose change.

Design and rules: [Order drafts](../ibkr-portfolio.md#order-drafts).

**Independent review of `a183872` (Opus 5.5): REQUEST CHANGES.**

- **Medium: the cap did not bound sells.** A sell limit was valued at its limit price, but a sell limit below the market fills at the market. "Sell 40 at 2.50" (meaning 250) passed as USD 100 and would have sold far more. Sells are now valued at the higher of the limit and the bid (else last). Regression test added.
- **Low: "nothing was created" after an IBKR error result.** The error could wrap a saved draft. Chief now looks for it first and no longer says nothing was created.
- **Low: never-twice held only within one call.** A re-delegation after an `unknown` could resend. Identical drafts are now blocked for 10 minutes, from an in-process record and IBKR's list.
- **Low: the 401 assumption was stated as fact.** It is now labelled a hypothesis, and the duplicate check covers it if it is wrong.
- **Low: a lost-reply match accepted drafts without a creation time.** It now requires one.
- **Low: the connect callback could fail on a wording lookup.** That lookup now falls back to generic wording.
- **Info: deletes were not confirmed.** A delete is now confirmed by listing afterwards.

**Re-review of `782dccb` (Opus 5.5): APPROVE**, with non-blocking findings:

- **Repeat check race.** Two identical requests at once could both pass the 10-minute check while one awaited IBKR's list. The record is now set before anything is awaited.
- **Stale repeat record.** The record outlived a confirmed delete, so redrafting the same terms was refused. It is now cleared on a confirmed delete.
- **Statuses.** `already_drafted` and `delete_unconfirmed` are now named in the brokerage agent's prompt.
- **Owner decision.** The 10-minute block also stops a deliberate second identical draft; it is left for the owner to accept.

Tests were added for the first two. Opus 5.5 approved `aa6c51c` and, after a docs-only rebase, `d6738d1`. Its remaining note was that a delete cleared all of the owner's repeat records; Devin found the same issue below.

**Devin Review of `d6738d1`:**

- **Red: the repeat check failed open.** An unreadable draft list counted as no duplicate, so a create after a restart could resend. The list check now fails closed: nothing is sent.
- **A delete cleared every record.** Deleting one draft cleared repeat protection for all the owner's drafts. Only the deleted draft's record is cleared now.
- **Different terms matched as repeats.** A different exchange or time in force counted as identical. The match now compares the listing's contract id and the time in force.

Tests were added for each.

**Opus 5.5 approved `5439d90`**, with one low finding and one note:

- **Low: the list's contract field is unmeasured.** A form such as `265598@NASDAQ` would make the repeat check miss after a restart. Contract ids are now compared numerically, falling back to the symbol.
- **Note: an expired token on that list read refused the draft instead of retrying.** It is now retried once, like any session, because nothing had been created yet.

Tests were added for both.

**Devin Review of `615a028`:** a create reply without a draft id was still reported as drafted, with a null id. Such a reply is now confirmed from IBKR's list, or reported as `unknown` and never resent. Devin dismissed its own other new comment, about background lookups. Holdings reads were already allowed in background work; drafts and deletes stay foreground-only. Opus 5.5 approved `5536c8b`, and then the docs-only rebases `bf1255a` (code byte-identical, checked by range-diff and patch-id). Hosted CI and Devin passed on `bf1255a`.

## Verification and outcome

- **Tested:** `tests/portfolio.test.ts` (PGlite and a fake IBKR server with the measured tool shapes) covers:
  - the scope rules, and refusing a write grant once drafts are off;
  - the US-shares and cap checks for buy and sell limits and for market drafts;
  - ambiguous and non-US listings, and the autonomous-flow refusal;
  - a lost reply found or reported unknown with exactly one create, and no resend of identical terms, including after a restart;
  - an IBKR error result that saved a draft, IBKR's error text, and a 401 retried once;
  - foreground-only drafting, list, confirmed and unconfirmed deletes;
  - the blocked live-order tools, bounded query results and agent gating.
- **Measured: a second consent ended Chief's grant.** Chief's holdings synced at 22:27 SGT on 20 October. The probe's consent for the same account followed at about 23:15. The next scheduled sync, at 02:27 SGT on 21 October, failed with `not_connected`, with no other change in between. Hypothesis: IBKR keeps one AI consent per account, even across clients. The owner reconnects after this release anyway, to grant order drafts.
- **Not yet verified:** a draft from Chief in production; the owner's reconnect with order-draft access; deleting a draft through IBKR.

### Release closure — 2026-10-21

- **Merged.** [PR #298](https://github.com/akhilvuputuri/chief-agent/pull/298) merged as `ac94d2355992b52839a6d1541fd048617be5658d`, from the approved head `bf1255a`.
- **Checks.** Hosted CI and Devin passed on that head. The [main checks](https://github.com/akhilvuputuri/chief-agent/actions/runs/39474326599) and the [automatic release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39476720645) succeeded.
- **Release receipt.** `release:status` reports the exact commit deployed with startup health passing (18:45 UTC).
- **Sanitized logs.** `ac94d23` started at 18:44 UTC with no startup error, and no environment override of the drafts settings.
- **Changes.** No migration or Compose change; no version tag.
- **Pending.** The owner reconnects with order-draft access, drafts a small limit order, sees it in IBKR Mobile, and rejects or deletes it. The probe's two test drafts expire on 27 October.

## Follow-up and next iteration

After review and release: the owner reconnects, drafts a small order through Chief, checks IBKR Mobile and removes the draft. Raising or removing the USD cap is a one-line change in `config/runtime.json`. Revisit if IBKR ever grants `mcp.orders.submit` or reports an autonomous session: Chief refuses both today.
