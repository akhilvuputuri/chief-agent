# Manual Pi acceptance tooling

This is the owner-authorized verification campaign described in [the execution contract](../../docs/pi-runtime-verification.md). Importing these files or running their offline tests never launches paid work.

`workloads.json` pins target and fixture source separately. `prepare-oracle.mjs` writes a selected independent oracle outside the candidate workspace. Grade only after the coding process has stopped, in a fresh workspace restored from its exact saved artifact. Enforce allowed paths and unchanged check/dependency scripts before grading. The paid runner is still being implemented; preparation alone is not acceptance.

The temporary `model-broker.py` binds only loopback. Its operator-created mode-0600 configuration contains an exact public path, loopback port, trusted helper path, private ledger/trace paths, expiry and cases with IDs, random 256-bit test capabilities, selected models and pinned source SHA. Never put real capabilities in this repository, shell arguments, public logs or artifacts. Provider keys stay in the existing gateway container: `provider-helper.mjs` runs there using its existing adapter, price filters and high effort, forwarding each admitted request's output allowance. It records the adapter hash and missing billing explicitly.

The broker supports only generation and receipt-bound result uploads for its configured cases. Admission is persisted before provider dispatch; replay or an unresolved prior dispatch fails closed. It admits at most two concurrent cases and one call per case, within the existing 400-call allocation. EOF on the cancellation pipe aborts the provider request. Trace/result files are owner-only and contain synthetic workload evidence, never production conversation exports. The operational ledger omits prompts and generations.

Before use, independently review the exact broker/helper/runner code and offline checks. The operator may then add one temporary, exact-prefix HTTPS route to the existing reverse proxy, preserving its other routes, validate/reload it and verify unauthenticated requests fail. Keep a copy/hash of the original configuration. Do not restart the gateway, give workers provider credentials or modify owner jobs. After the campaign, stop this exact broker process and remove only its marked route, preserving concurrent configuration changes; validate/reload and verify the existing endpoints. Never leave the temporary model capability active indefinitely.

Offline checks:

```sh
node --test scripts/pi-acceptance/provider-helper.test.mjs
python3 -m unittest discover -s scripts/pi-acceptance -p 'test_*.py' -v
```

These checks use fake providers/processes. They are not paid-model, public-route, artifact-publication or production-release evidence.

For the CodeBuild workflow preflight, prepare the control checkout, dependencies, compiled modules and generated manual workflow as root, leaving them read-only to the worker. Execute the generated file directly with the worker UID, no new privileges/capabilities and `node --disable-sigusr1 --import tsx tests/pi-acceptance.manual.ts`. Do not wrap the live-capability process in `node --test`: that would leave another same-UID parent holding the original environment outside the native guard. Synthetic mode needs no broker or provider credential. Paid mode requires explicit configuration and the reviewed HTTPS capability; native output budgets, real streaming progress, cache IDs and policy are forwarded unchanged.
