import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("squad rollout permits only migration027/Compose list and verifies immutable archive bytes", () => {
  const result = spawnSync(
    "python3",
    [
      "-c",
      String.raw`
import importlib.util,pathlib,tempfile,hashlib,io,tarfile
spec=importlib.util.spec_from_file_location('rollout','scripts/deploy-coding-squad.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);live=root/'live';stage=root/'stage'
 for directory in (live,stage):
  (directory/'db').mkdir(parents=True);(directory/'scripts').mkdir()
  (directory/'scripts/cloud-release.py').write_text('trusted handler')
  (directory/'db/001_initial.sql').write_text('historical schema')
 (stage/'src').mkdir();(stage/'src/main.ts').write_text('fixture')
 for name in ('Dockerfile','package.json','package-lock.json'):(stage/name).write_text('fixture')
 baseline=b'services:\n  migrate:\n      [\n'+m.COMPOSE_ANCHOR+b'      ]\n  gateway:\n    environment:\n      CODING_RUNTIME: off\n'
 (live/'compose.yaml').write_bytes(baseline)
 expected=baseline.replace(m.COMPOSE_ANCHOR,m.COMPOSE_ANCHOR+m.COMPOSE_ADDITION)
 (stage/'compose.yaml').write_bytes(expected);(stage/'db'/m.MIGRATION).write_text('additive fixture')
 m.LIVE=live;m.validate_changes(stage)
 (stage/'compose.yaml').write_bytes(expected+b'  privilege: true\n')
 try:m.validate_changes(stage);raise AssertionError('accepted expanded Compose')
 except RuntimeError:pass
 (stage/'compose.yaml').write_bytes(expected)
 (stage/'db/001_initial.sql').write_text('changed history')
 try:m.validate_changes(stage);raise AssertionError('accepted changed history')
 except RuntimeError:pass
 archive=root/'source.tar';sha='a'*40
 with tarfile.open(archive,'w',format=tarfile.PAX_FORMAT,pax_headers={'comment':sha}) as tar:
  item=tarfile.TarInfo('safe.txt');payload=b'fixture';item.size=len(payload);tar.addfile(item,io.BytesIO(payload))
 target=root/'unpacked';target.mkdir();digest=hashlib.sha256(archive.read_bytes()).hexdigest()
 m.unpack(str(archive),sha,target,digest)
 assert (target/'safe.txt').read_bytes()==b'fixture'
 try:m.unpack(str(archive),sha,target,'b'*64);raise AssertionError('accepted mismatched digest')
 except RuntimeError:pass
print('validated')
`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "validated");
});
