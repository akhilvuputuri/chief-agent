#!/usr/bin/env python3
"""Offline release-handler regression tests; no Docker, network or production access."""
import builtins
import importlib.util
import io
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
    def scenario(self, *, running=0, pending=0):
        sha = 'a' * 40
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
                    patch.dict(os.environ, {'SSH_ORIGINAL_COMMAND': f'deploy {sha}'}), \
                    patch.object(sys, 'stdin', fake_input), \
                    patch('builtins.open', side_effect=opened), \
                    patch.object(release.fcntl, 'flock'), \
                    patch.object(release, 'query', side_effect=query), \
                    patch.object(release, 'compose', side_effect=compose), \
                    patch.object(release, 'run') as run, \
                    patch.object(release.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)), \
                    patch.object(release, 'healthy', return_value=True), \
                    patch('builtins.print'):
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
            if not running:
                self.assertEqual(len(queries), 2)

    def test_preparation_blocks_restart_even_without_a_runtime_run(self):
        self.scenario(pending=1)

    def test_running_work_blocks_restart(self):
        self.scenario(running=1)

    def test_idle_release_still_deploys(self):
        self.scenario()


if __name__ == '__main__':
    unittest.main()
