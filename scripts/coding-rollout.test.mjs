import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("coding rollout accepts only the additive migration and exact default-off Compose wiring", () => {
  const result = spawnSync(
    "python3",
    [
      "-c",
      String.raw`
import importlib.util, pathlib, tempfile
spec=importlib.util.spec_from_file_location('rollout','scripts/deploy-coding.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with tempfile.TemporaryDirectory(prefix='chief-rollout-test-') as tmp:
    root=pathlib.Path(tmp); live=root/'live'; stage=root/'stage'
    for directory in (live,stage):
        (directory/'db').mkdir(parents=True); (directory/'scripts').mkdir()
        (directory/'scripts/cloud-release.py').write_text('trusted handler')
        (directory/'db/001_initial.sql').write_text('historical schema')
    (stage/'src').mkdir(); (stage/'src/main.ts').write_text('fixture')
    for name in ('Dockerfile','package.json','package-lock.json'): (stage/name).write_text('fixture')
    baseline=b'services:\n  migrate:\n      [\n'+m.COMPOSE_ANCHOR+b'      ]\n  gateway:\n    build: .\n    environment:\n      EXISTING: off\n'
    (live/'compose.yaml').write_bytes(baseline)
    expected=baseline.replace(m.COMPOSE_ANCHOR,m.COMPOSE_ANCHOR+m.COMPOSE_ADDITION).replace(b'    environment:\n',b'    environment:\n'+m.CODING_ENVIRONMENT)
    (stage/'compose.yaml').write_bytes(expected); (stage/'db'/m.MIGRATION).write_text('additive fixture')
    m.LIVE=live; m.validate_changes(stage)
    (stage/'db/001_initial.sql').write_text('changed history')
    try: m.validate_changes(stage); raise AssertionError('accepted changed migration')
    except RuntimeError: pass
    (stage/'db/001_initial.sql').write_text('historical schema')
    (stage/'compose.yaml').write_bytes(expected+b'  unexpected: true\n')
    try: m.validate_changes(stage); raise AssertionError('accepted expanded Compose')
    except RuntimeError: pass
print('validated')
`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "validated");
});
