# 57 — Python execution behind Chief’s durable coding gateway

Work date(s): 2026-10-03. Status: refactor integrated; Python image published and anonymously verified; image pin review and application release pending. Coding remains off; no paid model/sandbox acceptance.

## User-visible problem and preceding iteration

[Journal 56](56-coding-runtime.md) established durable coding dispatch and an isolated TypeScript worker, installed default-off. The requested refactor moves the disposable execution runtime to Python while preserving Chief’s dispatch and updates. OpenRouter remains the model adapter; DeepSeek V4.1 Flash is the requested initial coder.

## Evidence

Implementation began from freshly fetched main `bc1319faa8d266b23437091b202af38b9e8f730e`; that revision has a successful exact release receipt. Synthetic Python tests cover a real local Git/npm candidate, separate review checkout, cancelled processes, failed checkpoint acknowledgement, Unicode/modes/deletions/renames, wire bounds, reasoning preservation and Python/TypeScript artifact identity. No provider quality or cost comparison was measured. OpenRouter’s [model listing](https://openrouter.ai/deepseek/deepseek-v4.1-flash) confirms the selected model identifier; its [reasoning guide](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) requires unchanged reasoning details across tool continuation. Existing price ceilings remain in force.

## Diagnosis and alternatives

Chief’s owner-scoped durable service is still TypeScript. Python owns subprocess supervision, Git artifact validation, the tool loop and separate review contexts behind a versioned JSON protocol. This matches independent execution lifecycles and avoids coupling the worker image to the complete Chief compilation. Keeping the independently packageable worker inside this repository preserves atomic contract tests and changes; repository extraction can follow without changing the service boundary. This decision makes no claim that Python inherently improves model coding quality or parallel throughput.

## Implementation and review

[The package](../../coding_runtime/README.md) contains strict Pydantic contracts, HTTPX OpenRouter/gateway adapters, cancellable asyncio subprocess groups and bounded Git snapshots. Production provider credentials remain on Chief. Python isolated mode and ctypes dumpability protection replace the worker’s Node inspector/N-API guard; CI tests the actual Linux launcher. Node modules remain for historical pinned job/image compatibility only. The source initially keeps the existing Node image until a separately reviewed Python digest/selector update; coding stays off. No DB/Compose or owner approval boundary changes.

GPT-6 Astra requested changes at `16822c128a2cfbee2796e474a134f4612ca6e9f0`: a detached child could retain stdout and defeat cancellation; preserved file-write arguments could exceed the gateway’s old per-call limit on continuation. Regressions reproduce both. Commands now own a separately closable output transport and Linux subreaper adoption terminates/reaps detached descendants. Repository commands are serialized within the worker. The gateway argument limit aligns with the unchanged 180,000-byte total envelope; provider arguments and reasoning are never truncated. GPT-6 Astra re-reviewed and APPROVED exact head `e0b0b63cf629544ef41d025fa1eec9efc682f964`; independently passed all 19 Python tests and 39 TS coding tests and reproduced both corrected boundaries. [Exact-head Linux CI](https://github.com/akhilvuputuri/chief-agent/actions/runs/37098356317) then passed, including actual isolated-launcher and detached-descendant smoke. [PR #154](https://github.com/akhilvuputuri/chief-agent/pull/154) merged at `888caea5fecb2d431190233195d7f93a0c78f461`. Release preparation identified that the manual release path also runs the combined checks; it now installs the same Python version and hash-locked dependencies as CI. Local Docker validation was unavailable because the daemon was stopped; Linux image validation passed in CI. Local full checks passed: 672 application tests, 22 JavaScript script tests, 30 existing Python tests and 19 coding-runtime tests, plus strict typechecks, build and formatting. The independently built Python wheel also passed. Linux image/process isolation passed in exact-head CI.

## Verification and outcome

Offline tests establish protocol, artifact and lifecycle behavior with synthetic inputs; they do not establish live CodeBuild pull/region availability, paid DeepSeek behavior, reviewer quality or owner Telegram acceptance. Scoped provider identity/project, repository-only GitHub App and authenticated ingress remain the activation prerequisites from journal 56. No credentials were exported and no paid infrastructure was provisioned.

## Follow-up and next iteration

Publish the Python image from reviewed main, verify anonymous immutable manifest access, pin its digest with the Python selector, and verify the exact application release. Live paid plan/candidate acceptance remains separately requested work.

### Image publication — 3 October 2026

The [trusted main workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/37098839625) successfully published the Python image from merge `888caea5fecb2d431190233195d7f93a0c78f461` at `ghcr.io/akhilvuputuri/chief-agent-coding@sha256:7011f47cb757f1b2069f4f82f63c3869c1684e0e387d0668a6d1d1cb10122c81`. Anonymous requests verified SHA-256 for the index, amd64/Linux manifest and config blob, plus user `worker` and the isolated Python entrypoint. This is image availability evidence, not a paid CodeBuild execution. The pin candidate switches image and host launcher together; review/deployment remain pending. A private bounded preflight verified current production `bc1319f`, healthy gateway/Postgres, migration 25, no active/pending inputs, coding off and zero coding jobs. No user records or credentials entered this journal.
