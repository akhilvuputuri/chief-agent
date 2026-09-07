# Model response recovery

On 8 September 2026, a request asking how many saved roles existed failed after one model call and zero tools. Run `f2e85a82-1690-43f7-a176-efb42b781fb1` recorded no usage. The adapter found neither usable text nor tool calls and treated that as a permanent failure. The original response was not retained, so an upstream error envelope versus an empty successful response cannot be established retrospectively. The 31 job records were unaffected.

The adapter now recognizes error envelopes even on HTTP success, classifies numeric 429/5xx provider errors as transient, and treats blank responses as transient unless the finish reason indicates output exhaustion or filtering. Existing execution accounting limits retries to two additional model calls within the same budget. No tool is dispatched from a rejected response. Price ceilings, reasoning effort and output limits remain unchanged.

Failure events retain only structural diagnostics: response ID, provider, finish reason, numeric error code and whether usage was returned. They do not retain raw error messages, reasoning, prompts or credentials. Actual usage continues to be recorded when supplied; missing charges remain unknown.

Regression checks cover empty-response recovery through the runtime, error-envelope classification, non-retryable output exhaustion, whitespace-only answers, safe diagnostics and the existing retry bound. This improves recovery and observability; it does not prove the original provider's underlying failure has been eliminated.
