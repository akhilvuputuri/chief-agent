#!/usr/bin/env python3
"""Offline agentwatch-update tests: subprocesses and health are stubbed."""
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import re
import shutil
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
                '    command:\n      [\n        "serve",\n        "--retain-days",\n        "90",\n      ]\n'
                '    volumes: ["agentwatch-data:/data"]\n'
                '    ports: ["127.0.0.1:4318:4318"]\n'
                '    read_only: true\n'
                '    tmpfs: [/tmp]\n'
                '    cap_drop: [ALL]\n'
                '    security_opt: ["no-new-privileges:true"]\n'
                '    mem_limit: 512m\n'
                '    stop_grace_period: 15s\n'
                '    restart: unless-stopped\n'
                'networks:\n  browser-control: { internal: true }\n'
                'volumes:\n  postgres-data:\n  agentwatch-data:\n')
JUDGE_POLICY = ('        "--judge-endpoint",\n        "https://openrouter.ai/api/v1",\n'
                '        "--judge-key-env",\n        "OPENROUTER_API_KEY",\n'
                '        "--judge-max-daily",\n        "50",\n')
STAGED_COMPOSE = LIVE_COMPOSE.replace(
    '    image: ' + OLD_IMAGE + '\n',
    '    image: ' + NEW_IMAGE + '\n    environment:\n      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}\n'
).replace('        "90",\n', '        "90",\n' + JUDGE_POLICY)
SIGN_IN = ('        "--auth-user",\n        "owner",\n'
           '        "--api-key-env",\n        "AGENTWATCH_API_KEY",\n'
           '        "--forwarded-allow-ips",\n        "172.18.0.1",\n')
SIGNED_COMPOSE = STAGED_COMPOSE.replace(
    '      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}\n',
    '      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}\n'
    '      AGENTWATCH_PASSWORD_HASH: ${AGENTWATCH_PASSWORD_HASH:-}\n'
    '      AGENTWATCH_API_KEY: ${AGENTWATCH_API_KEY:-}\n'
).replace('        "50",\n', '        "50",\n' + SIGN_IN)
KEY = 'secret-sentinel-' + 'k' * 32
SIGNED_ENV = ('PRIVATE_SENTINEL=must-stay-private\n'
              'AGENTWATCH_PASSWORD_HASH=scrypt:32768:8:3:c2FsdHNhbHRzYWx0c2FsdA:secret-sentinel-hash\n'
              'AGENTWATCH_API_KEY=' + KEY + '\n')
UP = ('compose', 'up', '-d', '--no-deps', 'agentwatch')
STOP = ('compose', 'stop', 'agentwatch')
HELPER = ('docker', 'run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
          '--security-opt', 'no-new-privileges:true', '--user', '0:0', '--entrypoint', 'python')
