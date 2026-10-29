#!/usr/bin/env python3
"""Offline agentwatch-update tests: subprocesses and health are stubbed."""
import contextlib
import importlib.util
import io
import json
import pathlib
import re
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'deploy_agentwatch_update', pathlib.Path(__file__).with_name('deploy-agentwatch-update.py'))
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)
ROOT = pathlib.Path(__file__).resolve().parent.parent
SHA = 'a' * 40
REPOSITORY = 'ghcr.io/akhilvuputuri/agentwatch@sha256:'
OLD_IMAGE = REPOSITORY + 'b' * 64
NEW_IMAGE = REPOSITORY + 'c' * 64
LIVE_COMPOSE = ('services:\n  gateway:\n    environment:\n'
                '      OTEL_EXPORTER_OTLP_ENDPOINT: ${CHIEF_TRACE_ENDPOINT-http://agentwatch:4318}\n'
                '    ports: ["127.0.0.1:3000:3000"]\n    read_only: true\n'
                '  agentwatch:\n'
                '    # Trace viewer, pinned by digest.\n'
                '    image: ' + OLD_IMAGE + '\n'
                '    volumes: ["agentwatch-data:/data"]\n'
                '    ports: ["127.0.0.1:4318:4318"]\n'
                '    read_only: true\n'
                '    cap_drop: [ALL]\n'
                '    mem_limit: 512m\n'
                '    restart: unless-stopped\n'
                'networks:\n  browser-control: { internal: true }\n'
                'volumes:\n  postgres-data:\n  agentwatch-data:\n')
STAGED_COMPOSE = LIVE_COMPOSE.replace(
    '    image: ' + OLD_IMAGE + '\n',
    '    image: ' + NEW_IMAGE + '\n    environment:\n      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}\n')
UP = ('compose', 'up', '-d', '--no-deps', 'agentwatch')
IMAGE_ID = ('docker', 'inspect', '--format', '{{.Image}}', update.AGENTWATCH_CONTAINER)
HEALTH = ('docker', 'inspect', '--format', '{{.State.Health.Status}}', update.AGENTWATCH_CONTAINER)
GATEWAY = ('curl', '--fail', '--silent', '--max-time', '3', 'http://127.0.0.1:3000/healthz')


