#!/usr/bin/env python3
"""Offline operator-rollout tests: subprocesses, database and health are stubbed."""
import contextlib
import importlib.util
import io
import json
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'deploy_agentwatch', pathlib.Path(__file__).with_name('deploy-agentwatch.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
ROOT = pathlib.Path(__file__).resolve().parent.parent
SHA = 'a' * 40
PINNED = 'c' * 64
CONTAINER = release.AGENTWATCH_CONTAINER
BASE_COMPOSE = ('services:\n  gateway:\n    environment:\n'
                '      VOICE_REPLIES: ${VOICE_REPLIES:-false}\n'
                '    ports: ["127.0.0.1:3000:3000"]\n    read_only: true\n'
                'networks:\n  browser-control: { internal: true }\n'
                'volumes:\n  postgres-data:\n')
STOP = ('compose', 'stop', 'gateway')
UP_AGENTWATCH = ('compose', 'up', '-d', '--no-deps', 'agentwatch')
UP_GATEWAY = ('compose', 'up', '-d', '--no-deps', '--no-build', 'gateway')
PULL = ('docker', 'pull', release.AGENTWATCH_IMAGE)
REMOVE = ('docker', 'rm', '-f', CONTAINER)
REACH = ('compose', 'exec', '-T', 'gateway', 'node', '-e', release.GATEWAY_REACHES_AGENTWATCH)


def candidate_compose(base=BASE_COMPOSE):
    result = base.encode()
    for anchor, replacement in release.COMPOSE_EDITS:
        result = result.replace(anchor, replacement)
    return result.decode()


class AgentwatchRolloutTests(unittest.TestCase):
    def test_single_verified_baseline(self):
        self.assertEqual(release.BASES, {release.BASE})

    def test_repository_compose_carries_exactly_the_reviewed_edits(self):
        live = (ROOT / 'compose.yaml').read_bytes()
        if b'    image: ' + release.AGENTWATCH_IMAGE.encode() + b'\n' not in live:
            # This rollout ran (journal 134); later agentwatch updates change the block
            # through scripts/deploy-agentwatch-update.py.
            self.skipTest('the agentwatch block has since been updated')
        for _, replacement in release.COMPOSE_EDITS:
            self.assertEqual(live.count(replacement), 1)
        self.assertEqual(live.count(b'    image: ' + release.AGENTWATCH_IMAGE.encode() + b'\n'), 1)

    def test_edits_turn_main_compose_into_repository_compose(self):
        shown = subprocess.run(['git', 'show', 'origin/main:compose.yaml'], cwd=ROOT,
                               capture_output=True)
        if shown.returncode:
            self.skipTest('origin/main is unavailable in this checkout')
        if b'agentwatch' in shown.stdout:
            self.skipTest('origin/main already carries the agentwatch edits')
        self.assertEqual(release.apply_compose_edits(shown.stdout), (ROOT / 'compose.yaml').read_bytes())

    def scenario(self, *, running=0, pending=0, baseline=None, requested_sha=SHA,
                 archive_sha=SHA, changes=None, unsafe=None, health=None, digest=PINNED,
                 build_failure=False, pull_failure=False, agentwatch_state='healthy',
                 agentwatch_curl_failure=False, ingest_failure=False, reach_failure=False, publish_failure=False,
                 late_running=0, late_pending=0, expected_error=None):
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
                'db/010_memory.sql': '-- original memory migration\n',
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
            containers = set()

            def run(args, **kwargs):
                commands.append(tuple(args))
                if args[:2] == ['docker', 'build'] and build_failure:
                    raise subprocess.CalledProcessError(1, args, stderr='PRIVATE_SENTINEL')
                if args[:2] == ['docker', 'pull'] and pull_failure:
                    raise subprocess.CalledProcessError(1, args, stderr='PRIVATE_SENTINEL')
                if args[:2] == ['docker', 'inspect']:
                    return subprocess.CompletedProcess(args, 0, stdout=agentwatch_state + '\n')
                if args[0] == 'curl' and agentwatch_curl_failure:
                    raise subprocess.CalledProcessError(22, args)
                if args[0] == 'curl' and '/v1/traces' in args[-1] and ingest_failure:
                    raise subprocess.CalledProcessError(22, args)
                if args[:3] == ['docker', 'rm', '-f']:
                    containers.discard(args[3])
                if args[:2] == ['docker', 'ps']:
                    return subprocess.CompletedProcess(args, 0, stdout='id\n' if containers else '')
                return subprocess.CompletedProcess(args, 0, stdout='')

            def compose(*args, **kwargs):
                commands.append(('compose', *args))
                if args == UP_AGENTWATCH[1:]:
                    containers.add(CONTAINER)
                if args[:3] == ('exec', '-T', 'gateway') and reach_failure:
                    raise subprocess.CalledProcessError(1, args, stderr='PRIVATE_SENTINEL')
                return subprocess.CompletedProcess(args, 0, stdout='previous-image\n')

            def sql(statement):
                # The first check precedes any change; later checks follow agentwatch's start.
                late = statement in statements
                statements.append(statement)
                if statement == "SELECT count(*) FROM runtime_runs WHERE state='running'":
                    return str(late_running if late else running)
                if statement == "SELECT count(*) FROM conversation_inputs WHERE state IN ('queued','running')":
                    return str(late_pending if late else pending)
                self.fail('Unexpected SQL statement: this rollout has no migration')

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
                    patch.object(release, 'AGENTWATCH_DIGEST', digest), \
                    patch.object(sys, 'argv', ['deploy-agentwatch.py', str(archive_path), requested_sha]), \
                    patch.object(release, 'run', side_effect=run), \
                    patch.object(release, 'compose', side_effect=compose), \
                    patch.object(release, 'sql', side_effect=sql), \
                    patch.object(release, 'healthy', side_effect=health or [True, True]), \
                    patch.object(release, 'publish_source', side_effect=publish), \
                    patch.object(release.time, 'sleep'), \
                    contextlib.redirect_stdout(output):
                if expected_error:
                    with self.assertRaisesRegex(RuntimeError, expected_error) as caught:
                        release.main()
                    self.assertNotIn('PRIVATE_SENTINEL', str(caught.exception))
                else:
                    release.main()

            self.assertEqual((live / '.env').read_text(), 'PRIVATE_SENTINEL=must-stay-private\n')
            self.assertNotIn('PRIVATE_SENTINEL', output.getvalue())
            self.assertFalse(any('/usr/local/sbin/' in str(c) for c in commands))
            self.assertFalse(any('postgres' in c for c in commands if c[0] == 'compose'))
            self.assertFalse(any('volume' in c for c in commands))
            self.assertEqual({file.name for file in (live / 'db').iterdir()}, {'001_initial.sql', '010_memory.sql'})
            if not expected_error:
                self.assertEqual(json.loads(output.getvalue()), {'deployed': SHA, 'healthy': True, 'agentwatch': True})
                self.assertEqual((live / 'RELEASE').read_text(), SHA + '\n')
                self.assertEqual((live / 'src/main.ts').read_text(), candidate['src/main.ts'])
                self.assertEqual((live / 'compose.yaml').read_text(), candidate['compose.yaml'])
                self.assertNotIn(REMOVE, commands)
                build = next(i for i, c in enumerate(commands) if c[:2] == ('docker', 'build'))
                inspect = next(i for i, c in enumerate(commands) if c[:2] == ('docker', 'inspect'))
                self.assertEqual(commands.count(STOP), 1)
                self.assertEqual(len(statements), 4)
                order = [build, commands.index(PULL), commands.index(UP_AGENTWATCH), inspect,
                         commands.index(STOP),
                         commands.index(('docker', 'tag', 'hermes-companion-gateway:' + SHA,
                                         release.IMAGE + ':latest')),
                         commands.index(UP_GATEWAY), commands.index(REACH)]
                self.assertEqual(order, sorted(order))
            else:
                self.assertEqual(output.getvalue(), '')
                self.assertEqual((live / 'RELEASE').read_text(), (baseline or release.BASE) + '\n')
                self.assertEqual((live / 'compose.yaml').read_text(), BASE_COMPOSE)
                self.assertEqual((live / 'src/main.ts').read_text(), original['src/main.ts'])
                self.assertFalse((live / 'docs/new.md').exists())
                self.assertFalse((live / '.RELEASE-agentwatch').exists())
                if 'operator inspection' not in (expected_error or ''):
                    self.assertEqual(containers, set())
                if STOP in commands:
                    self.assertIn(('docker', 'tag', 'previous-image', release.IMAGE + ':latest'), commands)
                    if 'operator inspection' not in (expected_error or ''):
                        # The gateway is restored first; agentwatch is removed after it.
                        self.assertIn(REMOVE, commands)
                        self.assertLess(commands.index(UP_GATEWAY, commands.index(STOP)),
                                        commands.index(REMOVE))
                else:
                    # The gateway was never touched: not stopped, retagged or recreated.
                    self.assertFalse(any(c[0] == 'compose' and c[1] in ('stop', 'exec') for c in commands))
                    self.assertNotIn(UP_GATEWAY, commands)
                    self.assertFalse(any(c[:2] == ('docker', 'tag') and c[3].endswith(':latest') for c in commands))
                    if UP_AGENTWATCH in commands:
                        self.assertIn(REMOVE, commands)
                        self.assertLess(commands.index(UP_AGENTWATCH), commands.index(REMOVE))
                    else:
                        self.assertNotIn(REMOVE, commands)
                        self.assertFalse(any(c[0] == 'compose' and c[1] == 'up' for c in commands))
                        self.assertFalse(any(c[:2] == ('docker', 'tag') for c in commands))
            return commands

    def test_success_starts_agentwatch_then_recreates_gateway_and_publishes(self):
        self.scenario()

    def test_unpinned_agentwatch_digest_is_refused(self):
        self.scenario(digest='AGENTWATCH_DIGEST', expected_error='digest is not pinned')

    def test_unreviewed_baseline_is_refused(self):
        self.scenario(baseline='b' * 40, expected_error='exact documented baseline')

    def test_exact_archive_commit_and_usage(self):
        for args, message in [({'archive_sha': 'b' * 40}, 'Archive commit'),
                              ({'requested_sha': 'main'}, 'Usage:')]:
            with self.subTest(args=args):
                self.scenario(**args, expected_error=message)

    def test_unsafe_archive_entries_refuse_before_stop(self):
        for unsafe in ['../escape', '/absolute', 'malicious-link', '.env',
                       'nested/.env.production', 'RELEASE', '.RELEASE-agentwatch', 'src/main.ts']:
            with self.subTest(entry=unsafe):
                self.scenario(unsafe=unsafe, expected_error='Unsafe archive entry')

    def test_only_exact_compose_edits_are_allowed(self):
        correct = candidate_compose()
        image = release.AGENTWATCH_IMAGE
        for invalid in [BASE_COMPOSE, correct.replace('read_only: true', 'read_only: false'),
                        correct + '  unreviewed: {}\n',
                        correct.replace(image, image[:-1] + 'x'),
                        correct.replace('CHIEF_TRACE_CONTENT:-true', 'CHIEF_TRACE_CONTENT:-false'),
                        correct.replace('  agentwatch-data:\n', ''),
                        correct.replace('"127.0.0.1:4318:4318"', '"4318:4318"')]:
            with self.subTest(compose=invalid):
                self.scenario(changes={'compose.yaml': invalid}, expected_error='Unexpected Compose change')

    def test_live_compose_must_match_reviewed_baseline(self):
        with self.assertRaisesRegex(RuntimeError, 'Compose baseline'):
            release.apply_compose_edits(candidate_compose().encode())
        with self.assertRaisesRegex(RuntimeError, 'Compose baseline'):
            release.apply_compose_edits(BASE_COMPOSE.replace('  postgres-data:\n', '').encode())

    def test_any_database_change_is_refused(self):
        for changes in [{'db/001_initial.sql': '-- modified'}, {'db/001_initial.sql': None},
                        {'db/030_unreviewed.sql': '-- unreviewed'}, {'db/nested/unreviewed.txt': 'x'}]:
            with self.subTest(changes=changes):
                self.scenario(changes=changes, expected_error='permits no db/ change')

    def test_trusted_release_handler_cannot_change_incidentally(self):
        self.scenario(changes={'scripts/cloud-release.py': '# modified'}, expected_error='Trusted release-handler source changed')

    def test_active_work_and_pending_input_refuse_before_stop(self):
        for args, message in [({'running': 1}, 'Active work'), ({'pending': 1}, 'Pending conversation input')]:
            with self.subTest(args=args):
                self.scenario(**args, expected_error=message)

    def test_build_pull_and_baseline_health_failures_leave_live_unchanged(self):
        self.scenario(build_failure=True, expected_error='Candidate build failed')
        commands = self.scenario(pull_failure=True, expected_error='agentwatch image pull failed; live application unchanged')
        self.assertNotIn(STOP, commands)
        self.scenario(health=[False], expected_error='Baseline application is not healthy')

    def test_unhealthy_agentwatch_rolls_back_without_touching_gateway(self):
        for args in [{'agentwatch_state': 'unhealthy'}, {'agentwatch_state': 'starting'},
                     {'agentwatch_curl_failure': True}]:
            with self.subTest(args=args):
                commands = self.scenario(**args, health=[True], expected_error='agentwatch removed, its volume kept')
                self.assertNotIn(STOP, commands)
                self.assertNotIn(UP_GATEWAY, commands)
                self.assertIn(REMOVE, commands)

    def test_agentwatch_that_cannot_store_a_span_rolls_back_without_touching_gateway(self):
        commands = self.scenario(ingest_failure=True, health=[True, True],
                                 expected_error='agentwatch did not start; gateway untouched')
        self.assertNotIn(STOP, commands)
        self.assertIn(REMOVE, commands)

    def test_work_started_while_agentwatch_started_leaves_gateway_untouched(self):
        for args in [{'late_running': 1}, {'late_pending': 1}]:
            with self.subTest(args=args):
                commands = self.scenario(**args, health=[True], expected_error=(
                    'Work started while agentwatch was starting; gateway untouched, agentwatch removed; retry when idle'))
                self.assertNotIn(STOP, commands)
                self.assertNotIn(UP_GATEWAY, commands)
                self.assertLess(next(i for i, c in enumerate(commands) if c[:2] == ('docker', 'inspect')),
                                commands.index(REMOVE))

    def test_unhealthy_gateway_rolls_back(self):
        self.scenario(health=[True, False, True], expected_error='Candidate failed; previous application healthy')

    def test_gateway_unable_to_reach_agentwatch_rolls_back(self):
        commands = self.scenario(reach_failure=True, health=[True, True, True], expected_error='agentwatch removed')
        self.assertIn(REACH, commands)

    def test_source_publication_failure_restores_files_and_app(self):
        self.scenario(publish_failure=True, health=[True, True, True], expected_error='previous application healthy')

    def test_unhealthy_rollback_requires_operator_inspection(self):
        self.scenario(health=[True, False, False], expected_error='Rollback needs operator inspection')


if __name__ == '__main__':
    unittest.main()
