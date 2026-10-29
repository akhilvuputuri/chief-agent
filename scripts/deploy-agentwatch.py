#!/usr/bin/env python3
"""Reviewed one-time operator rollout for the agentwatch trace viewer (issue #323, journal 134).

Starts the digest-pinned agentwatch service next to the gateway and recreates the gateway
with trace export on, message content included. No database migration: db/ must be
byte-identical to the live release. A failure after Compose changes removes the agentwatch
container (keeping its volume) and restores the previous gateway."""
import fcntl
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

LIVE = pathlib.Path('/opt/hermes-companion')
LOCK = pathlib.Path('/var/lock/companion-release.lock')
# Baseline: the release of e6abb13 (PR 359, opt-in message content), live when this merges.
# Reconcile with the live RELEASE immediately before rollout; never rewrite RELEASE to match.
BASE = 'e6abb1344f0c9a3d2d29c878a69f55ff2e0f5f8b'
BASES = {BASE}
IMAGE = 'hermes-companion-gateway'
AGENTWATCH_DIGEST = 'a74e529eb00bc289fc24071029d834c00d4a01b05c887ee08fd319bd3e3bf69f'
AGENTWATCH_IMAGE = 'ghcr.io/akhilvuputuri/agentwatch@sha256:' + AGENTWATCH_DIGEST
AGENTWATCH_CONTAINER = 'hermes-companion-agentwatch-1'
GATEWAY_REACHES_AGENTWATCH = (
    "fetch('http://agentwatch:4318/healthz')"
    ".then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))")
# Each anchor occurs exactly once in the live compose.yaml; the staged compose.yaml must be
# the live one with exactly these replacements applied, in order.
_ENV_ANCHOR = b'      VOICE_REPLIES: ${VOICE_REPLIES:-false}\n'
_NETWORKS_ANCHOR = b'networks:\n  browser-control: { internal: true }\n'
_VOLUMES_ANCHOR = b'volumes:\n  postgres-data:\n'
COMPOSE_EDITS = [
    (_ENV_ANCHOR, _ENV_ANCHOR
     + b'      # Trace export to the agentwatch service below (docs/tracing.md). In .env, an empty\n'
       b'      # CHIEF_TRACE_ENDPOINT turns export off and CHIEF_TRACE_CONTENT=false keeps message\n'
       b'      # content out; either takes effect when the gateway is recreated.\n'
       b'      OTEL_EXPORTER_OTLP_ENDPOINT: ${CHIEF_TRACE_ENDPOINT-http://agentwatch:4318}\n'
       b'      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: ${CHIEF_TRACE_CONTENT:-true}\n'),
    (_NETWORKS_ANCHOR,
     b'  agentwatch:\n'
     b'    # Trace viewer for issue #323 (github.com/akhilvuputuri/agentwatch), pinned by digest.\n'
     b'    # The gateway reaches it as agentwatch:4318; the host publishes it on loopback only, for\n'
     b'    # an SSH tunnel (docs/lightsail.md). The gateway does not depend on it.\n'
     b'    image: ' + AGENTWATCH_IMAGE.encode() + b'\n'
     b'    command:\n'
     b'      [\n'
     b'        "serve",\n'
     b'        "--host",\n'
     b'        "0.0.0.0",\n'
     b'        "--allow-host",\n'
     b'        "agentwatch",\n'
     b'        "--retain-days",\n'
     b'        "90",\n'
     b'        "--memory-limit",\n'
     b'        "256MB",\n'
     b'      ]\n'
     b'    volumes: ["agentwatch-data:/data"]\n'
     b'    ports: ["127.0.0.1:4318:4318"]\n'
     b'    read_only: true\n'
     b'    tmpfs: [/tmp]\n'
     b'    cap_drop: [ALL]\n'
     b'    security_opt: ["no-new-privileges:true"]\n'
     b'    mem_limit: 512m\n'
     b'    stop_grace_period: 15s\n'
     b'    restart: unless-stopped\n'
     + _NETWORKS_ANCHOR),
    (_VOLUMES_ANCHOR, _VOLUMES_ANCHOR + b'  agentwatch-data:\n'),
]
MAX_ARCHIVE_BYTES = 100 * 1024 * 1024


def run(args, **kwargs):
    # Never echo expanded Compose environment or raw subprocess diagnostics.
    kwargs.setdefault('capture_output', True)
    return subprocess.run(args, check=True, **kwargs)


def compose(*args, **kwargs):
    return run(['docker', 'compose', '--project-directory', str(LIVE),
                '-p', 'hermes-companion', *args], **kwargs)


def sql(statement):
    return run(['docker', 'exec', '-i', 'hermes-companion-postgres-1',
                'psql', '-X', '-U', 'companion', '-d', 'companion',
                '-v', 'ON_ERROR_STOP=1', '-tA'],
               input=statement, text=True).stdout.strip()


def healthy():
    for _ in range(30):
        result = subprocess.run(
            ['curl', '--fail', '--silent', '--max-time', '3',
             'http://127.0.0.1:3000/healthz'], capture_output=True)
        if result.returncode == 0:
            time.sleep(3)
            state = compose('ps', '--format', 'json', 'gateway', text=True).stdout
            if 'healthy' in state and 'unhealthy' not in state:
                return True
        time.sleep(2)
    return False