class AgentwatchUpdateTests(unittest.TestCase):
    def test_repository_compose_is_a_valid_update_of_main(self):
        shown = subprocess.run(['git', 'show', 'origin/main:compose.yaml'], cwd=ROOT,
                               capture_output=True)
        if shown.returncode:
            self.skipTest('origin/main is unavailable in this checkout')
        staged = (ROOT / 'compose.yaml').read_bytes()
        if staged == shown.stdout:
            self.skipTest('compose.yaml matches origin/main; no agentwatch update pending')
        # Until the new digest is pinned, stand in a well-formed one for the placeholder.
        self.assertTrue(update.validate_compose(shown.stdout, staged).startswith(REPOSITORY))

    def scenario(self, *, live_compose=LIVE_COMPOSE, staged_compose=STAGED_COMPOSE,
                 requested_sha=SHA, archive_sha=SHA, changes=None, unsafe=None,
                 pull_failure=False, current_missing=False, gateway_before=True,
                 gateway_after=True, new_health='healthy', ingest_failure=False,
                 old_health='healthy', expected_error=None):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            live = root / 'live'
            live.mkdir()
            original = {
                'Dockerfile': 'FROM scratch\n', 'package.json': '{}\n',
                'package-lock.json': '{}\n', 'compose.yaml': live_compose,
                'src/main.ts': '// live application\n',
                'scripts/cloud-release.py': '# unchanged restricted entrypoint\n',
                'db/001_initial.sql': '-- original migration\n',
                'db/010_memory.sql': '-- original memory migration\n',
            }
            for name, content in original.items():
                path = live / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
            (live / 'RELEASE').write_text('e' * 40 + '\n')
            (live / '.env').write_text('PRIVATE_SENTINEL=must-stay-private\n')
            candidate = dict(original)
            candidate['src/main.ts'] = '// reviewed main\n'
            candidate['compose.yaml'] = staged_compose
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

            commands = []
            container = {'image': None if current_missing else 'sha256:old'}

            def run(args, **kwargs):
                args = tuple(args)
                commands.append(args)
                if args[:2] == ('docker', 'pull') and pull_failure:
                    raise subprocess.CalledProcessError(1, args, stderr='PRIVATE_SENTINEL')
                if args[:2] == ('docker', 'inspect'):
                    if container['image'] is None:
                        raise subprocess.CalledProcessError(1, args, stderr='PRIVATE_SENTINEL')
                    if args == IMAGE_ID:
                        return subprocess.CompletedProcess(args, 0, stdout=container['image'] + '\n')
                    state = new_health if container['image'] == 'sha256:new' else old_health
                    return subprocess.CompletedProcess(args, 0, stdout=state + '\n')
                if args == GATEWAY and not (gateway_after if UP in commands else gateway_before):
                    raise subprocess.CalledProcessError(7, args)
                if args[0] == 'curl' and args[-1].endswith('/v1/traces') and ingest_failure:
                    raise subprocess.CalledProcessError(22, args)
                return subprocess.CompletedProcess(args, 0, stdout='')

            def compose(*args, **kwargs):
                commands.append(('compose', *args))
                if ('compose', *args) == UP:
                    current = (live / 'compose.yaml').read_text()
                    container['image'] = 'sha256:new' if current == staged_compose else 'sha256:old'
                return subprocess.CompletedProcess(args, 0, stdout='')

            output = io.StringIO()
            with patch.object(update, 'LIVE', live), \
                    patch.object(update, 'LOCK', root / 'release.lock'), \
                    patch.object(sys, 'argv', ['deploy-agentwatch-update.py', str(archive_path), requested_sha]), \
                    patch.object(update, 'run', side_effect=run), \
                    patch.object(update, 'compose', side_effect=compose), \
                    patch.object(update.time, 'sleep'), \
                    contextlib.redirect_stdout(output):
                if expected_error:
                    with self.assertRaisesRegex(RuntimeError, expected_error) as caught:
                        update.main()
                    self.assertNotIn('PRIVATE_SENTINEL', str(caught.exception))
                else:
                    update.main()

            # Never the gateway (beyond its read-only health), RELEASE, source, volume or .env.
            for command in commands:
                self.assertTrue(command in (UP, GATEWAY) or command[0] == 'curl' and ':4318/' in command[-1]
                                or command[:2] in (('docker', 'pull'), ('docker', 'inspect')), command)
                if command != GATEWAY:
                    self.assertFalse(any('gateway' in part or ':3000' in part for part in command), command)
            self.assertEqual((live / 'RELEASE').read_text(), 'e' * 40 + '\n')
            self.assertEqual((live / 'src/main.ts').read_text(), original['src/main.ts'])
            self.assertEqual((live / '.env').read_text(), 'PRIVATE_SENTINEL=must-stay-private\n')
            self.assertNotIn('PRIVATE_SENTINEL', output.getvalue())
            if not expected_error:
                image = re.search(r'    image: (\S+)\n', staged_compose).group(1)
                self.assertEqual(json.loads(output.getvalue()), {'agentwatch': image, 'healthy': True})
                self.assertIn(('docker', 'pull', image), commands)
                self.assertEqual((live / 'compose.yaml').read_text(), staged_compose)
                self.assertEqual(container['image'], 'sha256:new')
                post = next(i for i, c in enumerate(commands) if c[-1].endswith('/v1/traces'))
                read = next(i for i, c in enumerate(commands) if '/api/traces/' in c[-1])
                gateway_checks = [i for i, c in enumerate(commands) if c == GATEWAY]
                order = [commands.index(('docker', 'pull', image)), commands.index(IMAGE_ID), gateway_checks[0],
                         commands.index(UP), commands.index(HEALTH), post, read, gateway_checks[-1]]
                self.assertEqual(order, sorted(order))
                self.assertEqual(commands.count(UP), 1)
            else:
                self.assertEqual(output.getvalue(), '')
                self.assertEqual((live / 'compose.yaml').read_text(), live_compose)
            return commands

    def test_success_recreates_only_agentwatch(self):
        self.scenario()

    def test_archive_and_usage_refusals(self):
        for args, message in [({'archive_sha': 'b' * 40}, 'Archive commit'),
                              ({'requested_sha': 'main'}, 'Usage:')]:
            with self.subTest(args=args):
                self.assertEqual(self.scenario(**args, expected_error=message), [])
        for unsafe in ['../escape', '/absolute', 'malicious-link', '.env', 'RELEASE', 'src/main.ts']:
            with self.subTest(entry=unsafe):
                self.scenario(unsafe=unsafe, expected_error='Unsafe archive entry')

    def test_database_and_release_handler_changes_are_refused(self):
        for changes, message in [({'db/001_initial.sql': '-- modified'}, 'permits no db/ change'),
                                 ({'db/002_new.sql': '-- new'}, 'permits no db/ change'),
                                 ({'db/001_initial.sql': None}, 'permits no db/ change'),
                                 ({'scripts/cloud-release.py': '# modified'}, 'Trusted release-handler')]:
            with self.subTest(changes=changes):
                self.assertEqual(self.scenario(changes=changes, expected_error=message), [])

    def test_compose_refusals_change_nothing(self):
        def block(old, new):
            self.assertIn(old, STAGED_COMPOSE)
            return STAGED_COMPOSE.replace(old, new)

        cases = [
            ({'staged_compose': STAGED_COMPOSE.replace('http://agentwatch:4318', 'http://other:4318')},
             'outside the agentwatch service'),
            ({'staged_compose': STAGED_COMPOSE.replace('  postgres-data:\n', '  postgres-data:\n  more:\n')},
             'outside the agentwatch service'),
            ({'live_compose': LIVE_COMPOSE[:LIVE_COMPOSE.index('  agentwatch:')]
              + LIVE_COMPOSE[LIVE_COMPOSE.index('networks:'):]}, 'Live compose.yaml must contain exactly one'),
            ({'staged_compose': STAGED_COMPOSE + '  agentwatch:\n    image: x\n'}, 'Staged compose.yaml must contain exactly one'),
            ({'staged_compose': block(NEW_IMAGE, REPOSITORY + 'NEW_AGENTWATCH_DIGEST')}, 'pinned by digest'),
            ({'staged_compose': block(NEW_IMAGE, NEW_IMAGE.replace('akhilvuputuri', 'someone-else'))}, 'pinned by digest'),
            ({'staged_compose': block(NEW_IMAGE, 'ghcr.io/akhilvuputuri/agentwatch:latest')}, 'pinned by digest'),
            ({'staged_compose': block('    mem_limit', '    image: ' + OLD_IMAGE + '\n    mem_limit')}, 'pinned by digest'),
            ({'staged_compose': block('127.0.0.1:4318:4318', '4318:4318')}, 'keep ports'),
            ({'staged_compose': block('    ports: ["127.0.0.1:4318:4318"]\n', '')}, 'keep ports'),
            ({'staged_compose': block('    mem_limit', '    ports: ["0.0.0.0:4319:4318"]\n    mem_limit')}, 'keep ports'),
            ({'staged_compose': block('    read_only: true\n    cap', '    read_only: false\n    cap')}, 'keep read_only'),
            ({'staged_compose': block('    cap_drop: [ALL]\n', '')}, 'keep cap_drop'),
            ({'staged_compose': block('    mem_limit: 512m\n', '')}, 'keep mem_limit'),
            ({'staged_compose': block('    restart:', '    privileged: true\n    restart:')}, 'weakens its isolation'),
            ({'staged_compose': block('    restart:', '    network_mode: host\n    restart:')}, 'weakens its isolation'),
            ({'staged_compose': block('    restart:', '    cap_add: [SYS_ADMIN]\n    restart:')}, 'weakens its isolation'),
            ({'staged_compose': LIVE_COMPOSE}, 'already up to date'),
        ]
        for args, message in cases:
            with self.subTest(args=args):
                commands = self.scenario(**args, expected_error=message)
                self.assertEqual(commands, [])

    def test_validation_accepts_env_only_and_limit_changes(self):
        self.scenario(staged_compose=LIVE_COMPOSE.replace('    mem_limit: 512m', '    mem_limit: 1g'))

    def test_pull_and_preflight_failures_change_nothing(self):
        for args, message in [({'pull_failure': True}, 'agentwatch image pull failed; nothing changed'),
                              ({'current_missing': True}, 'Current agentwatch container unavailable'),
                              ({'gateway_before': False}, 'Gateway is not healthy')]:
            with self.subTest(args=args):
                commands = self.scenario(**args, expected_error=message)
                self.assertNotIn(UP, commands)

    def test_failures_after_compose_written_restore_previous_agentwatch(self):
        for args in [{'new_health': 'unhealthy'}, {'new_health': 'starting'},
                     {'ingest_failure': True}, {'gateway_after': False}]:
            with self.subTest(args=args):
                commands = self.scenario(**args, expected_error='agentwatch update failed; previous agentwatch restored')
                self.assertEqual(commands.count(UP), 2)
                self.assertEqual(commands[-1], IMAGE_ID)

    def test_unhealthy_rollback_requires_operator_inspection(self):
        commands = self.scenario(new_health='unhealthy', old_health='unhealthy',
                                 expected_error='Rollback needs operator inspection')
        self.assertEqual(commands.count(UP), 2)


if __name__ == '__main__':
    unittest.main()
