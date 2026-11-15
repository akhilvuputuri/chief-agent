# 196 — Can one coding worker request still exhaust the gateway's memory through zod?

Work date: 2026-11-16. Written: 2026-11-16.
Status: tested; release pending. The schemas a coding worker's request reaches check an array's length before its elements. Other schemas still use zod 3's array, behind body limits of 400 kB or less.

## User-visible problem and preceding iteration

No incident is recorded. [Journal 162](162-advisories-in-the-dependency-tree.md) left zod 3.25.76 flagged by GHSA-mrhx-c7xc-m3w5, with no 3.x fix, and measured the exposure on a schema shaped like a worker request: an 8 MB body of bad array elements grew the heap by 1.10 GB. It named two ways forward, zod 4 or a length check ahead of zod on the worker routes. The owner chose the length check on 16 November.

The worker routes changed between the two entries. Since [journal 190](190-pi-native-anthropic-protocol.md) a Pi worker's model calls go to a Messages route of up to 32 MB that the host validates by hand, with no zod schema. The routes that still parse a worker body with zod are checkpoint, finish and publish (up to 64 MB), progress and Pi session appends (8 MB), and the legacy model route (4 MB).

## Evidence

**Measured, 16 November 2026, a Mac on Node 22.23.4, main `ae551f33`, zod 3.25.76.** Each body is valid JSON of 8 MB holding one array of 4,000,000 zeros where the schema expects objects or strings, parsed with the real `checkpoint` and `outcome` schemas from `src/coding/schema.ts`. Heap growth is `heapUsed` after the parse minus before, after a forced collection.

| Array                                    | Before: issues | Before: time | Before: heap | After: issues | After: time | After: heap |
| ---------------------------------------- | -------------: | -----------: | -----------: | ------------: | ----------: | ----------: |
| `checkpoint.files` (max 500)             |      4,000,001 |        2.4 s |      1.12 GB |             1 |        1 ms |        0 MB |
| `checkpoint.piState.delivered` (no max)  |      4,000,000 |        2.0 s |      1.19 GB |             1 |        1 ms |        0 MB |
| `checkpoint.piState.conflicts` (max 500) |      4,000,001 |        1.7 s |      1.20 GB |             1 |      < 1 ms |        0 MB |
| `outcome.checks` (max 4)                 |      4,000,001 |        1.8 s |      1.16 GB |             1 |      < 1 ms |        0 MB |
| `outcome.options`                        |      4,000,001 |        1.6 s |      1.17 GB |             1 |      < 1 ms |        0 MB |

- **The host:** 1,906 MB of memory, 777 MB available, the gateway using 157 MiB (`free -m` and `docker stats`, read 16 November). The 8 MB case is more than what was available. A 64 MB body was not measured.
- **Who can send one (read from source):** checkpoint, finish and publish check the job's bearer token before the body is read; the other worker routes read and parse the JSON first, and zod runs after the token check on all of them. So the sender needs a live job's worker capability. Whether a command the coding model runs in its box can read that capability was not traced.
- **How zod 4 fixed it (measured, zod 4.6.7 in a scratch directory, 1,000,000 bad elements):** an array over its declared maximum returns one issue in 2 ms. An array with no maximum still returns one issue per element (687 MB). The package's `zod/v3` entry is not fixed: 1,000,001 issues, 298 MB.

## Diagnosis and alternatives

The mechanism is in zod 3's array type: it validates every element whatever the length, then adds the length issue, and keeps every element's issues. A declared `.max(500)` therefore bounds nothing while the body is being refused.

