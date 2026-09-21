#!/usr/bin/env python3
"""Offline operator-rollout tests: subprocesses, database and health are stubbed."""
import contextlib
import importlib.util
import io
import pathlib
import re
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'deploy_watchlist', pathlib.Path(__file__).with_name('deploy-watchlist.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
ROOT = pathlib.Path(__file__).resolve().parent.parent
SHA = 'a' * 40
BASE_COMPOSE = ('services:\n  migrate:\n    command:\n      [\n'
                '        "-f",\n        "/migrations/017_routines.sql",\n'
                '      ]\n  gateway:\n    environment:\n'
                '      TAVILY_API_KEY: ${TAVILY_API_KEY:-}\n'
                '    read_only: true\n')


class WatchlistRolloutTests(unittest.TestCase):
    def test_parallel_documentation_baseline(self):
        self.scenario(baseline='6ffd2339dd20954e0457cc6bbaf61fea37425d6b', expected_migration=True)

    def test_live_library_repair_baseline(self):
        self.scenario(baseline='25aa0e33af9f620b27b29f98f07d0978d4d165cb', expected_migration=True)

    def scenario(self, *, running=0, pending=0, baseline=None, requested_sha=SHA,
                 archive_sha=SHA, changes=None, unsafe=None, health=None,
                 build_failure=False, migration_failure=False, publish_failure=False,
                 expected_error=None, expected_migration=False):
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
                'db/017_routines.sql': '-- original routines migration\n',
            }
            for name, content in original.items():
                path = live / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
            (live / 'RELEASE').write_text((baseline or release.BASE) + '\n')
            (live / '.env').write_text('PRIVATE_SENTINEL=must-stay-private\n')
            candidate = dict(original)
            candidate['src/main.ts'] = '// reviewed candidate\n'
            candidate['docs/new.md'] = 'New reviewed source\n'
            candidate['db/' + release.MIGRATION] = (ROOT / 'db' / release.MIGRATION).read_text()
            candidate['compose.yaml'] = BASE_COMPOSE.replace(
                release.COMPOSE_MIGRATION_ANCHOR.decode(),
                (release.COMPOSE_MIGRATION_ANCHOR + release.COMPOSE_MIGRATION_ADDITION).decode()).replace(
                release.COMPOSE_ENV_ANCHOR.decode(),
                (release.COMPOSE_ENV_ANCHOR + release.COMPOSE_ENV_ADDITION).decode())
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
                    if unsafe == 'malicious-link':
                        member.type = tarfile.SYMTYPE
                        member.linkname = '/tmp/outside-release'
                        archive.addfile(member)
                    else:
                        member.size = 1
                        archive.addfile(member, io.BytesIO(b'x'))

            commands, statements = [], []
            database = {'migration18': False, 'items': [('existing-item', [])]}

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
                if statement == 'SELECT count(*) FROM runtime_migrations WHERE version=18':
                    return str(int(database['migration18']))
                self.assertEqual(statement, candidate['db/' + release.MIGRATION])
                # Additive DDL only; a foreign-key cascade phrase is still additive.
                scrubbed = re.sub(r'ON DELETE CASCADE', '', statement.upper())
                self.assertNotRegex(scrubbed, r'\b(DELETE|DROP|TRUNCATE|UPDATE)\b')
                if migration_failure:
                    raise RuntimeError('simulated transactional migration failure')
                database['migration18'] = True
                return ''

            real_publish = release.publish_source

            def publish(stage):
                if publish_failure:
                    (live / 'src/main.ts').write_text('// interrupted publication\n')
                    (live / 'docs').mkdir(exist_ok=True)
                    (live / 'docs/new.md').write_text('partial copy\n')
                    raise RuntimeError('simulated source publication failure')
                return real_publish(stage)

            output = io.StringIO()
            with patch.object(release, 'LIVE', live), \
                    patch.object(release, 'LOCK', root / 'release.lock'), \
                    patch.object(sys, 'argv', ['deploy-watchlist.py', str(archive_path), requested_sha]), \
                    patch.object(release, 'run', side_effect=run), \
                    patch.object(release, 'compose', side_effect=compose), \
                    patch.object(release, 'sql', side_effect=sql), \
                    patch.object(release, 'healthy', side_effect=health or [True, True]), \
                    patch.object(release, 'publish_source', side_effect=publish), \
                    contextlib.redirect_stdout(output):
                if expected_error:
                    with self.assertRaisesRegex(RuntimeError, expected_error) as caught:
                        release.main()
                    self.assertNotIn('PRIVATE_SENTINEL', str(caught.exception))
                else:
                    release.main()

            self.assertEqual(database['migration18'], expected_migration)
            self.assertEqual(database['items'], [('existing-item', [])])
            self.assertEqual((live / '.env').read_text(), 'PRIVATE_SENTINEL=must-stay-private\n')
            self.assertNotIn('PRIVATE_SENTINEL', output.getvalue())
            self.assertFalse(any('/usr/local/sbin/' in str(c) for c in commands))
            self.assertFalse(any('postgres' in c for c in commands if c[0] == 'compose'))
            stop = ('compose', 'stop', 'gateway')
            if not expected_error:
                self.assertEqual((live / 'RELEASE').read_text(), SHA + '\n')
                self.assertEqual((live / 'src/main.ts').read_text(), candidate['src/main.ts'])
                self.assertEqual((live / 'compose.yaml').read_text(), candidate['compose.yaml'])
                self.assertTrue((live / 'db' / release.MIGRATION).is_file())
                self.assertLess(next(i for i, c in enumerate(commands) if c[:2] == ('docker', 'build')), commands.index(stop))
                self.assertIn(('compose', 'up', '-d', '--no-deps', '--no-build', 'gateway'), commands)
            else:
                self.assertEqual((live / 'RELEASE').read_text(), (baseline or release.BASE) + '\n')
                self.assertEqual((live / 'compose.yaml').read_text(), BASE_COMPOSE)
                self.assertEqual((live / 'src/main.ts').read_text(), original['src/main.ts'])
                self.assertFalse((live / 'docs/new.md').exists())
                if stop in commands:
                    self.assertIn(('docker', 'tag', 'previous-image', release.IMAGE + ':latest'), commands)
                else:
                    self.assertFalse(database['migration18'])
                    self.assertFalse(any(c[0] == 'compose' and c[1] in ('stop', 'up') for c in commands))
                    self.assertFalse(any('ALTER TABLE' in s for s in statements))
            return commands

    def test_running_work_and_pending_input_refuse_before_stop(self):
        for args, message in [({'running': 1}, 'Active work'), ({'pending': 1}, 'Pending conversation input')]:
            with self.subTest(args=args):
                self.scenario(**args, expected_error=message)

    def test_exact_baseline_and_archive_commit(self):
        for args, message in [({'baseline': 'b' * 40}, 'exact documented baseline'),
                              ({'archive_sha': 'b' * 40}, 'Archive commit'),
                              ({'requested_sha': 'main'}, 'Usage:')]:
            with self.subTest(args=args):
                self.scenario(**args, expected_error=message)

    def test_unsafe_archive_entries_refuse_before_stop(self):
        for unsafe in ['../escape', '/absolute', 'malicious-link', '.env',
                       'nested/.env.production', 'RELEASE', 'src/main.ts']:
            with self.subTest(entry=unsafe):
                self.scenario(unsafe=unsafe, expected_error='Unsafe archive entry')

    def test_unexpected_database_changes_refuse_before_stop(self):
        cases = [({'db/001_initial.sql': '-- modified'}, 'Historical migration'),
                 ({'db/001_initial.sql': None}, 'Historical migration'),
                 ({'db/016_unrelated.sql': '-- unrelated'}, 'Unexpected migration set'),
                 ({'db/nested/unreviewed.txt': 'unreviewed'}, 'Unexpected migration set'),
                 ({'db/' + release.MIGRATION: None}, 'Unexpected migration set')]
        for changes, message in cases:
            with self.subTest(changes=changes):
                self.scenario(changes=changes, expected_error=message)

    def test_only_exact_compose_additions_are_allowed(self):
        correct = BASE_COMPOSE.replace(
            release.COMPOSE_MIGRATION_ANCHOR.decode(),
            (release.COMPOSE_MIGRATION_ANCHOR + release.COMPOSE_MIGRATION_ADDITION).decode()).replace(
            release.COMPOSE_ENV_ANCHOR.decode(),
            (release.COMPOSE_ENV_ANCHOR + release.COMPOSE_ENV_ADDITION).decode())
        for invalid in [BASE_COMPOSE, correct.replace('read_only: true', 'read_only: false'),
                        correct + '  unreviewed: {}\n',
                        correct.replace(release.COMPOSE_ENV_ADDITION.decode(), release.COMPOSE_ENV_ADDITION.decode() * 2),
                        correct.replace(release.COMPOSE_MIGRATION_ADDITION.decode(), release.COMPOSE_MIGRATION_ADDITION.decode() * 2)]:
            with self.subTest(compose=invalid):
                self.scenario(changes={'compose.yaml': invalid}, expected_error='Unexpected Compose change')

    def test_trusted_release_handler_cannot_change_incidentally(self):
        self.scenario(changes={'scripts/cloud-release.py': '# modified'}, expected_error='Trusted release-handler source changed')

    def test_build_and_baseline_health_failures_do_not_stop_gateway(self):
        self.scenario(build_failure=True, expected_error='Candidate build failed')
        self.scenario(health=[False], expected_error='Baseline application is not healthy')

    def test_success_applies_only_additive_migration_and_publishes_source(self):
        self.scenario(expected_migration=True)

    def test_candidate_health_failure_restores_previous_app_retaining_migration(self):
        self.scenario(health=[True, False, True], expected_error='previous application healthy', expected_migration=True)

    def test_failed_migration_restores_previous_app_without_reversal(self):
        self.scenario(migration_failure=True, health=[True, True], expected_error='previous application healthy')

    def test_source_publication_failure_restores_files_and_app(self):
        self.scenario(publish_failure=True, health=[True, True, True], expected_error='previous application healthy', expected_migration=True)

    def test_unhealthy_rollback_requires_operator_inspection(self):
        self.scenario(health=[True, False, False], expected_error='Rollback needs operator inspection', expected_migration=True)


if __name__ == '__main__':
    unittest.main()
