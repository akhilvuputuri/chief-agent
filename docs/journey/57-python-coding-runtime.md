# 57 — Python execution behind Chief’s durable coding gateway

Work date(s): 2026-10-03. Status: tested candidate; review, immutable image publication and deployment pending. Coding remains off; no paid model/sandbox acceptance.

## User-visible problem and preceding iteration

[Journal 56](56-coding-runtime.md) established durable coding dispatch and an isolated TypeScript worker, installed default-off. The requested refactor moves the disposable execution runtime to Python while preserving Chief’s dispatch and updates. OpenRouter remains the model adapter; DeepSeek V4.1 Flash is the requested initial coder.

## Evidence

Implementation began from freshly fetched main `bc1319faa8d266b23437091b202af38b9e8f730e`; that revision has a successful exact release receipt. Synthetic Python tests cover a real local Git/npm candidate, separate review checkout, cancelled processes, failed checkpoint acknowledgement, Unicode/modes/deletions/renames, wire bounds, reasoning preservation and Python/TypeScript artifact identity. No provider quality or cost comparison was measured. OpenRouter’s [model listing](https://openrouter.ai/deepseek/deepseek-v4.1-flash) confirms the selected model identifier; its [reasoning guide](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) requires unchanged reasoning details across tool continuation. Existing price ceilings remain in force.

## Diagnosis and alternatives

Chief’s owner-scoped durable service is still TypeScript. Python owns subprocess supervision, Git artifact validation, the tool loop and separate review contexts behind a versioned JSON protocol. This matches independent execution lifecycles and avoids coupling the worker image to the complete Chief compilation. Keeping the independently packageable worker inside this repository preserves atomic contract tests and changes; repository extraction can follow without changing the service boundary. This decision makes no claim that Python inherently improves model coding quality or parallel throughput.

## Implementation and review

[The package](../../coding_runtime/README.md) contains strict Pydantic contracts, HTTPX OpenRouter/gateway adapters, cancellable asyncio subprocess groups and bounded Git snapshots. Production provider credentials remain on Chief. Python isolated mode and ctypes dumpability protection replace the worker’s Node inspector/N-API guard; CI tests the actual Linux launcher. Node modules remain for historical pinned job/image compatibility only. The source initially keeps the existing Node image until a separately reviewed Python digest/selector update; coding stays off. No DB/Compose or owner approval boundary changes.

Independent exact-head review is pending. Local Docker validation is unavailable because the daemon is stopped; Linux image validation must pass in CI. Local full checks passed: 672 application tests, 22 JavaScript script tests, 30 existing Python tests and 17 coding-runtime tests, plus strict typechecks, build and formatting. The independently built Python wheel also passed. Image/process isolation validation remains a CI requirement.

## Verification and outcome

Offline tests establish protocol, artifact and lifecycle behavior with synthetic inputs; they do not establish live CodeBuild pull/region availability, paid DeepSeek behavior, reviewer quality or owner Telegram acceptance. Scoped provider identity/project, repository-only GitHub App and authenticated ingress remain the activation prerequisites from journal 56. No credentials were exported and no paid infrastructure was provisioned.

## Follow-up and next iteration

Publish the Python image from reviewed main, verify anonymous immutable manifest access, pin its digest with the Python selector, and verify the exact application release. Live paid plan/candidate acceptance remains separately requested work.
