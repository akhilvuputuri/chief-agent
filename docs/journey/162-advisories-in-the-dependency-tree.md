# 162 — Which published advisories reach Chief, and which can be fixed without a major upgrade?

Work date: 2026-11-11. Written: 2026-11-11.
Status: tested; release pending. Six packages are updated within their ranges. Three findings stay open, each named below: zod (fixed only in 4.x), minimatch (fixed only in 11.x) and the copy of undici that `pi-coding-agent` 1.1.0 pins. Workers get the Pi runtime's undici change only with the next pinned worker image.

## User-visible problem and preceding iteration

No incident is recorded. A query of the OSV database on 10 November (reported) listed published advisories against eight packages in the two lockfiles, four of them rated high, and nobody had checked whether Chief's code reaches the affected paths.

Earlier dependency work: [journal 126](126-fetch-hygiene-and-node.md) pinned Node 22.23.4 for its bundled undici, [journal 127](127-closing-dependency-hardening.md) closed #329, and [journal 156](156-room-for-the-whole-plan.md) made undici 8 a direct dependency of the Pi runtime.

## Evidence

**Measured, 11 November 2026.** Every package version in `package-lock.json` (365) and `coding_runtime_pi/package-lock.json` (179) was sent to `https://api.osv.dev/v1/querybatch`. Before the change the root lockfile had nine flagged versions and the Pi lockfile two; the list matched the 10 November report.

**Read from source, 11 November.** "Reached" below means Chief's code calls the affected path with input someone else controls. Each row was read in Chief's source and in the installed package; none was tested by attacking a running gateway.

| Package           | Advisories                             | Pulled in by                                                            | Reached by Chief?                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | -------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| undici 8.10.2     | 8 (4 high)                             | the Pi runtime directly; `pi-coding-agent` 1.1.0, which pins it exactly | Chief's own use is `patient-fetch.ts`: one `Agent` with two timeouts and a `fetch` to the worker's model route on Chief's gateway. It passes no `tls` option and uses no cache or redirect interceptor, `EventSource`, WebSocket or integrity check. The two crashes a server can cause need a hostile server, and that server is the gateway. `pi-coding-agent` sets up its own dispatcher only from Pi's command-line entry points, which Chief does not run. |
| body-parser 2.3.0 | 1 high (crash on a compressed body)    | express, from the MCP SDK's server modules                              | No. Chief imports only the SDK's client and validation modules. In the installed SDK only files under `server/` import express, and the client imports none of those files.                                                                                                                                                                                                                                                                                     |
| qs 6.16.0         | 1 moderate                             | body-parser and express                                                 | No, for the same reason.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ip-address 10.7.3 | 1 moderate                             | express-rate-limit, from the MCP SDK's server modules                   | No, for the same reason.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| fast-uri 3.1.8    | 4 (low and moderate)                   | ajv 8.20.0                                                              | Ajv resolves schema `$id` and `$ref` with it when `mcp-validator-worker.ts` compiles a schema an MCP server supplied. Chief never fetches a referenced schema or decides anything from the resolved address, which is what the advisories (host confusion, scheme spoofing) concern.                                                                                                                                                                            |
| fast-uri 4.2.1    | the same 4                             | fastify's schema compilers                                              | No. They resolve references in route schemas, and Chief declares none.                                                                                                                                                                                                                                                                                                                                                                                          |
| fastify 5.12.5    | 1 low (header schema bypass)           | Chief directly                                                          | No. It needs a route `headers` schema with `propertyNames`; Chief declares no route schemas.                                                                                                                                                                                                                                                                                                                                                                    |
| zod 3.25.76       | 1 high (memory)                        | Chief directly (68 imports), the MCP and Anthropic SDKs                 | Yes, within each route's body limit. See the measurement below.                                                                                                                                                                                                                                                                                                                                                                                                 |
| minimatch 10.2.6  | 1 moderate (slow on a crafted pattern) | `pi-coding-agent` 1.1.0, which pins it exactly                          | It matches Pi's package filters and model-scope patterns. Chief builds Pi's settings in memory and registers one model, so no pattern comes from a repository or a model. Read in the installed package, not traced exhaustively.                                                                                                                                                                                                                               |

Node's own `fetch`, which the gateway uses everywhere else, runs the undici bundled with Node 22.23.4: 6.29.1 (measured, `process.versions.undici`), the release that fixes these advisories in the 6.x line.

**Measured: zod 3.25.76 on an oversized array, 11 November, Node 22.23.4, a Mac.** The schema was an object holding an array of strict objects with `.max(2048)`, the shape of the worker's model request. The body was a JSON array of `0`, sized to a body limit. zod checks every element even when the array is over its maximum, and keeps one issue per element.