def agentwatch_healthy():
    # The image's HEALTHCHECK first runs about 30 s after start; allow roughly 90 s.
    for _ in range(45):
        try:
            state = run(['docker', 'inspect', '--format', '{{.State.Health.Status}}',
                         AGENTWATCH_CONTAINER], text=True).stdout.strip()
            if state == 'healthy':
                run(['curl', '--fail', '--silent', '--max-time', '3',
                     'http://127.0.0.1:4318/healthz'])
                return True
        except subprocess.CalledProcessError:
            pass
        time.sleep(2)
    return False


def remove_agentwatch():
    # The agentwatch-data volume is deliberately kept.
    try:
        run(['docker', 'rm', '-f', AGENTWATCH_CONTAINER])
    except subprocess.CalledProcessError:
        pass
    if run(['docker', 'ps', '-aq', '--filter', 'name=^' + AGENTWATCH_CONTAINER + '$'],
           text=True).stdout.strip():
        raise RuntimeError('agentwatch container still present')


def unpack(archive_path, sha, stage):
    path = pathlib.Path(archive_path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise RuntimeError('Expected a bounded regular git archive')
    with tarfile.open(path) as archive:
        if archive.pax_headers.get('comment') != sha:
            raise RuntimeError('Archive commit does not match requested SHA')
        members = archive.getmembers()
        if len(members) > 10000 or sum(m.size for m in members) > MAX_ARCHIVE_BYTES:
            raise RuntimeError('Expanded archive exceeds the supported size')
        seen = set()
        for member in members:
            relative = pathlib.PurePosixPath(member.name)
            if (not relative.parts or relative.is_absolute() or '..' in relative.parts
                    or not (member.isfile() or member.isdir())
                    or relative.parts[0] in {'RELEASE', '.git', '.RELEASE-agentwatch'}
                    or any(p.startswith('.env') and p != '.env.example' for p in relative.parts)
                    or relative in seen):
                raise RuntimeError('Unsafe archive entry')
            seen.add(relative)
        archive.extractall(stage, members=members, filter='data')


def apply_compose_edits(baseline_compose):
    if b'agentwatch' in baseline_compose or any(
            baseline_compose.count(anchor) != 1 for anchor, _ in COMPOSE_EDITS):
        raise RuntimeError('Compose baseline does not match the reviewed agentwatch edits')
    expected = baseline_compose
    for anchor, replacement in COMPOSE_EDITS:
        expected = expected.replace(anchor, replacement)
    return expected


def validate_changes(stage):
    for name in ['Dockerfile', 'package.json', 'package-lock.json', 'compose.yaml',
                 'src/main.ts', 'scripts/cloud-release.py']:
        if not (stage / name).is_file():
            raise RuntimeError('Incomplete source archive')

    def files(directory):
        if not directory.is_dir() or directory.is_symlink():
            raise RuntimeError('Migration directory unavailable')
        result = {}
        for path in directory.rglob('*'):
            if path.is_symlink() or not (path.is_file() or path.is_dir()):
                raise RuntimeError('Unsafe migration file')
            if path.is_file():
                result[str(path.relative_to(directory))] = path.read_bytes()
        return result

    if files(LIVE / 'db') != files(stage / 'db'):
        raise RuntimeError('Migration set changed; this rollout permits no db/ change')
    expected = apply_compose_edits((LIVE / 'compose.yaml').read_bytes())
    if (stage / 'compose.yaml').read_bytes() != expected:
        raise RuntimeError('Unexpected Compose change; only the reviewed agentwatch edits are permitted')
    if (stage / 'scripts/cloud-release.py').read_bytes() != (LIVE / 'scripts/cloud-release.py').read_bytes():
        raise RuntimeError('Trusted release-handler source changed; requires separate review')


def copy_entry(source, destination):
    if destination.is_symlink():
        raise RuntimeError('Source destination must not be a symlink')
    if destination.exists():
        if destination.is_dir():
            shutil.rmtree(destination)
        else:
            destination.unlink()
    if source is not None:
        if source.is_dir():
            shutil.copytree(source, destination)
        else:
            shutil.copy2(source, destination)


def backup_source(stage, backup):
    original = {}
    for item in stage.iterdir():
        destination = LIVE / item.name
        if destination.is_symlink():
            raise RuntimeError('Source destination must not be a symlink')
        original[item.name] = destination.exists()
        if original[item.name]:
            copy_entry(destination, backup / item.name)
    return original


def publish_source(stage):
    for item in stage.iterdir():
        copy_entry(item, LIVE / item.name)


def restore_source(backup, original):
    for name, existed in original.items():
        copy_entry(backup / name if existed else None, LIVE / name)


def write_release(content):
    pending = LIVE / '.RELEASE-agentwatch'
    try:
        pending.write_bytes(content)
        pending.replace(LIVE / 'RELEASE')
    finally:
        pending.unlink(missing_ok=True)


class Busy(Exception):
    """Work started after the idle check; the gateway must not be recreated now."""


def busy():
    return (sql("SELECT count(*) FROM runtime_runs WHERE state='running'") != '0'
            or sql("SELECT count(*) FROM conversation_inputs WHERE state IN ('queued','running')") != '0')


def main():
    if len(sys.argv) != 3 or not re.fullmatch('[0-9a-f]{40}', sys.argv[2]):
        raise RuntimeError('Usage: deploy-agentwatch.py <git-archive.tar> <exact reviewed main SHA>')
    if not re.fullmatch('[0-9a-f]{64}', AGENTWATCH_DIGEST):
        raise RuntimeError('agentwatch image digest is not pinned; live application unchanged')
    archive_path, sha = sys.argv[1:]
    with open(LOCK, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        old_release = (LIVE / 'RELEASE').read_bytes()
        if old_release.decode().strip() not in BASES:
            raise RuntimeError('agentwatch rollout requires the exact documented baseline; reconcile newer releases first')
        with tempfile.TemporaryDirectory(prefix='companion-agentwatch-') as temporary:
            stage, backup = pathlib.Path(temporary) / 'stage', pathlib.Path(temporary) / 'backup'
            stage.mkdir()
            backup.mkdir()
            unpack(archive_path, sha, stage)
            validate_changes(stage)
            original = backup_source(stage, backup)
            candidate = IMAGE + ':' + sha
            try:
                run(['docker', 'build', '--build-arg', 'RELEASE_SHA=' + sha, '-t', candidate, str(stage)])
            except Exception:
                raise RuntimeError('Candidate build failed; live application unchanged') from None
            try:
                run(['docker', 'pull', AGENTWATCH_IMAGE])
            except Exception:
                raise RuntimeError('agentwatch image pull failed; live application unchanged') from None
            if not healthy():
                raise RuntimeError('Baseline application is not healthy; inspect before rollout')
            if sql("SELECT count(*) FROM runtime_runs WHERE state='running'") != '0':
                raise RuntimeError('Active work; retry when idle without cancelling it')
            if sql("SELECT count(*) FROM conversation_inputs WHERE state IN ('queued','running')") != '0':
                raise RuntimeError('Pending conversation input; retry after scheduled work and execution finish')
            previous = compose('images', '-q', 'gateway', text=True).stdout.strip()
            if not previous:
                raise RuntimeError('Previous image unavailable')
            old_compose = (LIVE / 'compose.yaml').read_bytes()
            run(['docker', 'tag', previous, IMAGE + ':rollback'])
            source_changed = False
            gateway_touched = False
            try:
                # agentwatch first, while the gateway keeps serving: its health check first runs
                # 30 s after start, and the gateway does not depend on it.
                (LIVE / 'compose.yaml').write_bytes((stage / 'compose.yaml').read_bytes())
                compose('up', '-d', '--no-deps', 'agentwatch')
                if not agentwatch_healthy():
                    raise RuntimeError('agentwatch failed startup health')
                # Work may have started meanwhile; recreating the gateway would cut it off.
                if busy():
                    raise Busy()
                gateway_touched = True
                compose('stop', 'gateway')
                run(['docker', 'tag', candidate, IMAGE + ':latest'])
                compose('up', '-d', '--no-deps', '--no-build', 'gateway')
                if not healthy():
                    raise RuntimeError('Candidate failed startup health')
                compose('exec', '-T', 'gateway', 'node', '-e', GATEWAY_REACHES_AGENTWATCH)
                source_changed = True
                publish_source(stage)
                write_release((sha + '\n').encode())
            except Exception as failure:
                # The gateway first: it is what the owner uses; agentwatch only watches it.
                try:
                    if gateway_touched:
                        compose('stop', 'gateway')
                        if source_changed:
                            restore_source(backup, original)
                        run(['docker', 'tag', previous, IMAGE + ':latest'])
                        (LIVE / 'compose.yaml').write_bytes(old_compose)
                        compose('up', '-d', '--no-deps', '--no-build', 'gateway')
                        if not healthy():
                            raise RuntimeError('Rollback health failed')
                        write_release(old_release)
                    (LIVE / 'compose.yaml').write_bytes(old_compose)
                    remove_agentwatch()
                except Exception:
                    raise RuntimeError('Rollback needs operator inspection; no task replay was attempted; agentwatch volume kept') from None
                if isinstance(failure, Busy):
                    raise RuntimeError('Work started while agentwatch was starting; gateway untouched, agentwatch removed; retry when idle') from None
                if not gateway_touched:
                    raise RuntimeError('agentwatch did not start; gateway untouched, agentwatch removed, its volume kept') from None
                raise RuntimeError('Candidate failed; previous application healthy; agentwatch removed, its volume kept') from None
            # The trusted /usr/local/sbin release command is unchanged and is not installed here.
            print(json.dumps({'deployed': sha, 'healthy': True, 'agentwatch': True}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else 'Rollout failed; inspect the reviewed procedure locally', file=sys.stderr)
        sys.exit(1)
