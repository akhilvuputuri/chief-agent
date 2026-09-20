#!/usr/bin/env python3
"""Offline operator-rollout tests: subprocesses, database and health are stubbed."""
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
    'deploy_library', pathlib.Path(__file__).with_name('deploy-library.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
ROOT = pathlib.Path(__file__).resolve().parent.parent
SHA = 'a' * 40
BASE_COMPOSE = ('services:\n  migrate:\n    command:\n      [\n'
                '        "-f",\n        "/migrations/015_preparation_chain.sql",\n'
                '      ]\n  gateway:\n    environment:\n      MINIAPP_ORIGIN: ${MINIAPP_ORIGIN:-}\n    read_only: true\n')
OLD_003 = 'BEGIN;\nALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_operation_check;\nALTER TABLE approvals ADD CONSTRAINT approvals_operation_check ' + release.OLD_CHECK.decode() + ';\nCOMMIT;\n'
KEY_ENV = 'PRIVATE_SENTINEL=must-stay-private\nLIBRARY_IDENTITY_KEY=' + 'ab' * 32 + '\n'


class LibraryRolloutTests(unittest.TestCase):
    def scenario(self, *, running=0, pending=0, baseline=None, requested_sha=SHA,
                 archive_sha=SHA, changes=None, unsafe=None, health=None,
                 build_failure=False, migration_failure=False, publish_failure=False,
                 expected_error=None, expected_migration=False, env=KEY_ENV):
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
                'db/003_skills.sql': OLD_003,
                'db/009_calendar_approval.sql': OLD_003,
                'db/015_preparation_chain.sql': '-- original preparation migration\n',
            }
            for name, content in original.items():
                path = live / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
            (live / 'RELEASE').write_text((baseline or release.BASE) + '\n')
            (live / '.env').write_text(env)
            candidate = dict(original)
            candidate['src/main.ts'] = '// reviewed candidate\n'
            candidate['docs/new.md'] = 'New reviewed source\n'
            candidate['db/' + release.MIGRATION] = (ROOT / 'db' / release.MIGRATION).read_text()
            candidate['compose.yaml'] = BASE_COMPOSE.replace(
                release.COMPOSE_ANCHOR.decode(),
                (release.COMPOSE_ANCHOR + release.COMPOSE_ADDITION).decode()).replace(
                release.ENV_ANCHOR.decode(), (release.ENV_ANCHOR + release.ENV_ADDITION).decode())
            widened = OLD_003.replace(release.OLD_CHECK.decode(), release.NEW_CHECK.decode())
            candidate['db/003_skills.sql'] = widened
            candidate['db/009_calendar_approval.sql'] = widened
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
            database = {'migration16': False, 'tasks': [('existing-task', [])], 'deleted': False}

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
                if statement == 'SELECT count(*) FROM runtime_migrations WHERE version=16':
                    return str(int(database['migration16']))
                if statement.startswith('SELECT pg_get_constraintdef'):
                    return "CHECK ((operation = ANY (ARRAY['job_delete'::text, 'library_borrow'::text])))" if database['migration16'] else 'CHECK (old)'
                if statement.startswith('DELETE FROM library_link_attempts; DELETE FROM approvals'):
                    database['deleted'] = True
                    commands.append(('sql', 'delete-library-rows'))
                    return ''
                self.assertEqual(statement, candidate['db/' + release.MIGRATION])
                self.assertNotRegex(statement.upper(), r'\b(DELETE FROM|TRUNCATE)\b')
                self.assertNotRegex(statement.upper(), r'DROP (?!CONSTRAINT IF EXISTS)')
                if migration_failure:
                    raise RuntimeError('simulated transactional migration failure')
                database['migration16'] = True
                return ''

            real_publish = release.publish_source
            real_restore = release.restore_source

            def restore(backup, original):
                commands.append(('restore_source',))
                return real_restore(backup, original)

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
                    patch.object(sys, 'argv', ['deploy-library.py', str(archive_path), requested_sha]), \
                    patch.object(release, 'run', side_effect=run), \
                    patch.object(release, 'compose', side_effect=compose), \
                    patch.object(release, 'sql', side_effect=sql), \
                    patch.object(release, 'healthy', side_effect=health or [True, True]), \
                    patch.object(release, 'publish_source', side_effect=publish), \
                    patch.object(release, 'restore_source', side_effect=restore), \
                    contextlib.redirect_stdout(output):
                if expected_error:
                    with self.assertRaisesRegex(RuntimeError, expected_error) as caught:
                        release.main()
                    self.assertNotIn('PRIVATE_SENTINEL', str(caught.exception))
                else:
                    release.main()

            self.assertEqual(database['migration16'], expected_migration)
            self.assertEqual(database['tasks'], [('existing-task', [])])
            self.assertEqual((live / '.env').read_text(), env)
            self.assertNotIn('PRIVATE_SENTINEL', output.getvalue())
            self.assertFalse(any('/usr/local/sbin/' in str(c) for c in commands))
            self.assertFalse(any('postgres' in c for c in commands if c[0] == 'compose'))
            stop = ('compose', 'stop', 'gateway')
            if not expected_error:
                self.assertEqual((live / 'RELEASE').read_text(), SHA + '\n')
                self.assertEqual((live / 'src/main.ts').read_text(), candidate['src/main.ts'])
                self.assertEqual((live / 'compose.yaml').read_text(), candidate['compose.yaml'])
                self.assertTrue((live / 'db' / release.MIGRATION).is_file())
                self.assertIn(release.NEW_CHECK.decode(), (live / 'db/003_skills.sql').read_text())
                self.assertFalse(database['deleted'])
                self.assertLess(next(i for i, c in enumerate(commands) if c[:2] == ('docker', 'build')), commands.index(stop))
                self.assertIn(('compose', 'up', '-d', '--no-deps', '--no-build', 'gateway'), commands)
            else:
                self.assertEqual((live / 'RELEASE').read_text(), (baseline or release.BASE) + '\n')
                self.assertEqual((live / 'compose.yaml').read_text(), BASE_COMPOSE)
                self.assertEqual((live / 'src/main.ts').read_text(), original['src/main.ts'])
                self.assertFalse((live / 'docs/new.md').exists())
                if stop in commands:
                    self.assertIn(('docker', 'tag', 'previous-image', release.IMAGE + ':latest'), commands)
                    self.assertTrue(database['deleted'])
                    self.assertEqual((live / 'db/003_skills.sql').read_text(), OLD_003)
                    if ('restore_source',) in commands:
                        # Library rows must be gone before the narrow 003/009 are restored.
                        self.assertLess(commands.index(('sql', 'delete-library-rows')), commands.index(('restore_source',)))
                else:
                    self.assertFalse(database['migration16'])
                    self.assertFalse(database['deleted'])
                    self.assertFalse(any(c[0] == 'compose' and c[1] in ('stop', 'up') for c in commands))
                    self.assertFalse(any('ALTER TABLE' in s for s in statements))
            return commands

    def test_running_work_and_pending_preparation_refuse_before_stop(self):
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
        widened = OLD_003.replace(release.OLD_CHECK.decode(), release.NEW_CHECK.decode())
        cases = [({'db/001_initial.sql': '-- modified'}, 'Historical migration'),
                 ({'db/001_initial.sql': None}, 'Historical migration'),
                 ({'db/009_calendar_approval.sql': OLD_003}, 'beyond the reviewed approvals constraint'),
                 ({'db/003_skills.sql': widened + '-- extra\n'}, 'beyond the reviewed approvals constraint'),
                 ({'db/003_skills.sql': None}, 'beyond the reviewed approvals constraint'),
                 ({'db/' + release.MIGRATION: '-- no constraint\n'}, 'must repeat the widened approvals constraint'),
                 ({'db/017_unrelated.sql': '-- unrelated'}, 'Unexpected migration set'),
                 ({'db/nested/unreviewed.txt': 'unreviewed'}, 'Unexpected migration set'),
                 ({'db/' + release.MIGRATION: None}, 'Unexpected migration set')]
        for changes, message in cases:
            with self.subTest(changes=changes):
                self.scenario(changes=changes, expected_error=message)

    def test_only_exact_compose_migration_addition_is_allowed(self):
        migration_only = BASE_COMPOSE.replace(release.COMPOSE_ANCHOR.decode(),
                                              (release.COMPOSE_ANCHOR + release.COMPOSE_ADDITION).decode())
        correct = migration_only.replace(release.ENV_ANCHOR.decode(), (release.ENV_ANCHOR + release.ENV_ADDITION).decode())
        for invalid in [BASE_COMPOSE, migration_only, correct.replace('read_only: true', 'read_only: false'),
                        correct + '  unreviewed: {}\n',
                        correct.replace(release.COMPOSE_ADDITION.decode(), release.COMPOSE_ADDITION.decode() * 2)]:
            with self.subTest(compose=invalid):
                self.scenario(changes={'compose.yaml': invalid}, expected_error='Unexpected Compose change')
        leaked = correct.replace('    command:', '    environment:\n      LIBRARY_IDENTITY_KEY: ${LIBRARY_IDENTITY_KEY:-}\n    command:')
        self.scenario(changes={'compose.yaml': leaked}, expected_error='Unexpected Compose change')

    def test_server_env_must_hold_a_valid_identity_key(self):
        for env in ['PRIVATE_SENTINEL=must-stay-private\n', 'PRIVATE_SENTINEL=x\nLIBRARY_IDENTITY_KEY=short\n']:
            with self.subTest(env=env):
                self.scenario(env=env, expected_error='Server .env must define LIBRARY_IDENTITY_KEY')

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