| Body size | Where Chief allows it                          | Elements | Parse time | Heap growth |
| --------: | ---------------------------------------------- | -------: | ---------: | ----------: |
|    120 kB | the gateway's default, including public routes |   59,992 |      36 ms |       22 MB |
|    400 kB | box events                                     |  199,992 |      87 ms |       62 MB |
|      4 MB | a worker's model request                       |      2 M |      1.0 s |      577 MB |
|      8 MB | other worker routes                            |      4 M |      2.6 s |     1.10 GB |

The same 4 MB and 8 MB bodies on zod 4.6.7, installed in a scratch directory, returned one issue in 2 ms with no heap growth.

The 4 MB and larger bodies are accepted only on coding worker routes, which need a job's bearer token. Checkpoint and finish uploads go up to 64 MB and were not measured. Whether a command the coding model runs in its sandbox can read that token was not traced. The production host's free memory was not read.

## Diagnosis and alternatives

- **Fixed inside the declared ranges:** body-parser, qs, ip-address, both fast-uri copies and fastify. `kite update` takes the newest version each range allows, so fastify went to 5.12.8 rather than 5.12.6 and qs to 6.17.1 rather than 6.16.1. fastify 5.12.8 requires find-my-way 9.10.0, which brought ret 0.5.1 and safe-regex2 5.1.2.
- **undici 8.12.4, not 8.12.2.** OSV names 8.12.2 as the fixed version. undici's release notes for 8.12.4 (5 November) list six more advisories against 8.12.2 and 8.12.3, one of them high (GHSA-mqg3-3v4r-cm32, cache poisoning across a redirect chain). OSV listed none of them against 8.12.2 or 8.12.3 on 11 November. Reported by upstream, not checked against the code.
- **`pi-coding-agent`'s copy of undici stays at 8.10.2.** Version 1.1.0 pins `undici` to exactly 8.10.2, so raising the Pi runtime's own pin gives that package a second, nested copy. Kite refuses `overrides` in `package.json`, so the pin cannot be overruled from here. `pi-coding-agent` 1.5.0 and later pin undici 8.12.3 and minimatch 11.0.3.
- **zod has no 3.x fix.** 3.25.76 (July 2025) is the last 3.x release; the advisory is fixed in 4.6.6. Moving 68 importing files to zod 4 is a major upgrade and was not attempted. A length check before zod on the worker routes would bound the measured growth without the upgrade; not built.
- **minimatch is fixed only in 11.0.1.** It is not a dependency Chief declares; it arrives with `pi-coding-agent`, and changes only by upgrading that package from 1.1.0 to 1.5.x, four minor releases of the coding harness that have not been evaluated here. Not attempted.

## Implementation and review

- `coding_runtime_pi/package.json`: `undici` 8.10.2 → 8.12.4.
- `coding_runtime_pi/package-lock.json`: `node_modules/undici` 8.12.4, and `pi-coding-agent`'s nested 8.10.2.
- `package-lock.json`: body-parser 2.4.0, qs 6.17.1, ip-address 10.7.6, fast-uri 3.1.9 and 4.2.3, fastify 5.12.8, find-my-way 9.10.0, ret 0.5.1, safe-regex2 5.1.2, and undici 8.12.4 under `coding_runtime_pi`.
- No source change, no database or Compose change.

All versions were changed with Kite (`kite update …` in the root, `kite install undici@8.12.4 -E` in the Pi runtime). Kite sorted the Pi runtime's dependency keys; the original order was restored by hand and Kite kept the lockfile unchanged.

## Verification and outcome

- **Measured after the change:** the same OSV query flags three versions in the root lockfile (undici 8.10.2, zod 3.25.76, minimatch 10.2.6) and two in the Pi lockfile (`pi-coding-agent`'s undici 8.10.2, minimatch 10.2.6), down from nine and two.
- **Tested, 11 November, a Mac on Node 22.23.4:** after a clean `kite ci`, `kite run check` exited 0 in 6 min 19 s with no failing test, and `kite run format:check` passed. The Pi runtime's 123 tests, which include the patient-fetch tests, ran on undici 8.12.4.
- **Not verified:** the gateway under real traffic on fastify 5.12.8, and a worker on undici 8.12.4. Workers run the pinned image built from `fa058f9`, which still has undici 8.10.2 throughout.

## Follow-up and next iteration

- Publish and pin a worker image built from this change, so workers get undici 8.12.4.
- Owner decisions: upgrade `pi-coding-agent` to 1.5.x (removes the old undici copy and minimatch 10), and either move to zod 4 or add a length check ahead of zod on the worker routes.
- Report to Kite's owner: `overrides` is unsupported, and `kite ci` stopped with "Directory not empty" when it could not remove an existing `node_modules` (a `.DS_Store` had appeared in it; cause not established).
