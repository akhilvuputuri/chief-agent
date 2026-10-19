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
    'deploy_boxes', pathlib.Path(__file__).with_name('deploy-boxes.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
ROOT = pathlib.Path(__file__).resolve().parent.parent
SHA = 'a' * 40
BASE_COMPOSE = ('services:\n  migrate:\n    command:\n      [\n'
                '        "-f",\n        "/migrations/031_link_resolution.sql",\n'
                '      ]\n  gateway:\n    build: .\n    environment:\n'
                '      CODING_RUNTIME: ${CODING_RUNTIME:-off}\n    read_only: true\n')


def candidate_compose(base=BASE_COMPOSE):
    return base.replace(release.COMPOSE_ANCHOR.decode(),
                        (release.COMPOSE_ANCHOR + release.COMPOSE_ADDITION).decode()).replace(
        release.ENV_ANCHOR.decode(), (release.BOXES_ENVIRONMENT + release.ENV_ANCHOR).decode())


class BoxRolloutTests(unittest.TestCase):
    def test_single_verified_baseline(self):
        self.assertEqual(release.BASES, {release.BASE})

    def test_live_compose_carries_exactly_the_reviewed_entries(self):
        live = (ROOT / 'compose.yaml').read_bytes()
        self.assertEqual(live.count(release.COMPOSE_ANCHOR + release.COMPOSE_ADDITION), 1)
        self.assertEqual(live.count(release.BOXES_ENVIRONMENT + release.ENV_ANCHOR), 1)

    def test_unreviewed_baseline_is_refused(self):
        self.scenario(baseline='b' * 40, expected_error='exact documented baseline')

    def scenario(self, *, running=0, pending=0, baseline=None, requested_sha=SHA,
                 archive_sha=SHA, changes=None, unsafe=None, health=None,
                 build_failure=False, migration_failure=False, publish_failure=False,
                 caddy_refused=False,
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
            database = {'migration32': False, 'tasks': [('existing-task', [])]}

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
                if statement == 'SELECT count(*) FROM runtime_migrations WHERE version=32':
                    return str(int(database['migration32']))
                self.assertEqual(statement, candidate['db/' + release.MIGRATION])
                # Additive only: no deletes, drops, truncation, updates or table alterations.
                safe = re.sub(r'--[^\n]*', '', statement.upper())
                self.assertNotRegex(safe, r'\b(DELETE\s+FROM|DROP|TRUNCATE|UPDATE\s|ALTER\s+TABLE)')
                if migration_failure:
                    raise RuntimeError('simulated transactional migration failure')
                database['migration32'] = True
                return ''

            def preflight():
                if caddy_refused:
                    raise RuntimeError('Caddy route cannot be installed (anchor or validation); nothing was changed.')

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
                    patch.object(sys, 'argv', ['deploy-boxes.py', str(archive_path), requested_sha]), \
                    patch.object(release, 'install_caddy_route', return_value='added'), \
                    patch.object(release, 'caddy_preflight', side_effect=preflight), \
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

            self.assertEqual(database['migration32'], expected_migration)
            self.assertEqual(database['tasks'], [('existing-task', [])])
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
                    self.assertFalse(database['migration32'])
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

    def test_box_settings_reach_the_gateway_and_nothing_else_changes(self):
        correct = candidate_compose()
        without_settings = correct.replace(release.BOXES_ENVIRONMENT.decode(), '')
        extra = correct.replace(release.BOXES_ENVIRONMENT.decode(),
                                release.BOXES_ENVIRONMENT.decode() + '      SECRET: x\n')
        for invalid in [without_settings, extra]:
            with self.subTest(compose=invalid):
                self.scenario(changes={'compose.yaml': invalid}, expected_error='Unexpected Compose change')

    def test_a_caddyfile_that_cannot_take_the_route_refuses_before_any_change(self):
        commands = self.scenario(caddy_refused=True, expected_error='nothing was changed')
        self.assertFalse(any(c[:2] == ('docker', 'build') for c in commands))

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


class CaddyRouteTests(unittest.TestCase):
    SITE = ('companion.example.com {\n'
            '  @mini path /miniapp/\n'
            '  handle @mini {\n    reverse_proxy 127.0.0.1:3000\n  }\n'
            + release.CADDY_ANCHOR + '}\n')

    def install(self, site, *, reaches=True, validate_fails=False):
        with tempfile.TemporaryDirectory() as directory:
            caddyfile = pathlib.Path(directory) / 'Caddyfile'
            caddyfile.write_text(site)
            commands = []

            def run(args, **kwargs):
                commands.append(tuple(args))
                if args[:2] == ['caddy', 'validate'] and validate_fails:
                    raise subprocess.CalledProcessError(1, args)
                return subprocess.CompletedProcess(args, 0, stdout='')

            with patch.object(release, 'CADDYFILE', caddyfile), \
                    patch.object(release, 'run', side_effect=run), \
                    patch.object(release, 'caddy_reaches_gateway', return_value=reaches):
                try:
                    result = release.install_caddy_route()
                    error = None
                except RuntimeError as caught:
                    result, error = None, str(caught)
            return result, error, caddyfile.read_text(), commands

    def test_route_is_added_before_the_catch_all_and_reloaded(self):
        result, error, text, commands = self.install(self.SITE)
        self.assertEqual((result, error), ('added', None))
        self.assertEqual(text, self.SITE.replace(release.CADDY_ANCHOR, release.CADDY_ROUTE + release.CADDY_ANCHOR))
        self.assertLess(text.index('@boxes'), text.index('respond "Not found" 404'))
        self.assertIn(('systemctl', 'reload', 'caddy'), commands)
        self.assertEqual(commands[0][:2], ('caddy', 'validate'))

    def test_an_installed_route_is_left_alone(self):
        installed = self.SITE.replace(release.CADDY_ANCHOR, release.CADDY_ROUTE + release.CADDY_ANCHOR)
        result, error, text, commands = self.install(installed)
        self.assertEqual((result, error, text, commands), ('present', None, installed, []))

    def test_an_unexpected_caddyfile_is_not_edited(self):
        for site in [self.SITE.replace(release.CADDY_ANCHOR, ''), self.SITE + self.SITE,
                     self.SITE.replace('@mini', '@mini path /boxes/x\n  @other')]:
            with self.subTest(site=site):
                result, error, text, commands = self.install(site)
                self.assertRegex(error, 'does not match the reviewed anchor')
                self.assertEqual((text, commands), (site, []))

    def test_validation_failure_changes_nothing(self):
        result, error, text, commands = self.install(self.SITE, validate_fails=True)
        self.assertRegex(error, 'failed validation')
        self.assertEqual(text, self.SITE)
        self.assertNotIn(('systemctl', 'reload', 'caddy'), commands)

    def test_a_route_that_does_not_reach_the_gateway_is_rolled_back(self):
        result, error, text, commands = self.install(self.SITE, reaches=False)
        self.assertRegex(error, 'previous Caddyfile was restored')
        self.assertEqual(text, self.SITE)
        self.assertEqual(commands.count(('systemctl', 'reload', 'caddy')), 2)

    def test_a_completed_rollout_reruns_only_the_caddy_step(self):
        with tempfile.TemporaryDirectory() as directory:
            live = pathlib.Path(directory)
            (live / 'RELEASE').write_text(SHA + '\n')
            with patch.object(release, 'LIVE', live), \
                    patch.object(release, 'LOCK', live / 'release.lock'), \
                    patch.object(sys, 'argv', ['deploy-boxes.py', str(live / 'unused.tar'), SHA]), \
                    patch.object(release, 'install_caddy_route', return_value='added') as install, \
                    patch.object(release, 'run') as run, \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                release.main()
            install.assert_called_once()
            run.assert_not_called()
            self.assertIn('"caddy": "added"', output.getvalue())

    def test_the_public_host_is_read_robustly(self):
        for line in ['CODING_PUBLIC_ORIGIN=https://Companion.Example.com',
                     'CODING_PUBLIC_ORIGIN="https://companion.example.com/"',
                     "CODING_PUBLIC_ORIGIN='https://companion.example.com'  "]:
            with self.subTest(line=line), tempfile.TemporaryDirectory() as directory:
                (pathlib.Path(directory) / '.env').write_text('OTHER=1\n' + line + '\n')
                with patch.object(release, 'LIVE', pathlib.Path(directory)):
                    self.assertEqual(release.public_host(), 'companion.example.com')
        with tempfile.TemporaryDirectory() as directory:
            (pathlib.Path(directory) / '.env').write_text('CODING_PUBLIC_ORIGIN=http://x.y\n')
            with patch.object(release, 'LIVE', pathlib.Path(directory)):
                with self.assertRaisesRegex(RuntimeError, 'unavailable'):
                    release.public_host()

    def test_the_route_check_accepts_only_gateway_answers_through_local_caddy(self):
        for stdout, expected in [('{"error":"Box credential refused"}\n401', True),
                                 ('{"error":"Not found"}\n404', True),
                                 ('Not found\n404', False), ('\n502', False)]:
            with self.subTest(stdout=stdout), patch.object(release, 'public_host', return_value='h.example'), \
                    patch.object(release.subprocess, 'run',
                                 return_value=subprocess.CompletedProcess([], 0, stdout=stdout)) as run:
                self.assertEqual(release.caddy_reaches_gateway(), expected)
                self.assertIn('h.example:443:127.0.0.1', run.call_args[0][0])

    def test_the_route_matches_the_live_site_structure(self):
        live = (ROOT / 'ops/oauth-site/Caddyfile').read_text()
        self.assertEqual(live.count(release.CADDY_ANCHOR), 1)


if __name__ == '__main__':
    unittest.main()