VOLUME = ('docker', 'volume', 'inspect', update.DATA_VOLUME)
PUBLIC = ('        "--allow-host",\n        "traces.example.com",\n'
          '        "--public-url",\n        "https://traces.example.com",\n')
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
        main_before, main_block, main_after = update.split_compose(shown.stdout, 'Live')
        before, block, after = update.split_compose(staged, 'Staged')
        if (before, after) != (main_before, main_after):
            if block != main_block:
                update.validate_block(block)
            self.skipTest('compose.yaml changes outside agentwatch; another rollout owns that change')
        self.assertTrue(update.validate_compose(shown.stdout, staged).startswith(REPOSITORY))

    def scenario(self, *, live_compose=LIVE_COMPOSE, staged_compose=STAGED_COMPOSE,
                 requested_sha=SHA, archive_sha=SHA, changes=None, unsafe=None,
                 pull_failure=False, current_missing=False, gateway_before=True,
                 gateway_after=True, new_health='healthy', ingest_failure=False,
                 old_health='healthy', expected_error=None,
                 env='PRIVATE_SENTINEL=must-stay-private\n', open_without_key=False,
                 gateway='172.18.0.1 ', backup_failure=False, restore_failure=False,
                 stop_failure=False, rollback_stop_failure=False, earlier_backups=(),
                 interrupt_at=None, volume_missing=False, expected=RuntimeError):
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
            (live / '.env').write_text(env)
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
            container = {'image': None if current_missing else 'sha256:old', 'running': True}
            # The data files' format, as the image that last ran left it. The new image
            # rewrites them, and the old image cannot open what it wrote.
            volume = {'format': 'old'}
            backups = root / 'backups'
            for name in earlier_backups:
                (backups / name).mkdir(parents=True)

            def helper(args):
                """The copy container: what it was given, and the copy it would make."""
                self.assertEqual(args[:len(HELPER)], HELPER)
                mounts = [args[i + 1] for i, part in enumerate(args) if part == '--volume']
                image, isolated, flag, script = args[-4:]
                self.assertEqual((image, isolated, flag), ('sha256:old', '-I', '-c'))
                self.assertEqual(commands[-2], VOLUME)  # checked to exist just before
                self.assertFalse(container['running'], 'copied while agentwatch was running')
                data, backup = (mount.split(':') for mount in mounts)
                self.assertEqual(data[0], update.DATA_VOLUME)
                folder = pathlib.Path(backup[0])
                self.assertEqual(folder.parent, backups)
                if script == update.COPY_OUT:
                    self.assertEqual((data[1:], backup[1:]), (['/data', 'ro'], ['/backup']))
                    # Written under a name that marks it unfinished.
                    self.assertTrue(folder.name.endswith(update.PARTIAL))
                    (folder / 'agentwatch.duckdb').write_text(volume['format'])
                    if backup_failure:
                        raise subprocess.CalledProcessError(1, args, stderr='PRIVATE_SENTINEL')
                else:
                    self.assertEqual(script, update.COPY_BACK)
                    self.assertEqual((data[1:], backup[1:]), (['/data'], ['/backup', 'ro']))
                    self.assertRegex(folder.name, update.COPY_NAME)
                    if restore_failure:
                        raise subprocess.CalledProcessError(1, args, stderr='PRIVATE_SENTINEL')
                    volume['format'] = (folder / 'agentwatch.duckdb').read_text()
                return subprocess.CompletedProcess(args, 0, stdout='')

            def run(args, **kwargs):
                args = tuple(args)
                commands.append(args)
                if args == VOLUME and volume_missing:
                    raise subprocess.CalledProcessError(1, args, stderr='PRIVATE_SENTINEL')
                if args[:2] == ('docker', 'run'):
                    return helper(args)
                if args[:2] == ('docker', 'pull') and interrupt_at == 'pull':
                    raise KeyboardInterrupt
                if args[:3] == ('docker', 'network', 'inspect'):
                    return subprocess.CompletedProcess(args, 0, stdout=gateway + '\n')
                if args[:2] == ('docker', 'pull') and pull_failure:
                    raise subprocess.CalledProcessError(1, args, stderr='PRIVATE_SENTINEL')
                if args[:2] == ('docker', 'inspect'):
                    if container['image'] is None:
                        raise subprocess.CalledProcessError(1, args, stderr='PRIVATE_SENTINEL')
                    if args == IMAGE_ID:
                        return subprocess.CompletedProcess(args, 0, stdout=container['image'] + '\n')
                    state = new_health if container['image'] == 'sha256:new' else old_health
                    if container['image'] == 'sha256:old' and volume['format'] != 'old':
                        state = 'unhealthy'  # the previous image refuses a newer database
                    return subprocess.CompletedProcess(args, 0, stdout=state + '\n')
                if args == GATEWAY and not (gateway_after if UP in commands else gateway_before):
                    raise subprocess.CalledProcessError(7, args)
                if args[0] == 'curl' and args[-1].endswith('/v1/traces') and ingest_failure:
                    raise subprocess.CalledProcessError(22, args)
                if args[0] == 'curl' and '--config' in args:
                    self.assertEqual(kwargs.get('input'), 'header = "authorization: Bearer ' + KEY + '"\n')
                elif args[0] == 'curl' and '--write-out' in args and '%{http_code}' in args:
                    return subprocess.CompletedProcess(args, 0, stdout='200' if open_without_key else '401')
                return subprocess.CompletedProcess(args, 0, stdout='')

            def compose(*args, **kwargs):
                commands.append(('compose', *args))
                if ('compose', *args) == STOP:
                    if stop_failure or (rollback_stop_failure and UP in commands):
                        raise subprocess.CalledProcessError(1, args, stderr='PRIVATE_SENTINEL')
                    container['running'] = False
                if ('compose', *args) == UP:
                    if interrupt_at == 'up' and commands.count(UP) == 1:
                        raise KeyboardInterrupt
                    current = (live / 'compose.yaml').read_text()
                    container['image'] = 'sha256:new' if current == staged_compose else 'sha256:old'
                    container['running'] = True
                    if container['image'] == 'sha256:new':
                        volume['format'] = 'new'
                return subprocess.CompletedProcess(args, 0, stdout='')

            output = io.StringIO()
            with patch.object(update, 'LIVE', live), \
                    patch.object(update, 'BACKUPS', backups), \
                    patch.object(update, 'LOCK', root / 'release.lock'), \
                    patch.object(sys, 'argv', ['deploy-agentwatch-update.py', str(archive_path), requested_sha]), \
                    patch.object(update, 'run', side_effect=run), \
                    patch.object(update, 'compose', side_effect=compose), \
                    patch.object(update.time, 'sleep'), \
                    contextlib.redirect_stdout(output):
                import signal
                handlers = [signal.getsignal(n) for n in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)]
                if expected_error:
                    with self.assertRaisesRegex(expected, expected_error) as caught:
                        update.main()
                    self.assertNotIn('PRIVATE_SENTINEL', str(caught.exception))
                else:
                    update.main()
                # Whatever happened, the process's signal handling is as it was.
                self.assertEqual([signal.getsignal(n) for n in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)],
                                 handlers)
                self.assertEqual(sorted(path.name for path in live.iterdir() if path.name.startswith('.compose')), [])

            # Never the gateway (beyond its read-only health), RELEASE, source or .env; the
            # volume only through the copy container, which `helper` checked.
            for command in commands:
                self.assertTrue(command in (UP, STOP, GATEWAY, VOLUME) or command[0] == 'curl' and ':4318/' in command[-1]
                                or command[:2] in (('docker', 'pull'), ('docker', 'inspect'))
                                or command[:len(HELPER)] == HELPER
                                or command[:3] == ('docker', 'network', 'inspect'), command)
                if command != GATEWAY:
                    self.assertFalse(any('gateway' in part or ':3000' in part for part in command), command)
            self.assertEqual((live / 'RELEASE').read_text(), 'e' * 40 + '\n')
            self.assertEqual((live / 'src/main.ts').read_text(), original['src/main.ts'])
            self.assertEqual((live / '.env').read_text(), env)
            for secret in ('PRIVATE_SENTINEL', 'secret-sentinel'):
                self.assertNotIn(secret, output.getvalue())
                self.assertFalse(any(secret in ' '.join(c) for c in commands), secret)
            self.kept = sorted(path.name for path in backups.iterdir()) if backups.exists() else []
            self.assertFalse(any(name.endswith(update.PARTIAL) for name in self.kept
                                 if name not in earlier_backups), self.kept)
            self.volume = volume['format']
            if not expected_error:
                image = re.search(r'    image: (\S+)\n', staged_compose).group(1)
                result = json.loads(output.getvalue())
                made = pathlib.Path(result.pop('backup'))
                self.assertEqual(result, {'agentwatch': image, 'healthy': True})
                # The data as it was, in a directory only root can read, named by time and commit.
                self.assertEqual((made.parent, made.name[-13:]), (backups, '-' + SHA[:12]))
                self.assertEqual((made / 'agentwatch.duckdb').read_text(), 'old')
                self.assertEqual(made.stat().st_mode & 0o777, 0o700)
                self.assertEqual(backups.stat().st_mode & 0o777, 0o700)
                self.assertEqual(volume['format'], 'new')
                self.assertIn(('docker', 'pull', image), commands)
                self.assertEqual((live / 'compose.yaml').read_text(), staged_compose)
                self.assertEqual(container['image'], 'sha256:new')
                post = next(i for i, c in enumerate(commands) if c[-1].endswith('/v1/traces'))
                read = next(i for i, c in enumerate(commands) if '/api/traces/' in c[-1])
                gateway_checks = [i for i, c in enumerate(commands) if c == GATEWAY]
                copied = next(i for i, c in enumerate(commands) if c[:2] == ('docker', 'run'))
                order = [commands.index(('docker', 'pull', image)), commands.index(IMAGE_ID), gateway_checks[0],
                         commands.index(STOP), copied,
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
            ({'staged_compose': block('    read_only: true\n    tmpfs', '    read_only: false\n    tmpfs')}, 'keep read_only'),
            ({'staged_compose': block('    cap_drop: [ALL]\n', '')}, 'keep cap_drop'),
            ({'staged_compose': block('    mem_limit: 512m\n', '')}, 'keep mem_limit'),
            ({'staged_compose': block('    restart:', '    privileged: true\n    restart:')}, 'outside the reviewed allow-list'),
            ({'staged_compose': block('    restart:', '    network_mode: host\n    restart:')}, 'outside the reviewed allow-list'),
            ({'staged_compose': block('    restart:', '    cap_add: [SYS_ADMIN]\n    restart:')}, 'outside the reviewed allow-list'),
            ({'staged_compose': LIVE_COMPOSE}, 'already up to date'),
            ({'staged_compose': block('    stop_grace_period: 15s\n', '    stop_grace_period: 15s\n' * 2)}, 'repeats a setting'),
            ({'staged_compose': block('    restart:', '    <<: *gateway\n    restart:')}, 'outside the reviewed allow-list'),
            ({'staged_compose': block('        "90",\n', '        "${POSTGRES_PASSWORD}",\n')}, 'outside the reviewed allow-list'),
        ]
        for args, message in cases:
            with self.subTest(args=args):
                commands = self.scenario(**args, expected_error=message)
                self.assertEqual(commands, [])

    def test_block_settings_outside_the_allow_list_change_nothing(self):
        volumes = '    volumes: ["agentwatch-data:/data"]\n'
        environment = '      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}\n'
        security = '    security_opt: ["no-new-privileges:true"]\n'
        cases = [
            (volumes, '    volumes: ["agentwatch-data:/data", "/var/run/docker.sock:/var/run/docker.sock"]\n', 'keep volumes'),
            (volumes, '    volumes: ["agentwatch-data:/data", "/:/host"]\n', 'keep volumes'),
            (volumes, '    volumes: ["agentwatch-data:/data", "postgres-data:/postgres"]\n', 'keep volumes'),
            (volumes, volumes + '    volumes:\n      - /:/host\n', 'keep volumes'),
            (volumes, '    volumes:\n      - agentwatch-data:/data\n      - /:/host\n', 'keep volumes'),
            (volumes, volumes + '    volumes_from: [postgres]\n', 'allow-list'),
            (volumes, volumes + '    env_file: [.env]\n', 'allow-list'),
            (environment, '      OPENROUTER_API_KEY: ${POSTGRES_PASSWORD}\n', 'reviewed variables'),
            (environment, '      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-${POSTGRES_PASSWORD}}\n', 'allow-list'),
            (environment, environment + '      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}\n', 'reviewed variables'),
            (environment, environment + '      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN:-}\n', 'reviewed variables'),
            (environment, '      OPENROUTER_API_KEY: sk-literal\n', 'allow-list'),
            (environment, '      - OPENROUTER_API_KEY=${POSTGRES_PASSWORD}\n', 'allow-list'),
            (environment, environment * 2, 'repeats a setting'),
            (volumes, volumes + '    user: root\n', 'allow-list'),
            (security, '    security_opt: ["no-new-privileges:true", "seccomp:unconfined"]\n', 'keep security_opt'),
            (security, security + '    security_opt: ["apparmor:unconfined"]\n', 'keep security_opt'),
            (security, '', 'keep security_opt'),
            (volumes, volumes + '    networks: [default, browser-control]\n', 'allow-list'),
            (volumes, volumes + '    networks:\n      - browser-control\n', 'allow-list'),
            ('    tmpfs: [/tmp]\n', '    tmpfs: [/tmp, /data]\n', 'keep tmpfs'),
        ]
        for old, new, message in cases:
            with self.subTest(new=new):
                self.assertIn(old, STAGED_COMPOSE)
                self.assertEqual(self.scenario(staged_compose=STAGED_COMPOSE.replace(old, new),
                                               expected_error=message), [])

    def test_comment_lines_do_not_end_the_agentwatch_block(self):
        staged = STAGED_COMPOSE.replace('    restart:', '  # A service-level comment inside the block.\n'
                                        '# A top-level comment inside the block.\n    restart:')
        before, block, after = update.split_compose(staged.encode(), 'Staged')
        self.assertIn(b'    restart: unless-stopped\n', block)
        self.assertTrue(after.startswith(b'networks:\n'))
        self.scenario(staged_compose=staged)
        unreviewed = staged.replace('    restart:', '    user: root\n    restart:')
        self.scenario(staged_compose=unreviewed, expected_error='allow-list')

    def test_signing_in_sends_the_key_on_stdin_and_checks_it_is_required(self):
        commands = self.scenario(staged_compose=SIGNED_COMPOSE, env=SIGNED_ENV)
        keyed = [c for c in commands if c[0] == 'curl' and '--config' in c]
        bare = [c for c in commands if c[0] == 'curl' and '%{http_code}' in c]
        self.assertEqual(len(keyed), 2)
        self.assertEqual(len(bare), 2)
        self.assertLess(commands.index(keyed[-1]), commands.index(bare[0]))

    def test_signing_in_needs_the_private_values_first(self):
        for env in ['PRIVATE_SENTINEL=x\n',
                    'AGENTWATCH_API_KEY=' + KEY + '\n',
                    'AGENTWATCH_PASSWORD_HASH=scrypt:1:2:3:abc:def\n',
                    SIGNED_ENV.replace(KEY, 'secret-sentinel-short'),
                    SIGNED_ENV.replace('scrypt:', 'bcrypt:'),
                    SIGNED_ENV + 'AGENTWATCH_API_KEY=\n']:
            with self.subTest(env=env):
                commands = self.scenario(staged_compose=SIGNED_COMPOSE, env=env,
                                         expected_error='private .env first')
                self.assertFalse(any(c[:2] == ('docker', 'pull') for c in commands))

    def test_a_comment_cannot_stand_in_for_the_trusted_proxy(self):
        spoofed = SIGNED_COMPOSE.replace(
            '    command:\n',
            '    # Was "--forwarded-allow-ips" "172.18.0.1".\n    command:\n').replace(
            '"172.18.0.1"', '"0.0.0.0/0"').replace(
            '# Was "--forwarded-allow-ips" "0.0.0.0/0".', '# Was "--forwarded-allow-ips" "172.18.0.1".')
        self.assertIn('"0.0.0.0/0"', spoofed)
        self.scenario(staged_compose=spoofed, env=SIGNED_ENV, expected_error='must be the Compose network gateway')

    def test_private_host_names_need_no_signing_in(self):
        _, block, _ = update.split_compose(STAGED_COMPOSE.replace(
            '"90",\n', '"90",\n        "--allow-host",\n        "agentwatch",\n').encode(), 'Staged')
        self.assertEqual(update.validate_block(block), NEW_IMAGE)

    def test_the_trusted_proxy_must_be_the_network_gateway(self):
        for gateway in ('172.19.0.1 ', '172.18.0.1 172.20.0.1 ', ''):
            with self.subTest(gateway=gateway):
                commands = self.scenario(staged_compose=SIGNED_COMPOSE, env=SIGNED_ENV, gateway=gateway,
                                         expected_error='must be the Compose network gateway')
                self.assertFalse(any(c[:2] == ('docker', 'pull') for c in commands))

    def test_an_agentwatch_that_answers_without_its_key_is_rolled_back(self):
        self.scenario(staged_compose=SIGNED_COMPOSE, env=SIGNED_ENV, open_without_key=True,
                      expected_error='previous agentwatch restored')

    def test_signing_in_settings_go_together(self):
        def refused(compose, reason):
            _, block, _ = update.split_compose(compose.encode(), 'Staged')
            with self.assertRaisesRegex(RuntimeError, reason):
                update.validate_block(block)
        _, block, _ = update.split_compose(SIGNED_COMPOSE.encode(), 'Staged')
        self.assertEqual(update.validate_block(block), NEW_IMAGE)
        hash_line = '      AGENTWATCH_PASSWORD_HASH: ${AGENTWATCH_PASSWORD_HASH:-}\n'
        key_line = '      AGENTWATCH_API_KEY: ${AGENTWATCH_API_KEY:-}\n'
        user = '        "--auth-user",\n        "owner",\n'
        keys = '        "--api-key-env",\n        "AGENTWATCH_API_KEY",\n'
        proxies = '        "--forwarded-allow-ips",\n        "172.18.0.1",\n'
        for compose, reason in (
            (SIGNED_COMPOSE.replace(user, ''), 'go together'),
            (SIGNED_COMPOSE.replace(hash_line, ''), 'go together'),
            (SIGNED_COMPOSE.replace(keys, ''), 'needs --api-key-env'),
            (SIGNED_COMPOSE.replace('"--api-key-env",\n        "AGENTWATCH_API_KEY"',
                                    '"--api-key-env",\n        "OPENROUTER_API_KEY"'), 'needs --api-key-env'),
            (SIGNED_COMPOSE.replace(key_line, ''), 'only when signing in'),
            (SIGNED_COMPOSE.replace(proxies, ''), 'needs --forwarded-allow-ips'),
            (SIGNED_COMPOSE.replace('"172.18.0.1"', '"*"'), 'must not allow any host'),
            (SIGNED_COMPOSE.replace('"172.18.0.1"', '"proxy.example"'), 'addresses or networks'),
            (SIGNED_COMPOSE.replace('"owner"', '"own er"'), 'must be 1 to 64'),
            # Without signing in, neither the key nor the flag.
            (STAGED_COMPOSE.replace('${OPENROUTER_API_KEY:-}\n', '${OPENROUTER_API_KEY:-}\n' + key_line),
             'only when signing in'),
            (STAGED_COMPOSE.replace('"50",\n', '"50",\n' + keys), 'only with --auth-user'),
            (SIGNED_COMPOSE.replace('"--auth-user"', '"--host",\n        "traces.52-77-47-24.sslip.io",\n        "--auth-user"'),
             '--host must be'),
            # A public name needs signing in, so a later update cannot switch it off under the site.
            (STAGED_COMPOSE.replace('"90",\n', '"90",\n        "--allow-host",\n        "traces.52-77-47-24.sslip.io",\n'),
             'public host name only with signing in'),
            # The hash may not come from another variable.
            (SIGNED_COMPOSE.replace(hash_line, '      AGENTWATCH_PASSWORD_HASH: ${OTHER_HASH:-}\n'),
             'only pass through reviewed variables'),
        ):
            with self.subTest(reason=reason, compose=compose[-400:]):
                refused(compose, reason)

    def test_validation_accepts_env_only_and_limit_changes(self):
        self.scenario(staged_compose=LIVE_COMPOSE.replace('    mem_limit: 512m', '    mem_limit: 1g'))

    def test_command_must_keep_the_host_guard_and_the_judge_policy(self):
        def refused(compose, reason):
            before, block, _ = update.split_compose(compose.encode(), 'Staged')
            with self.assertRaisesRegex(RuntimeError, reason):
                update.validate_block(block)
        refused(STAGED_COMPOSE.replace('"90",\n', '"90",\n        "--allow-host",\n        "*",\n'),
                'must not allow any host')
        refused(LIVE_COMPOSE.replace('"90",\n', '"90",\n        "--allow-host",\n        "*",\n'),
                'must not allow any host')
        refused(STAGED_COMPOSE.replace(JUDGE_POLICY, ''), 'pin --judge-endpoint')
        refused(STAGED_COMPOSE.replace('https://openrouter.ai/api/v1', 'https://evil.example/v1'),
                'pin --judge-endpoint')
        refused(STAGED_COMPOSE.replace('"90",\n', '"90",\n        "--judge-endpoint",\n        "https://evil.example/v1",\n'),
                'repeats an argument')
        refused(STAGED_COMPOSE.replace('        "--judge-key-env",\n        "OPENROUTER_API_KEY",\n', ''),
                'pin --judge-key-env')
        refused(STAGED_COMPOSE.replace('"50"', '"51"'), 'cap --judge-max-daily')
        refused(STAGED_COMPOSE.replace('        "--judge-max-daily",\n        "50",\n', ''),
                'cap --judge-max-daily')
        # The server's parser also takes --flag=value and abbreviations; none get through.
        for extra, reason in (
            ('--allow-host=*', 'flag and value pairs'),
            ('--allow=*', 'flag and value pairs'),
        ):
            refused(STAGED_COMPOSE.replace('"90",\n', '"90",\n        "' + extra + '",\n'), reason)
        for flag, value in (
            ('--judge-endpoint=https://evil.example/v1', 'x'),
            ('--judge-end', 'https://evil.example/v1'),
            ('--judge-e=https://evil.example/v1', 'x'),
            ('--judge-key-env=OTHER_API_KEY', 'x'),
            ('--judge-k', 'OTHER_API_KEY'),
            ('--judge-max-daily=10000', 'x'),
            ('--judge-max', '10000'),
            ('--db', '/tmp/x'),
            ('--retain-days', '--demo'),
        ):
            refused(STAGED_COMPOSE.replace('"90",\n', '"90",\n        "' + flag + '",\n        "' + value + '",\n'),
                    'outside the reviewed allow-list')
        refused(STAGED_COMPOSE.replace('"serve"', '"demo"'), 'flag and value pairs')
        refused(STAGED_COMPOSE.replace('"50"', '"50",\n        "--judge-max-daily",\n        "9"'), 'repeats an argument')
        refused(STAGED_COMPOSE.replace('"90",\n', '"90",\n        "--allow-host",\n        "*.example",\n'),
                'must not allow any host')
        # Without the key, no judge can call anything, so no policy is needed.
        _, block, _ = update.split_compose(LIVE_COMPOSE.encode(), 'Staged')
        self.assertEqual(update.validate_block(block), OLD_IMAGE)
        # The one-line form is read too.
        one_line = STAGED_COMPOSE.replace(
            '    command:\n      [\n        "serve",\n        "--retain-days",\n        "90",\n' + JUDGE_POLICY + '      ]\n',
            '    command: ["serve", "--allow-host", "*"]\n')
        refused(one_line, 'must not allow any host')

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
                # The data is put back before the previous image starts: it could not open
                # what the new image wrote (the harness reports it unhealthy if it had to).
                self.assertEqual(self.volume, 'old')
                copies = [i for i, c in enumerate(commands) if c[:2] == ('docker', 'run')]
                ups = [i for i, c in enumerate(commands) if c == UP]
                stops = [i for i, c in enumerate(commands) if c == STOP]
                self.assertEqual(len(copies), 2)
                self.assertLess(ups[0], stops[1])
                self.assertLess(stops[1], copies[1])
                self.assertLess(copies[1], ups[1])
                self.assertEqual(len(self.kept), 1)  # kept for inspection after a failure

    def test_unhealthy_rollback_requires_operator_inspection(self):
        commands = self.scenario(
            new_health='unhealthy', old_health='unhealthy',
            expected_error='Rollback needs operator inspection: it failed while checking the previous agentwatch; '
                           'the previous agentwatch was started but is not healthy; gateway untouched; '
                           'compose.yaml is the previous one; the data as it was before the update is in .*-'
                           + SHA[:12] + r' \(put it back with --restore')
        self.assertEqual(commands.count(UP), 2)

    def test_a_failed_stop_or_copy_starts_nothing_new(self):
        # Nothing was changed yet: the previous agentwatch is started again on its own data,
        # and a copy that did not finish is not left looking like one that did.
        for args in [{'stop_failure': True}, {'backup_failure': True}, {'volume_missing': True}]:
            with self.subTest(args=args):
                commands = self.scenario(**args, expected_error='agentwatch update failed; previous agentwatch restored')
                self.assertEqual(commands.count(UP), 1)
                self.assertEqual(self.volume, 'old')
                self.assertEqual(self.kept, [])
                self.assertEqual(sum(c[:2] == ('docker', 'run') for c in commands), 1 if 'backup_failure' in args else 0)

    def test_a_restore_that_fails_leaves_agentwatch_for_the_operator(self):
        commands = self.scenario(
            new_health='unhealthy', restore_failure=True,
            expected_error='failed while putting its data back; agentwatch is stopped and its volume may be part '
                           'emptied; .*the data as it was before the update is in ')
        # Not started on files it cannot open.
        self.assertEqual(commands.count(UP), 1)
        self.assertEqual(self.volume, 'new')
        self.assertEqual(len(self.kept), 1)

    def test_a_new_agentwatch_that_will_not_stop_is_said_to_be_running(self):
        commands = self.scenario(
            new_health='unhealthy', rollback_stop_failure=True,
            expected_error='failed while stopping the new agentwatch; agentwatch may be stopped or running the new image')
        self.assertEqual(commands.count(UP), 1)
        self.assertEqual(sum(c[:2] == ('docker', 'run') for c in commands), 1)  # nothing put back under it

    def test_an_interrupt_after_the_stop_rolls_back_and_one_before_changes_nothing(self):
        commands = self.scenario(interrupt_at='up', expected_error='agentwatch update failed; previous agentwatch restored')
        self.assertEqual(commands.count(UP), 2)
        self.assertEqual(self.volume, 'old')
        commands = self.scenario(interrupt_at='pull', expected=KeyboardInterrupt, expected_error='^$')
        self.assertNotIn(STOP, commands)
        self.assertNotIn(UP, commands)

    def test_a_stop_request_is_an_interrupt(self):
        import signal
        with self.assertRaises(KeyboardInterrupt):
            update._interrupt(signal.SIGTERM, None)

    def test_restore_by_hand_puts_a_finished_copy_back(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            live, backups = root / 'live', root / 'backups'
            live.mkdir()
            (live / 'compose.yaml').write_text(LIVE_COMPOSE)
            good = backups / ('20261113T010203Z-' + SHA[:12])
            good.mkdir(parents=True)
            (good / 'agentwatch.duckdb').write_text('old')
            empty = backups / ('20261113T010204Z-' + SHA[:12])
            empty.mkdir()
            (backups / (good.name + update.PARTIAL)).mkdir()
            commands = []
            health = {'state': 'healthy'}

            def run(args, **kwargs):
                commands.append(tuple(args))
                return subprocess.CompletedProcess(args, 0, stdout=health['state'] + '\n')

            def compose(*args, **kwargs):
                commands.append(('compose', *args))
                return subprocess.CompletedProcess(args, 0, stdout='')

            def restore_from(path, error=None):
                commands.clear()
                output = io.StringIO()
                with patch.object(update, 'LIVE', live), patch.object(update, 'BACKUPS', backups), \
                        patch.object(update, 'LOCK', root / 'release.lock'), \
                        patch.object(sys, 'argv', ['deploy-agentwatch-update.py', '--restore', str(path)]), \
                        patch.object(update, 'run', side_effect=run), \
                        patch.object(update, 'compose', side_effect=compose), \
                        patch.object(update.time, 'sleep'), contextlib.redirect_stdout(output):
                    if error:
                        with self.assertRaisesRegex(RuntimeError, error):
                            update.main()
                    else:
                        update.main()
                return output.getvalue()

            printed = json.loads(restore_from(good))
            self.assertEqual(printed, {'agentwatch': OLD_IMAGE, 'healthy': True, 'restored': str(good)})
            copy = next(c for c in commands if c[:2] == ('docker', 'run'))
            # From the image the live compose.yaml names, into the volume, the copy read-only.
            self.assertEqual(copy[:len(HELPER)], HELPER)
            self.assertEqual(copy[-4:], (OLD_IMAGE, '-I', '-c', update.COPY_BACK))
            self.assertIn(update.DATA_VOLUME + ':/data', copy)
            self.assertIn(str(good) + ':/backup:ro', copy)
            order = [commands.index(STOP), commands.index(VOLUME), commands.index(copy), commands.index(UP)]
            self.assertEqual(order, sorted(order))
            # Only a finished copy made by this procedure, named as it names them.
            for bad in (empty, backups / (good.name + update.PARTIAL), backups / 'manual', root / good.name,
                        backups / good.name / '..' / good.name):
                self.assertEqual(restore_from(bad, 'Not a finished copy made by this procedure; nothing changed'), '')
                self.assertEqual(commands, [])
            health['state'] = 'unhealthy'
            restore_from(good, 'Restore failed while starting agentwatch; agentwatch may be stopped; the copy in .* is unchanged')

    def test_the_copy_scripts_copy_everything_and_restore_exactly(self):
        """The scripts that run inside the copy container, run here on two directories."""
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            data, backup = root / 'data', root / 'backup'
            data.mkdir()
            backup.mkdir()

            def inside(script):
                source = script.replace('"/data', '"' + str(data)).replace('"/backup', '"' + str(backup))
                self.assertNotIn('"/data', source)
                return subprocess.run([sys.executable, '-I', '-c', source], capture_output=True, text=True)

            def tree(folder):
                return sorted(str(path.relative_to(folder)) + ('@' if path.is_symlink() else '/' if path.is_dir() else '')
                              for path in folder.rglob('*'))

            # Nothing to copy is not a copy.
            self.assertIn('no database to copy', inside(update.COPY_OUT).stderr)
            (data / 'agentwatch.duckdb').write_bytes(b'old database')
            (data / 'agentwatch.duckdb').chmod(0o640)
            (data / 'agentwatch.duckdb.wal').write_bytes(b'old log')
            # A directory, a file in it and a link are part of the data, as they are.
            (data / '.cache' / 'deep').mkdir(parents=True)
            (data / '.cache' / 'deep' / 'file').write_bytes(b'kept')
            (data / '.cache').chmod(0o750)
            (data / 'current').symlink_to('agentwatch.duckdb')
            (data / 'dangling').symlink_to('nowhere')
            # Scratch directories a killed agentwatch leaves behind are not.
            (data / 'agentwatch.duckdb.tmp').mkdir()
            (data / 'agentwatch.duckdb.tmp' / 'spill').write_bytes(b'x')
            (data / 'agentwatch-ab12').mkdir()
            done = inside(update.COPY_OUT)
            self.assertEqual(done.returncode, 0, done.stderr)
            kept = ['.cache/', '.cache/deep/', '.cache/deep/file', 'agentwatch.duckdb', 'agentwatch.duckdb.wal',
                    'current@', 'dangling@']
            self.assertEqual(tree(backup), kept)
            self.assertEqual((backup / 'agentwatch.duckdb').read_bytes(), b'old database')
            self.assertEqual((backup / 'agentwatch.duckdb').stat().st_mode & 0o777, 0o640)
            self.assertEqual((backup / '.cache').stat().st_mode & 0o777, 0o750)
            self.assertEqual(os.readlink(backup / 'dangling'), 'nowhere')

            # The new image rewrote the file, left a different log, its own scratch directory
            # and changed the rest.
            (data / 'agentwatch.duckdb').write_bytes(b'new format')
            (data / 'agentwatch.duckdb.wal').write_bytes(b'log for the new format')
            (data / 'agentwatch-cd34').mkdir()
            (data / 'agentwatch-cd34' / 'part').write_bytes(b'y')
            (data / '.cache' / 'deep' / 'file').write_bytes(b'changed')
            (data / 'extra').write_bytes(b'new file')
            done = inside(update.COPY_BACK)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(tree(data), kept)
            self.assertEqual((data / 'agentwatch.duckdb').read_bytes(), b'old database')
            self.assertEqual((data / 'agentwatch.duckdb.wal').read_bytes(), b'old log')
            self.assertEqual((data / '.cache' / 'deep' / 'file').read_bytes(), b'kept')
            self.assertEqual((data / 'agentwatch.duckdb').stat().st_mode & 0o777, 0o640)
            self.assertEqual((data / '.cache').stat().st_mode & 0o777, 0o750)

            # Anything that is neither a file, a directory nor a link stops the copy, naming it.
            shutil.rmtree(backup)
            backup.mkdir()
            os.mkfifo(data / 'pipe')
            done = inside(update.COPY_OUT)
            self.assertNotEqual(done.returncode, 0)
            self.assertIn('neither a file, a directory nor a link: ' + str(data / 'pipe'), done.stderr)
            (data / 'pipe').unlink()

            # A copy without a database empties nothing.
            shutil.rmtree(backup)
            backup.mkdir()
            done = inside(update.COPY_BACK)
            self.assertIn('the copy holds no database', done.stderr)
            self.assertEqual(tree(data), kept)

    def test_the_copy_scripts_keep_each_entrys_owner(self):
        """Ownership cannot change without root, so the call is checked here, and its effect
        in the rehearsal on a Docker host (journal 184)."""
        for script in (update.COPY_OUT, update.COPY_BACK):
            self.assertIn('    os.chown(target, found.st_uid, found.st_gid, follow_symlinks=False)\n', script)
            self.assertIn('    found = os.lstat(source)\n', script)

    def test_only_the_newest_copies_are_kept(self):
        earlier = ('20260101T000000Z-aaaaaaaaaaaa', '20260201T000000Z-bbbbbbbbbbbb',
                   '20260301T000000Z-cccccccccccc')
        # Not copies of this procedure's making: never counted and never removed.
        others = ('manual-before-migration', '20260101T000000Z-aaaaaaaaaaaa' + update.PARTIAL)
        self.scenario(earlier_backups=earlier + others)
        finished = [name for name in self.kept if name not in others]
        self.assertEqual(len(finished), update.KEPT_BACKUPS)
        self.assertEqual(finished[:2], list(earlier[1:]))
        self.assertTrue(finished[2].endswith('-' + SHA[:12]))
        self.assertTrue(set(others) <= set(self.kept))
        # A failed update removes nothing.
        self.scenario(earlier_backups=earlier, new_health='unhealthy',
                      expected_error='previous agentwatch restored')
        self.assertEqual(len(self.kept), 4)

    def test_a_public_url_is_the_https_address_of_a_public_name_with_signing_in(self):
        signed = SIGNED_COMPOSE.replace(SIGN_IN, SIGN_IN + PUBLIC)
        self.scenario(staged_compose=signed, env=SIGNED_ENV)
        refused = 'agentwatch --public-url must be https://'
        for changed in (
                signed.replace('"https://traces.example.com"', '"http://traces.example.com"'),
                signed.replace('"https://traces.example.com"', '"https://traces.example.com/"'),
                signed.replace('"https://traces.example.com"', '"https://traces.example.com:8443"'),
                signed.replace('"https://traces.example.com"', '"https://owner@traces.example.com"'),
                signed.replace('"https://traces.example.com"', '"https://elsewhere.example.com"'),
                signed.replace('"https://traces.example.com"', '"https://agentwatch"')
                      .replace('"traces.example.com"', '"agentwatch"'),
                signed.replace('"https://traces.example.com"', '"https://TRACES.example.com"')):
            with self.subTest(changed=changed[-420:-300]):
                self.scenario(staged_compose=changed, env=SIGNED_ENV, expected_error=refused)
        # Without signing in there is no public name to link to.
        unsigned = STAGED_COMPOSE.replace('        "50",\n', '        "50",\n' + PUBLIC)
        with self.assertRaises(AssertionError):
            # (refused earlier, for the public --allow-host itself)
            self.scenario(staged_compose=unsigned, expected_error=refused)
        self.scenario(staged_compose=unsigned, expected_error='public host name only with signing in on')


if __name__ == '__main__':
    unittest.main()
