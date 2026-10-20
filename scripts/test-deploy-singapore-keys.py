#!/usr/bin/env python3
"""Offline tests for the Singapore key rollout: subprocesses, database and health are stubbed."""
import contextlib
import importlib.util
import io
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'deploy_singapore_keys', pathlib.Path(__file__).with_name('deploy-singapore-keys.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
SHA = 'a' * 40
BASE_COMPOSE = ('services:\n  gateway:\n    environment:\n'
                '      TWELVE_DATA_API_KEY: ${TWELVE_DATA_API_KEY:-}\n'
                '      STT_MODEL: ${STT_MODEL:-}\n    read_only: true\n')
KEYED_ENV = ('PRIVATE_SENTINEL=must-stay-private\n'
             'DATAGOVSG_API_KEY=v2:secret-sentinel-dg\n'
             'LTA_DATAMALL_ACCOUNT_KEY=secret-sentinel-lta\n')


class SingaporeKeyRolloutTests(unittest.TestCase):
    def test_single_verified_baseline(self):
        self.assertEqual(release.BASES, {release.BASE})
        self.assertRegex(release.BASE, '^[0-9a-f]{40}$')

    def scenario(self, *, running=0, pending=0, coding=0, baseline=None, requested_sha=SHA,
                 archive_sha=SHA, changes=None, unsafe=None, health=None, env=KEYED_ENV,
                 build_failure=False, publish_failure=False, expected_error=None):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            live = root / 'live'
            live.mkdir()
            original = {
                'Dockerfile': 'FROM scratch\n', 'package.json': '{}\n',
                'package-lock.json': '{}\n', 'compose.yaml': BASE_COMPOSE,
                'src/main.ts': '// previous application\n',
                'scripts/cloud-release.py': '# unchanged restricted entrypoint\n',
                'db/001_initial.sql': '-- original migration\n',
            }
            for name, content in original.items():
                path = live / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
            (live / 'RELEASE').write_text((baseline or release.BASE) + '\n')
            (live / '.env').write_text(env)
            candidate = dict(original)
            candidate['src/main.ts'] = '// reviewed candidate\n'
            candidate['compose.yaml'] = BASE_COMPOSE.replace(
                release.COMPOSE_ANCHOR.decode(),
                (release.COMPOSE_ANCHOR + release.COMPOSE_ADDITION).decode())
            for name, content in (changes or {}).items():
                if content is None:
                    candidate.pop(name, None)
                else:
                    candidate[name] = content
            archive_path = root / 'source.tar'
            with tarfile.open(archive_path, mode='w', format=tarfile.PAX_FORMAT,
                              pax_headers={'comment': archive_sha}) as archive:
                for name, content in candidate.items():
                    member = tarfile.TarInfo(name)
                    data = content.encode()
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
                if unsafe:
                    member = tarfile.TarInfo(unsafe)
                    member.size = 1
                    archive.addfile(member, io.BytesIO(b'x'))

            commands, statements = [], []

            def run(args, **kwargs):
                commands.append(tuple(args))
                if args[:2] == ['docker', 'build'] and build_failure:
                    raise subprocess.CalledProcessError(1, args, stderr='PRIVATE_SENTINEL')
                return subprocess.CompletedProcess(args, 0, stdout='')

            def compose(*args, **kwargs):
                commands.append(('compose', *args))
                return subprocess.CompletedProcess(args, 0, stdout='previous-image\n')

            def sql(statement):
                statements.append(statement)
                if statement == "SELECT count(*) FROM runtime_runs WHERE state='running'":
                    return str(running)
                if statement == "SELECT count(*) FROM conversation_inputs WHERE state IN ('queued','running')":
                    return str(pending)
                if statement.startswith("SELECT count(*) FROM coding_jobs"):
                    return str(coding)
                raise AssertionError('unexpected SQL: ' + statement)

            real_publish = release.publish_source

            def publish(stage):
                if publish_failure:
                    (live / 'src/main.ts').write_text('// interrupted publication\n')
                    raise RuntimeError('simulated source publication failure')
                return real_publish(stage)

            output = io.StringIO()
            with patch.object(release, 'LIVE', live), \
                    patch.object(release, 'LOCK', root / 'release.lock'), \
                    patch.object(sys, 'argv', ['deploy-singapore-keys.py', str(archive_path), requested_sha]), \
                    patch.object(release, 'run', side_effect=run), \
                    patch.object(release, 'compose', side_effect=compose), \
                    patch.object(release, 'sql', side_effect=sql), \
                    patch.object(release, 'healthy', side_effect=health or [True, True]), \
                    patch.object(release, 'publish_source', side_effect=publish), \
                    contextlib.redirect_stdout(output):
                if expected_error:
                    with self.assertRaisesRegex(RuntimeError, expected_error) as caught:
                        release.main()
                    for secret in ('PRIVATE_SENTINEL', 'secret-sentinel'):
                        self.assertNotIn(secret, str(caught.exception))
                else:
                    release.main()

            # The private .env is never rewritten, and no value is printed or sent to SQL.
            self.assertEqual((live / '.env').read_text(), env)
            for secret in ('PRIVATE_SENTINEL', 'secret-sentinel'):
                self.assertNotIn(secret, output.getvalue())
                self.assertFalse(any(secret in ' '.join(map(str, c)) for c in commands))
            self.assertFalse(any('ALTER' in s or 'INSERT' in s for s in statements))
            self.assertFalse(any('/usr/local/sbin/' in str(c) for c in commands))
            self.assertFalse(any('postgres' in c for c in commands if c[0] == 'compose'))
            stop = ('compose', 'stop', 'gateway')
            if not expected_error:
                self.assertEqual((live / 'RELEASE').read_text(), SHA + '\n')
                self.assertEqual((live / 'src/main.ts').read_text(), candidate['src/main.ts'])
                self.assertEqual((live / 'compose.yaml').read_text(), candidate['compose.yaml'])
                self.assertLess(next(i for i, c in enumerate(commands) if c[:2] == ('docker', 'build')),
                                commands.index(stop))
                self.assertIn(('compose', 'up', '-d', '--no-deps', '--no-build', 'gateway'), commands)
                self.assertIn('configured', output.getvalue())
            else:
                self.assertEqual((live / 'RELEASE').read_text(), (baseline or release.BASE) + '\n')
                self.assertEqual((live / 'compose.yaml').read_text(), BASE_COMPOSE)
                self.assertEqual((live / 'src/main.ts').read_text(), original['src/main.ts'])
                if stop in commands:
                    self.assertIn(('docker', 'tag', 'previous-image', release.IMAGE + ':latest'), commands)
                else:
                    self.assertFalse(any(c[0] == 'compose' and c[1] in ('stop', 'up') for c in commands))
            return commands

    def test_success_switches_compose_and_publishes_source(self):
        self.scenario()

    def test_missing_or_empty_keys_refuse_before_any_change(self):
        for env in ['PRIVATE_SENTINEL=x\n',
                    'DATAGOVSG_API_KEY=v2:secret-sentinel-dg\n',
                    'DATAGOVSG_API_KEY=\nLTA_DATAMALL_ACCOUNT_KEY=secret-sentinel-lta\n',
                    '# DATAGOVSG_API_KEY=a\n# LTA_DATAMALL_ACCOUNT_KEY=b\n',
                    'DATAGOVSG_API_KEY=""\nLTA_DATAMALL_ACCOUNT_KEY=secret-sentinel-lta\n',
                    "DATAGOVSG_API_KEY=v2:secret-sentinel-dg\nLTA_DATAMALL_ACCOUNT_KEY=''\n",
                    'DATAGOVSG_API_KEY=   # later\nLTA_DATAMALL_ACCOUNT_KEY=secret-sentinel-lta\n',
                    KEYED_ENV + 'LTA_DATAMALL_ACCOUNT_KEY=\n']:
            with self.subTest(env=env):
                commands = self.scenario(env=env, expected_error='Add both Singapore keys')
                self.assertEqual(commands, [])

    def test_running_work_and_pending_input_refuse_before_stop(self):
        for args, message in [({'running': 1}, 'Active work'), ({'pending': 1}, 'Pending conversation input'),
                              ({'coding': 1}, 'Active coding job')]:
            with self.subTest(args=args):
                self.scenario(**args, expected_error=message)

    def test_exact_baseline_and_archive_commit(self):
        for args, message in [({'baseline': 'b' * 40}, 'exact documented baseline'),
                              ({'archive_sha': 'b' * 40}, 'Archive commit'),
                              ({'requested_sha': 'main'}, 'Usage:')]:
            with self.subTest(args=args):
                self.scenario(**args, expected_error=message)

    def test_unsafe_archive_entries_refuse_before_stop(self):
        for unsafe in ['../escape', '/absolute', '.env', 'nested/.env.production', 'RELEASE', 'src/main.ts']:
            with self.subTest(entry=unsafe):
                self.scenario(unsafe=unsafe, expected_error='Unsafe archive entry')

    def test_any_database_change_refuses(self):
        for changes in [{'db/001_initial.sql': '-- modified'}, {'db/001_initial.sql': None},
                        {'db/099_new.sql': '-- new'}]:
            with self.subTest(changes=changes):
                self.scenario(changes=changes, expected_error='permits no database change')

    def test_only_the_two_key_names_may_change_compose(self):
        correct = BASE_COMPOSE.replace(release.COMPOSE_ANCHOR.decode(),
                                       (release.COMPOSE_ANCHOR + release.COMPOSE_ADDITION).decode())
        for invalid in [BASE_COMPOSE, correct.replace('read_only: true', 'read_only: false'),
                        correct + '  unreviewed: {}\n',
                        correct.replace(release.COMPOSE_ADDITION.decode(), release.COMPOSE_ADDITION.decode() * 2)]:
            with self.subTest(compose=invalid):
                self.scenario(changes={'compose.yaml': invalid}, expected_error='Unexpected Compose change')

    def test_trusted_release_handler_cannot_change_incidentally(self):
        self.scenario(changes={'scripts/cloud-release.py': '# modified'},
                      expected_error='Trusted release-handler source changed')

    def test_build_and_baseline_health_failures_do_not_stop_gateway(self):
        self.scenario(build_failure=True, expected_error='Candidate build failed')
        self.scenario(health=[False], expected_error='Baseline application is not healthy')

    def test_candidate_health_failure_restores_previous_app(self):
        self.scenario(health=[True, False, True], expected_error='previous application healthy')

    def test_source_publication_failure_restores_files_and_app(self):
        self.scenario(publish_failure=True, health=[True, True, True], expected_error='previous application healthy')

    def test_unhealthy_rollback_requires_operator_inspection(self):
        self.scenario(health=[True, False, False], expected_error='Rollback needs operator inspection')


if __name__ == '__main__':
    unittest.main()
