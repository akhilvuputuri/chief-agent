# Mail recall: fusion and re-ranking

Offline comparison of retrieval methods for `gmail_recall` ([design](../../docs/mail-recall.md), [journal 120](../../docs/journey/120-email-memory-mvp.md)). It answers which ranked list finds a half-remembered email best:

- Gmail keyword search (today's email agent);
- meaning search (`gmail_recall` as deployed);
- local BM25;
- fusions of these lists;
- optionally, a local re-ranking model.

Nothing here calls a model or network API, and nothing needs a credential.

## 1. Export a dataset (operator, production)

The dataset comes from the production container, where the Gmail and OpenRouter credentials are. It contains email text, so it must stay in the private operations folder and never enter this repository.

```sh
OPS=/path/to/hermes-companion-ops
umask 077
ssh -F "$OPS/ssh_config" chief-lightsail \
  "sudo -n docker exec hermes-companion-gateway-1 node dist/mail-recall-eval.js 30 --export" \
  > "$OPS/mail-recall/$(date +%F)-export.jsonl"
```

- **Build time:** the eval builds its own index first (about 17 minutes for 12 months).
- **Quota:** the build reads against the same Gmail per-user quota as Chief.
- **What it writes for each question:**
  - the question;
  - the target message;
  - each planned Gmail query's results in Gmail's order;
  - every chunk's meaning-search score.
- **Then:** every indexed chunk with its message headers.

## 2. Compare methods (anywhere, offline)

```sh
kite run eval:mail-recall -- "$OPS/mail-recall/2026-10-28-export.jsonl"
kite run eval:mail-recall -- "$OPS/mail-recall/2026-10-28-export.jsonl" --json
```

**Conditions:**

| Name         | Ranking                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| `keyword`    | Gmail results in the order the agent reads them (query by query, Gmail's order within each), first `--k` only |
| `dense`      | `gmail_recall` as deployed: a message scores as its best chunk                                                |
| `dense-top2` | mean of a message's two best chunks                                                                           |
| `bm25`       | Okapi BM25 over each message's indexed text                                                                   |
| `rrf(...)`   | reciprocal rank fusion (k = 60) of the named lists                                                            |
| `rerank`     | a local cross-encoder re-ranking the top `--rerank-depth` (30) of `--rerank-base` (`rrf(dense,keyword)`)      |

**Reported for each condition:**

- found at ranks 1, 5 and `--k` (8), the deployed result count;
- a Wilson 95% interval;
- MRR@10;
- exact McNemar tests and paired bootstrap differences against `keyword-all` and `dense`.

Two reference sets are reported with their mean size. They count the target anywhere, not in the first `--k`:

- `keyword-all`: every Gmail result the agent sees, up to 3 searches × 10. This is today's email agent, and the comparisons are made against it.
- `union`: `keyword-all` plus `gmail_recall`'s top 8. This is the agent with both tools.

A ranked list's first 8 and a reference set of up to 38 messages are different budgets; read the comparisons with that in mind.

## Optional re-ranker

```sh
python3 -m pip install sentence-transformers
kite run eval:mail-recall -- EXPORT.jsonl --rerank BAAI/bge-reranker-v2-m3
```

The model downloads once and runs on the local machine, so email text never leaves it. Each candidate is scored on its headers plus its best-matching chunk.

## Limits

- **Synthetic questions:** a model writes them without the subject's or sender's words. That models half-remembered requests and disadvantages keyword search. Add owner-written questions for the stronger test.
- **Retrieval only:** it scores retrieval, not the agent's final answer.
- **Fixed embeddings:** they come from the export, so trying another embedding model needs a new export.
- **Small samples:** about 30 questions per export. Read the intervals before the point estimates.

## Tests

`python3 -m unittest discover -s evals/mail-recall -p 'test_*.py'` uses synthetic data only and runs in `kite test`.
