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
    'deploy_pgvector', pathlib.Path(__file__).with_name('deploy-pgvector.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
ROOT = pathlib.Path(__file__).resolve().parent.parent
SHA = 'a' * 40
BASE_COMPOSE = ('services:\n  postgres:\n    image: postgres:17-alpine\n    restart: unless-stopped\n'
                '  migrate:\n    image: postgres:17-alpine\n    command:\n      [\n'
                '        "-f",\n        "/migrations/033_mail_index.sql",\n'
                '      ]\n  gateway:\n    read_only: true\n')


def candidate_compose(base=BASE_COMPOSE):
    return base.replace(release.COMPOSE_ANCHOR.decode(),
                        (release.COMPOSE_ANCHOR + release.COMPOSE_ADDITION).decode()).replace(
        release.OLD_SERVICE.decode(), release.NEW_SERVICE.decode())


class PgvectorRolloutTests(unittest.TestCase):
    def test_single_verified_baseline(self):
        self.assertEqual(release.BASES, {release.BASE})

    def test_live_compose_carries_exactly_the_reviewed_entry(self):
        live = (ROOT / 'compose.yaml').read_bytes()
        self.assertEqual(live.count(release.COMPOSE_ANCHOR + release.COMPOSE_ADDITION), 1)
        self.assertEqual(live.count(release.NEW_SERVICE), 1)

    def test_unreviewed_baseline_is_refused(self):
        self.scenario(baseline='b' * 40, expected_error='exact documented baseline')

    def scenario(self, *, version_change=False, postgres_failure=False, backup_failure=False,
                 digest='sha256:' + 'b' * 64, no_new_dump=False, ack_lost=False,
                 ready=None, running=0, pending=0, baseline=None, requested_sha=SHA,
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
                'db/020_watch_window.sql': '-- original watch-window migration\n',
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
            candidate['compose.yaml'] = candidate_compose()
            candidate['Dockerfile.postgres'] = ('FROM postgres:17-alpine@sha256:' + 'b' * 64 + ' AS build\n'
                                                'FROM postgres:17-alpine@sha256:' + 'b' * 64 + '\n')
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

            commands, statements, versions = [], [], []
            database = {'migration34': False, 'tasks': [('existing-task', [])]}

            def run(args, **kwargs):
                commands.append(tuple(args))
                if args[:2] == ['docker', 'build'] and build_failure and '-f' not in args:
                    raise subprocess.CalledProcessError(1, args, stderr='PRIVATE_SENTINEL')
                if args[:2] == ['docker', 'build'] and postgres_failure and '-f' in args:
                    raise subprocess.CalledProcessError(1, args, stderr='PRIVATE_SENTINEL')
                if args[0] == 'systemctl' and backup_failure:
                    raise subprocess.CalledProcessError(1, args, stderr='PRIVATE_SENTINEL')
                if args[:3] == ['docker', 'image', 'inspect']:
                    return subprocess.CompletedProcess(args, 0, stdout=f'["postgres@{digest}"]\n')
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
                if statement == release.DATABASE_IDENTITY:
                    versions.append(statement)
                    return '17.12/c' if version_change and len(versions) > 1 else '17.11/c'
                if statement == "SELECT '[1,0]'::vector <=> '[1,0]'::vector":
                    return '0'
                if statement == 'SELECT count(*) FROM runtime_migrations WHERE version=34':
                    return str(int(database['migration34']))
                self.assertEqual(statement, candidate['db/' + release.MIGRATION])
                # Additive only: no deletes, drops, truncation, updates or table alterations
                # beyond adding a nullable column.
                safe = re.sub(r'--[^\n]*', '', statement.upper())
                safe = re.sub(r'ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+\w+\s+UUID;', '', safe)
                self.assertNotRegex(safe, r'\b(DELETE\s+FROM|DROP|TRUNCATE|UPDATE\s|ALTER\s+TABLE)')
                if migration_failure:
                    raise RuntimeError('simulated transactional migration failure')
                database['migration34'] = True
                if ack_lost:
                    raise RuntimeError('simulated lost reply after commit')
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
                    patch.object(sys, 'argv', ['deploy-mail-index.py', str(archive_path), requested_sha]), \
                    patch.object(release, 'run', side_effect=run), \
                    patch.object(release, 'compose', side_effect=compose), \
                    patch.object(release, 'sql', side_effect=sql), \
                    patch.object(release, 'healthy', side_effect=health or [True, True]), \
                    patch.object(release, 'postgres_ready', side_effect=ready or [True, True]), \
                    patch.object(release, 'publish_source', side_effect=publish), \
                    patch.object(release, 'fresh_backup', return_value=not no_new_dump), \
                    contextlib.redirect_stdout(output):
                if expected_error:
                    with self.assertRaisesRegex(RuntimeError, expected_error) as caught:
                        release.main()
                    self.assertNotIn('PRIVATE_SENTINEL', str(caught.exception))
                else:
                    release.main()

            self.assertEqual(database['migration34'], expected_migration)
            self.assertEqual(database['tasks'], [('existing-task', [])])
            self.assertEqual((live / '.env').read_text(), 'PRIVATE_SENTINEL=must-stay-private\n')
            self.assertNotIn('PRIVATE_SENTINEL', output.getvalue())
            self.assertFalse(any('/usr/local/sbin/' in str(c) for c in commands))
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
                self.assertEqual((live / 'compose.yaml').read_text(),
                                 candidate_compose() if expected_migration else BASE_COMPOSE)
                self.assertEqual((live / 'src/main.ts').read_text(), original['src/main.ts'])
                self.assertFalse((live / 'docs/new.md').exists())
                # What the retained Compose file needs for its next full start.
                self.assertEqual((live / 'db' / release.MIGRATION).is_file(), expected_migration)
                self.assertEqual((live / 'Dockerfile.postgres').is_file(), expected_migration)
                if ready == [False, False]:
                    # No database to bring the gateway back to: the operator takes over.
                    self.assertNotIn(('docker', 'tag', 'previous-image', release.IMAGE + ':latest'), commands)
                elif stop in commands:
                    self.assertIn(('docker', 'tag', 'previous-image', release.IMAGE + ':latest'), commands)
                else:
                    self.assertFalse(database['migration34'])
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

    def test_only_exact_compose_migration_addition_is_allowed(self):
        correct = candidate_compose()
        for invalid in [BASE_COMPOSE, correct.replace('read_only: true', 'read_only: false'),
                        correct + '  unreviewed: {}\n',
                        correct.replace(release.COMPOSE_ADDITION.decode(), release.COMPOSE_ADDITION.decode() * 2)]:
            with self.subTest(compose=invalid):
                self.scenario(changes={'compose.yaml': invalid}, expected_error='Unexpected Compose change')

    def test_trusted_release_handler_cannot_change_incidentally(self):
        self.scenario(changes={'scripts/cloud-release.py': '# modified'}, expected_error='Trusted release-handler source changed')

    def test_build_backup_and_baseline_failures_do_not_stop_gateway(self):
        self.scenario(build_failure=True, expected_error='Candidate build failed')
        self.scenario(postgres_failure=True, expected_error='Postgres image build failed')
        self.scenario(backup_failure=True, expected_error='Fresh backup failed')
        self.scenario(no_new_dump=True, expected_error='Fresh backup failed')
        self.scenario(digest='sha256:' + 'c' * 64, expected_error='not the base of the pgvector image')
        self.scenario(health=[False], expected_error='Baseline application is not healthy')

    def test_compose_must_also_carry_the_exact_pgvector_image(self):
        without_image = candidate_compose().replace(release.NEW_SERVICE.decode(), release.OLD_SERVICE.decode())
        self.scenario(changes={'compose.yaml': without_image}, expected_error='Unexpected Compose change')

    def test_success_order_backup_stop_image_migration_proof_gateway(self):
        commands = self.scenario(expected_migration=True)
        order = [next(i for i, c in enumerate(commands) if c == wanted) for wanted in [
            ('systemctl', 'start', 'hermes-backup.service'),
            ('compose', 'stop', 'gateway'),
            ('compose', 'up', '-d', '--no-deps', '--no-build', 'postgres'),
            ('compose', 'up', '-d', '--no-deps', '--no-build', 'gateway'),
        ]]
        self.assertEqual(order, sorted(order))

    def test_candidate_health_failure_keeps_pgvector_image_after_migration(self):
        commands = self.scenario(health=[True, False, True], expected_error='previous gateway healthy on the pgvector image',
                                 expected_migration=True)
        # The plain image cannot read vector columns, so Postgres is not replaced again.
        self.assertEqual(commands.count(('compose', 'up', '-d', '--no-deps', '--no-build', 'postgres')), 1)

    def test_lost_reply_after_commit_keeps_pgvector_image(self):
        commands = self.scenario(ack_lost=True, health=[True, True],
                                 expected_error='previous gateway healthy on the pgvector image',
                                 expected_migration=True)
        self.assertEqual(commands.count(('compose', 'up', '-d', '--no-deps', '--no-build', 'postgres')), 1)

    def test_fresh_backup_needs_a_new_dump(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(release, 'BACKUPS', pathlib.Path(directory)):
                self.assertFalse(release.fresh_backup(0))
                dump = pathlib.Path(directory) / 'database-1.dump.cms'
                dump.write_bytes(b'x')
                self.assertTrue(release.fresh_backup(int(dump.stat().st_mtime)))
                self.assertFalse(release.fresh_backup(int(dump.stat().st_mtime) + 10))

    def test_failed_migration_restores_plain_image_and_previous_app(self):
        commands = self.scenario(migration_failure=True, health=[True, True],
                                 expected_error='plain Postgres image')
        self.assertEqual(commands.count(('compose', 'up', '-d', '--no-deps', '--no-build', 'postgres')), 2)

    def test_version_change_or_postgres_not_ready_restores_plain_image(self):
        self.scenario(version_change=True, health=[True, True], expected_error='plain Postgres image')
        self.scenario(ready=[False, True], health=[True, True], expected_error='plain Postgres image')

    def test_failed_postgres_rollback_requires_operator_inspection(self):
        self.scenario(ready=[False, False], health=[True], expected_error='Rollback needs operator inspection')

    def test_source_publication_failure_restores_files_and_keeps_image(self):
        self.scenario(publish_failure=True, health=[True, True, True],
                      expected_error='previous gateway healthy on the pgvector image', expected_migration=True)

    def test_unhealthy_rollback_requires_operator_inspection(self):
        self.scenario(health=[True, False, False], expected_error='Rollback needs operator inspection',
                      expected_migration=True)


if __name__ == '__main__':
    unittest.main()
