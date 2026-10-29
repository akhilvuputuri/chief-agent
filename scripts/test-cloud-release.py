#!/usr/bin/env python3
"""Offline release-handler regression tests; no Docker, network or production access."""
import builtins
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'cloud_release', pathlib.Path(__file__).with_name('cloud-release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseGuardTests(unittest.TestCase):
    def scenario(self, *, running=0, pending=0, digest=None, revision=None, release_sha=None, refused=None):
        sha = 'a' * 40
        command = f'deploy {sha}' + (f' {digest}' if digest else '')
        docker = []

        def subprocess_run(args, *a, **kw):
            docker.append(list(args))
            if args[:3] == ['docker', 'image', 'inspect']:
                config = {'Labels': {'org.opencontainers.image.revision': revision or sha},
                          'Env': ['NODE_VERSION=22', 'RELEASE_SHA=' + (release_sha or sha)]}
                return subprocess.CompletedProcess(args, 0, stdout=json.dumps(config))
            return subprocess.CompletedProcess(args, 0, stdout='')
        with tempfile.TemporaryDirectory() as directory:
            live = pathlib.Path(directory) / 'live'
            live.mkdir()
            files = {
                'Dockerfile': 'FROM scratch', 'package.json': '{}',
                'compose.yaml': 'services: {}', 'src/main.ts': '// source',
                'db/014_checkpoint_steering.sql': '-- existing schema',
            }
            payload = io.BytesIO()
            with tarfile.open(fileobj=payload, mode='w') as archive:
                for name, content in files.items():
                    path = live / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(content)
                    member = tarfile.TarInfo(name)
                    data = content.encode()
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
            (live / 'RELEASE').write_text('previous-sha')
            queries, commands = [], []

            def query(sql):
                queries.append(sql)
                if 'runtime_runs' in sql:
                    return [{'n': running}]
                if 'conversation_inputs' in sql:
                    self.assertIn("state IN ('queued','running')", sql)
                    return [{'n': pending}]
                raise AssertionError(f'Unexpected query: {sql}')

            def compose(*args, **kwargs):
                commands.append(args)
                return subprocess.CompletedProcess(args, 0, stdout='old-image')

            original_open = builtins.open

            def opened(path, *args, **kwargs):
                if str(path) == '/var/lock/companion-release.lock':
                    return io.StringIO()
                return original_open(path, *args, **kwargs)

            fake_input = io.TextIOWrapper(io.BytesIO(payload.getvalue()))
            with patch.object(release, 'LIVE', live), \
                    patch.dict(os.environ, {'SSH_ORIGINAL_COMMAND': command}), \
                    patch.object(sys, 'stdin', fake_input), \
                    patch('builtins.open', side_effect=opened), \
                    patch.object(release.fcntl, 'flock'), \
                    patch.object(release, 'query', side_effect=query), \
                    patch.object(release, 'compose', side_effect=compose), \
                    patch.object(release, 'run') as run, \
                    patch.object(release.subprocess, 'run', side_effect=subprocess_run), \
                    patch.object(release, 'healthy', return_value=True), \
                    patch('builtins.print'):
                if refused:
                    with self.assertRaisesRegex(RuntimeError, refused):
                        release.main()
                    run.assert_not_called()
                    self.assertEqual(commands, [])
                    self.assertEqual(queries, [])
                    self.assertEqual((live / 'RELEASE').read_text(), 'previous-sha')
                    self.assertFalse(any(c[:2] == ['docker', 'build'] for c in docker))
                    return
                if running or pending:
                    with self.assertRaisesRegex(RuntimeError, 'Active agent work' if running else 'Pending conversation input'):
                        release.main()
                    run.assert_not_called()  # No image tags, restart or rollback.
                    self.assertEqual(commands, [])
                    self.assertEqual((live / 'RELEASE').read_text(), 'previous-sha')
                else:
                    release.main()
                    self.assertIn(('up', '-d', '--no-deps', '--no-build', 'gateway'), commands)
                    self.assertEqual((live / 'RELEASE').read_text(), sha + '\n')
                built = any(c[:2] == ['docker', 'build'] for c in docker)
                pulled = [c for c in docker if c[:2] == ['docker', 'pull']]
                if digest:
                    self.assertFalse(built)
                    self.assertEqual(pulled, [['docker', 'pull', '--quiet', release.REGISTRY_IMAGE + '@' + digest]])
                    self.assertIn(['docker', 'tag', release.REGISTRY_IMAGE + '@' + digest, release.IMAGE + ':' + sha], docker)
                else:
                    self.assertTrue(built)
                    self.assertEqual(pulled, [])
            if not running:
                self.assertEqual(len(queries), 2)

    def test_preparation_blocks_restart_even_without_a_runtime_run(self):
        self.scenario(pending=1)

    def test_running_work_blocks_restart(self):
        self.scenario(running=1)

    def test_idle_release_still_deploys(self):
        self.scenario()

    DIGEST = 'sha256:' + 'b' * 64

    def test_digest_release_pulls_instead_of_building(self):
        self.scenario(digest=self.DIGEST)

    def test_digest_release_keeps_the_work_guards(self):
        self.scenario(digest=self.DIGEST, running=1)

    def test_image_from_another_commit_is_refused(self):
        self.scenario(digest=self.DIGEST, revision='c' * 40, refused='not built from the release commit')

    def test_image_with_another_release_sha_is_refused(self):
        self.scenario(digest=self.DIGEST, release_sha='c' * 40, refused='not built from the release commit')

    def test_malformed_commands_are_refused(self):
        for command in [f'deploy {"a" * 40} sha256:{"b" * 63}', f'deploy {"a" * 40} {"b" * 64}',
                        f'deploy {"a" * 40} sha256:{"b" * 64} extra', f'deploy {"a" * 40};id']:
            with patch.dict(os.environ, {'SSH_ORIGINAL_COMMAND': command}), \
                    patch.object(release.subprocess, 'run') as subprocess_run:
                with self.assertRaisesRegex(RuntimeError, 'Only deploy'):
                    release.main()
                subprocess_run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
