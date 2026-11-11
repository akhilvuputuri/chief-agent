#!/usr/bin/env python3
"""Offline tests for the agentwatch key rollout: subprocesses, database and health are stubbed.

They run against synthetic Compose fixtures and against the repository's own compose.yaml,
with or without the reviewed line applied, so they pass before and after the rollout PR.
"""
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

HERE = pathlib.Path(__file__)
spec = importlib.util.spec_from_file_location(
    'deploy_agentwatch_key', HERE.with_name('deploy-agentwatch-key.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
SHA = 'a' * 40
# Stands in for the live baseline SHA the rollout PR records in BASE.
FIXTURE_BASE = 'c' * 40
BASE_COMPOSE = ('services:\n  gateway:\n    environment:\n'
                '      OTEL_EXPORTER_OTLP_ENDPOINT: ${CHIEF_TRACE_ENDPOINT-http://agentwatch:4318}\n'
                '      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: ${CHIEF_TRACE_CONTENT:-true}\n'
                '    ports: ["127.0.0.1:3000:3000"]\n    read_only: true\n'
                '  agentwatch:\n    environment:\n'
                '      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}\n')
KEY = 'secret-sentinel-' + 'k' * 32
KEYED_ENV = ('PRIVATE_SENTINEL=must-stay-private\n'
             'OPENROUTER_API_KEY=secret-sentinel-or\n'
             'AGENTWATCH_API_KEY=' + KEY + '\n')
REPO_COMPOSE = (HERE.parent.parent / 'compose.yaml').read_text()
APPLIED = (release.COMPOSE_ANCHOR + release.COMPOSE_ADDITION).decode()


def repo_baseline():
    """The repository's compose.yaml without the reviewed lines, whether or not they are applied yet."""
    return REPO_COMPOSE.replace(APPLIED, release.COMPOSE_ANCHOR.decode())


class AgentwatchKeyRolloutTests(unittest.TestCase):
    def test_base_is_unset_or_one_exact_sha(self):
        if release.BASE is None:
            self.assertEqual(release.bases(), set())
        else:
            self.assertRegex(release.BASE, '^[0-9a-f]{40}$')
            self.assertEqual(release.bases(), {release.BASE})

    def test_base_is_set_once_compose_carries_the_line(self):
        # The rollout PR adds the Compose line; it must record the reviewed live baseline too.
        if APPLIED in REPO_COMPOSE:
            self.assertRegex(release.BASE or '', '^[0-9a-f]{40}$',
                             'compose.yaml has the AGENTWATCH_API_KEY name: set BASE to the reviewed live RELEASE')

    def test_unset_base_refuses_before_anything(self):
        commands = self.scenario(base=None, expected_error='BASE is unset')
        self.assertEqual(commands, [])
        with patch.object(release, 'BASE', 'not-a-sha'):
            self.assertEqual(release.bases(), set())

    def test_repository_compose_differs_by_exactly_the_reviewed_lines(self):
        baseline = repo_baseline()
        self.assertEqual(baseline.count(release.COMPOSE_ANCHOR.decode()), 1)
        self.assertNotIn('AGENTWATCH_API_KEY', baseline)
        self.assertEqual(release.COMPOSE_ADDITION.decode().splitlines(), [
            '      AGENTWATCH_API_KEY: ${AGENTWATCH_API_KEY:-}'])
        expected = release.expected_compose(baseline.encode()).decode()
        before, after = baseline.splitlines(), expected.splitlines()
        self.assertEqual(len(after), len(before) + 1)
        index = next(i for i, line in enumerate(after) if i >= len(before) or line != before[i])
        self.assertEqual(after[index] + '\n', release.COMPOSE_ADDITION.decode())
        self.assertEqual(after[index - 1] + '\n', release.COMPOSE_ANCHOR.decode())
        self.assertEqual(after[:index] + after[index + 1:], before)
        if APPLIED in REPO_COMPOSE:
            self.assertEqual(expected, REPO_COMPOSE)
        # An already-applied baseline is not the reviewed one.
        self.assertIsNone(release.expected_compose(expected.encode()))

    def test_success_with_the_repository_compose(self):
        self.scenario(base_compose=repo_baseline())

    def scenario(self, *, running=0, pending=0, coding=0, baseline=None, requested_sha=SHA,
                 archive_sha=SHA, changes=None, unsafe=None, health=None, env=KEYED_ENV,
                 build_failure=False, publish_failure=False, expected_error=None,
                 base_compose=BASE_COMPOSE, base=...):
        # The recorded BASE once set, else a fixture SHA; base=None tests the unset script.
        base = (release.BASE or FIXTURE_BASE) if base is ... else base
        with patch.object(release, 'BASE', base):
            return self.run_scenario(
                running=running, pending=pending, coding=coding, baseline=baseline,
                requested_sha=requested_sha, archive_sha=archive_sha, changes=changes,
                unsafe=unsafe, health=health, env=env, build_failure=build_failure,
                publish_failure=publish_failure, expected_error=expected_error,
                base_compose=base_compose)

    def run_scenario(self, *, running, pending, coding, baseline, requested_sha, archive_sha,
                     changes, unsafe, health, env, build_failure, publish_failure,
                     expected_error, base_compose):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            live = root / 'live'
            live.mkdir()
            original = {
                'Dockerfile': 'FROM scratch\n', 'package.json': '{}\n',
                'package-lock.json': '{}\n', 'compose.yaml': base_compose,
                'src/main.ts': '// previous application\n',
                'scripts/cloud-release.py': '# unchanged restricted entrypoint\n',
                'db/001_initial.sql': '-- original migration\n',
            }
            for name, content in original.items():
                path = live / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
            (live / 'RELEASE').write_text((baseline or release.BASE or FIXTURE_BASE) + '\n')
            (live / '.env').write_text(env)
            candidate = dict(original)
            candidate['src/main.ts'] = '// reviewed candidate\n'
            candidate['compose.yaml'] = base_compose.replace(
                release.COMPOSE_ANCHOR.decode(), APPLIED)
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
                    patch.object(sys, 'argv', ['deploy-agentwatch-key.py', str(archive_path), requested_sha]), \
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
                self.assertEqual((live / 'RELEASE').read_text(), (baseline or release.BASE or FIXTURE_BASE) + '\n')
                self.assertEqual((live / 'compose.yaml').read_text(), base_compose)
                self.assertEqual((live / 'src/main.ts').read_text(), original['src/main.ts'])
                if stop in commands:
                    self.assertIn(('docker', 'tag', 'previous-image', release.IMAGE + ':latest'), commands)
                else:
                    self.assertFalse(any(c[0] == 'compose' and c[1] in ('stop', 'up') for c in commands))
            return commands

    def test_success_switches_compose_and_publishes_source(self):
        self.scenario()

    def test_application_and_config_changes_ride_along(self):
        # The enabling PR also changes config/ and src/, as an ordinary release would.
        self.scenario(changes={'config/coding-pi.json': '{"model": "candidate"}\n',
                               'src/custom-agent.ts': '// candidate loop\n'})

    def test_missing_empty_or_malformed_key_refuses_before_any_change(self):
        for env in ['PRIVATE_SENTINEL=x\nOPENROUTER_API_KEY=secret-sentinel-or\n',
                    'AGENTWATCH_API_KEY=\n',
                    '# AGENTWATCH_API_KEY=' + KEY + '\n',
                    'AGENTWATCH_API_KEY=""\n',
                    "AGENTWATCH_API_KEY=''\n",
                    'AGENTWATCH_API_KEY=   # later\n',
                    'AGENTWATCH_API_KEY_OLD=' + KEY + '\n',
                    KEYED_ENV + 'AGENTWATCH_API_KEY=\n',
                    # Too short for agentwatch, or not a plain header value.
                    'AGENTWATCH_API_KEY=secret-sentinel-short\n',
                    'AGENTWATCH_API_KEY=secret-sentinel' + ' ' + 'k' * 32 + 'x\n',
                    'AGENTWATCH_API_KEY=secret-sentinel:' + 'k' * 32 + '\n']:
            with self.subTest(env=env):
                commands = self.scenario(env=env, expected_error='Add AGENTWATCH_API_KEY')
                self.assertEqual(commands, [])

    def test_quoted_key_is_accepted(self):
        self.scenario(env='AGENTWATCH_API_KEY="' + KEY + '"\n')

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

    def test_only_the_reviewed_name_may_change_compose(self):
        correct = BASE_COMPOSE.replace(release.COMPOSE_ANCHOR.decode(), APPLIED)
        addition = release.COMPOSE_ADDITION.decode()
        agentwatch_anchor = '      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}\n'
        for invalid in [BASE_COMPOSE, correct.replace('read_only: true', 'read_only: false'),
                        correct + '  unreviewed: {}\n',
                        correct.replace(addition, addition * 2),
                        # A default value in Compose, or a required one.
                        correct.replace(addition, '      AGENTWATCH_API_KEY: ${AGENTWATCH_API_KEY:-' + 'k' * 32 + '}\n'),
                        correct.replace(addition, '      AGENTWATCH_API_KEY: ${AGENTWATCH_API_KEY:?Set it}\n'),
                        # In the agentwatch service instead, which its own update procedure governs.
                        BASE_COMPOSE.replace(agentwatch_anchor, agentwatch_anchor + addition),
                        # The right line in the wrong place.
                        BASE_COMPOSE.replace('    read_only: true\n', addition + '    read_only: true\n')]:
            with self.subTest(compose=invalid):
                self.scenario(changes={'compose.yaml': invalid}, expected_error='Unexpected Compose change')

    def test_unreviewed_compose_baseline_refuses(self):
        anchor = release.COMPOSE_ANCHOR.decode()
        # No anchor, a repeated anchor, or the line already installed by hand.
        for baseline in [BASE_COMPOSE.replace(anchor, ''), BASE_COMPOSE + anchor,
                         BASE_COMPOSE.replace(anchor, APPLIED)]:
            with self.subTest(baseline=baseline):
                self.assertIsNone(release.expected_compose(baseline.encode()))
                self.scenario(base_compose=baseline,
                              expected_error='Compose baseline does not match')

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
