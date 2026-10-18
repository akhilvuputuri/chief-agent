# 96 — Replaying the bulletin rankers: no ranker is distinguishable from chance once a confound is removed

Work date(s): 2026-10-18 to 2026-10-19. Written: 2026-10-19.
Status: measured offline; no runtime change. The Jev ranking change ([PR 250](https://github.com/akhilvuputuri/chief-agent/pull/250)) is on hold pending this evidence.

## User-visible problem and preceding iteration

- **The question.** The owner asked whether Jev (TypeSafe's decision model) improves the daily news bulletin ([news bulletin](../news-bulletin.md)).
- **What PR 250 proposes.** Jev ranks each edition's shortlist with one yes/no question per article ("would the owner read and save this?"). It adds an exploration slot and a full candidate log.
- **Why replay first.** Before merging, past editions were replayed to check whether Jev ranks saved items higher than the deterministic ranker does. That ranker combines recency, site affinity and TF-IDF word overlap with Reader saves.

## Evidence

All results are measured offline on 18 October from an owner-authorized, read-only export of production bulletin history. The export is kept in owner-only private scratch; only aggregates and categories are recorded here.

- **Data.**
  - 19 sent editions (29 September to 18 October), 138 shown items, 7 saved to Reader from the bulletin.
  - Three followed sources (news and analysis sites); no topics are configured.
- **Method.**
  - Each item was scored by Jev 1.13 (`typesafe/jev-1.13-20260917`) two ways, one request per item:
    - the released yes/no question;
    - a graded `score` question with five levels, from "not for the owner" to "exactly their kind of story".
  - Jev's context for each edition held only saves made before that edition was sent.
  - The deterministic score is the one stored with each item.
  - Metric: AUC, the probability that a saved item outscores an unsaved one, where 0.5 is chance.
  - Cost: $0.006.

### First result, across all 138 items (confounded)

| Ranking                                                 | AUC  |
| ------------------------------------------------------- | ---- |
| Deterministic ranker                                    | 0.83 |
| Jev graded                                              | 0.75 |
| 50/50 blend of z-scored deterministic and graded scores | 0.86 |
| Jev yes/no                                              | 0.41 |

### The confound

- **Most items could not be saved.** Save-to-Reader buttons replaced votes on 15 October ([PR 228](https://github.com/akhilvuputuri/chief-agent/pull/228), [journal 86](86-news-reader-saves.md)), and no votes were ever cast. So the 118 items before 15 October could not be saved from the bulletin at all. All 7 saves come from the last 4 editions (20 items).
- **The same editions were the only ones with context.** The last three were the only editions with saves in Jev's context (2, 5 and 6 saves); the first save-era edition had none. The graded mean per edition was 0.20–0.29 for the 15 earlier editions, then 0.25 (no context yet), 0.86, 1.27 and 1.24.
- **Correlations confirm it.** Correlation with the number of saves in context was 0.71 for graded Jev and 0.57 for the deterministic score. The deterministic score's site affinity also grows as the owner saves.
- **What the first table measured.** Its AUCs mostly measured "is this a recent edition", not article quality.

### Valid comparison

Items that could be saved (the last 4 editions, 20 items, 7 saved):

| Ranking                      | AUC  |
| ---------------------------- | ---- |
| Display position (top first) | 0.46 |
| Deterministic ranker         | 0.40 |
| Jev yes/no                   | 0.38 |
| Jev graded                   | 0.36 |
| 50/50 blend                  | 0.36 |

- Under the null hypothesis, the standard deviation of the AUC for 7 against 13 items is about 0.14. Every method is indistinguishable from chance.
- Pairs within the same edition (20 saved/unsaved pairs) give 0.45–0.50 for every method.
- The owner saved 7 of 20 shown items (35%), and the saves were not predicted by any available score.

### What the scores do measure (descriptive, all 138 items)

- **Graded Jev follows resemblance to past saves:** correlation 0.60 with site affinity and 0.51 with word overlap. It does not follow recency (correlation 0.01). Its overall median is 0.24 on the 0–4 scale, and it rises only in editions with saves in context.
- **The deterministic score is mostly recency:** correlation 0.77. Its word-overlap term is usually near zero.
- **The two disagree a lot on live feeds.** On 18 October's 23 new candidates, the four top picks did not overlap. Jev favoured stories resembling past saves; the deterministic ranker favoured the freshest items.

## Diagnosis and alternatives

- **Facts.** With 7 labels, all from 4 editions, the data cannot show that any ranker, Jev or deterministic, predicts the owner's saves. The first, favourable numbers came from a time confound between label availability and Jev's context. A whole-history AUC is not a valid evaluation here.
- **Hypotheses, not shown by this data:**
  - Jev adds a semantic "resembles saved articles" signal that the deterministic ranker lacks.
  - The graded question is better than yes/no.
  - External research supports graded over yes/no for relevance ranking in general; see the 18 October research report summarized in PR 250's journal.
- **What would change the conclusion.** Labels unaffected by the confound:
  - more saves under the Save buttons, with candidate pools logged (PR 250);
  - interleaving the two rankers within editions;
  - a one-off owner rating session on logged candidates.

## Implementation and review

No code changed. The eval scripts and export are in private scratch, not the repository. Their method is recorded above, so the replay can be repeated on later data with the same split.

## Verification and outcome

**Measured:**

- the confounded and valid AUCs above;
- the correlations;
- the save-era base rate, 7 of 20.

**Not measured:**

- whether any ranker improves the save rate;
- Jev 1.14;
- the redesigned questions (graded per interest area plus a substance axis);
- embedding similarity to the Reader library.

## Follow-up and next iteration

- **Evaluation rule.** Only compare rankers on items that had a chance to be labelled, by edition or within edition. Never compare across the change in feedback mechanism, and keep Jev's context time-correct.
- **PR 250.** Do not ship yes/no Jev as the sole ranker on this evidence. Ship the candidate logging and exploration slot so valid labels accumulate, and run any Jev variant as a challenger: interleaved, or as a blend with fixed weights.
- **Faster labels.** An owner rating session on logged past candidates would give more labels in one sitting than months of saves.
- **Re-run this replay** on the save era once about 20–30 saves exist, with the same split, plus the redesigned Jev questions.
