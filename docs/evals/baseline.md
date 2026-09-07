# Initial baseline — 7 September 2026

Production runtime code at ca2c04a; evaluation tooling was uncommitted (dirty=true). Synthetic data only. This is one trial per case, not a statistical performance estimate.

| Case             | Result | Model calls | Tool calls |
| ---------------- | ------ | ----------- | ---------- |
| collection       | FAIL   | 15          | 39         |
| missing-evidence | PASS   | 12          | 21         |
| scope-change     | PASS   | 18          | 27         |

The context-retention probe failed. Missing evidence and scope change passed. The collection failed to produce a complete graded artifact; coverage zero measures the final answer, not whether tools retrieved any records.

collection: stop reasons budget_exhausted.
missing-evidence: stop reasons answer.
scope-change: stop reasons answer, answer.

Admission accounting: $0.997905; source usage is available in private local traces. This is not a provider invoice.

The suite uses an explicit JSON final-answer contract. Natural-language hallucinations and usefulness still require human review. The preliminary pre-contract-correction trial is excluded from this baseline.