- **Move these schemas to zod 4 (the cause, not taken).** zod 4 checks the length first. Installing it changes what `import { z } from "zod"` means in 70 files, and its `zod/v3` entry, which would keep the old API, still has the fault. That is the major upgrade journal 162 reported instead of forcing, and it is still the owner's decision.
- **Chosen: replace zod's array in the worker schemas with one that does what zod 4 does.** `boundedArray` checks the declared minimum and maximum first and stops at the first element that fails. It uses the bounds the schemas already declare and adds none. It corrects the faulty part for these schemas; it is not the upgrade, and every other schema keeps zod's array.
- **Stopping at the first bad element** goes one step past zod 4, which still collects every issue of an array with no maximum. `delivered` and the legacy `reasoning_details` declare none, and giving them one would be a new limit with nothing to justify the number.
- **A size or element count checked before zod on each route (not taken).** It would be a second limit beside the ones the schemas declare, and it would have to be kept in step with them.
- **Building it on `z.array(z.unknown()).max(n)` (tried first, discarded).** zod 3 allocates for every element of any array it walks, so the over-long case still took 100 to 160 ms and 266 to 332 MB. The helper reads `Array.isArray` and `length` itself.

A refused body now reports its length or its first bad element and nothing after it. The host uses a zod failure only to answer `invalid_worker_payload`; no code reads the issue list (`src/coding/api.ts`).

## Implementation and review

- `src/bounded-array.ts`: `boundedArray(item, { min, max })`. A valid array parses to the same value as `z.array(item)`.
- `src/coding/schema.ts`, `squad-schema.ts`, `memory-schema.ts`, `pi-sessions.ts` and the legacy model request in `api.ts`: every array uses it, including arrays nested inside other arrays' elements, which the outer bound does not protect.
- `tests/bounded-array.test.ts`: equal results for valid arrays, an over-long array refused without reading an element, the first bad element ending the parse with its path, non-arrays refused as zod refuses them, one issue for an oversized array in each worker schema, a refinement on the enclosing object not running against a bad array, and a check that those five files contain no call spelled `array(`.

**Independent review (Claude Opus 5.5), 16 November, on `44bb151`: approved, with five notes.** It ran 76 inputs through the old and new schemas side by side and found the same acceptance and the same parsed values, and reproduced the table with heap figures about 10% lower (1.03 to 1.06 GB). Its notes, and what was done:

- A body is parsed as JSON before zod sees it. It measured a 64 MB checkpoint body of zeros at about 320 MB of heap in `JSON.parse`, with the process at 972 MB resident. Recorded below; not changed here.
- The test that scans the five files missed `.array()` and other spellings. It now refuses any call spelled `array(`.
- A value that was not an array let a refinement on the enclosing object run against zod's placeholder. The helper's issues are now fatal, so that refinement does not run, and a test covers it.
- The legacy model request, session batches, squad state and arrays nested in elements had no oversized case. `generation` and `batch` are exported and tested.
- The note in `docs/coding.md` was out of date order. Moved.

It approved `4e55174`, which holds those changes, after running the same 76 inputs again and checking that a fatal issue hides no issue on a neighbouring field.

No database, Compose or worker-protocol change: a payload that was valid is still valid and parses to the same value, so the pinned worker image needs no rebuild.

## Verification and outcome

- **Measured:** the table above.
- **Tested, 16 November, a Mac on Node 22.23.4:** `kite run check` exited 0 with no failing test on `44bb151` (6 min 0 s) and again on `4e55174` (6 min 24 s), the nine new tests among them. `kite run format:check` passed on `44bb151`, and the files changed since pass Prettier.
- **Not verified:** a real worker request through the changed schemas in production.
- **Still true after this change (reviewer's measurement):** reading a body costs memory before any schema runs. A 64 MB body of zeros took about 320 MB of heap in `JSON.parse` alone, against 777 MB available on the host. That is the price of the 64 MB allowance for checkpoint, finish and publish, which authenticate before they read.
- **Not changed:** the other 104 `z.array` uses in `src`. The largest body any of them can receive is 400 kB (box events), which journal 162 measured at 62 MB of heap.

## Follow-up and next iteration

- zod 4 remains the owner's decision. With it, `boundedArray(item, { max })` becomes `z.array(item).max(max)`, and the two arrays with no maximum need this helper or a declared one.
- Trace whether a command run in a coding box can read the job's worker capability.
- Whether checkpoint, finish and publish need 64 MB is a question for real payload sizes, which were not read here.
