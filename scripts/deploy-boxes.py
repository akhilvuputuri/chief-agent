#!/usr/bin/env python3
"""Reviewed one-time operator rollout for box migration 032 (issue #245, docs/boxes.md).

Additive tables only. Boxes stay off (BOXES_RUNTIME defaults to off), so the gateway's
behaviour is unchanged until the owner enables them. Also installs the /boxes/* Caddy route
to the gateway, which answers 401 or 404 until boxes are enabled."""
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
# Baseline: the exact-commit release receipt for the live main at merge time (verify before rollout).
# Reconcile with the live RELEASE immediately before rollout; never rewrite RELEASE to match.
BASE = '0000000000000000000000000000000000000000'  # set to the live RELEASE at merge time
BASES = {BASE}
IMAGE = 'hermes-companion-gateway'
MIGRATION = '032_boxes.sql'
COMPOSE_ANCHOR = b'        "/migrations/031_link_resolution.sql",\n'
COMPOSE_ADDITION = b'        "-f",\n        "/migrations/032_boxes.sql",\n'
MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
CADDYFILE = pathlib.Path('/etc/caddy/Caddyfile')
# The live site's final catch-all; the box route is inserted just before it.
CADDY_ANCHOR = '  handle {\n    respond "Not found" 404\n  }\n'
CADDY_ROUTE = ('  # Boxed sub-agent channel (docs/boxes.md); every request is authenticated by the gateway.\n'
               '  @boxes path /boxes/*\n'
               '  handle @boxes {\n'
               '    reverse_proxy 127.0.0.1:3000\n'
               '  }\n')


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
                    or relative.parts[0] in {'RELEASE', '.git', '.RELEASE-boxes'}
                    or any(p.startswith('.env') and p != '.env.example' for p in relative.parts)
                    or relative in seen):
                raise RuntimeError('Unsafe archive entry')
            seen.add(relative)
        archive.extractall(stage, members=members, filter='data')


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

    old, new = files(LIVE / 'db'), files(stage / 'db')
    if any(new.get(name) != content for name, content in old.items()):
        raise RuntimeError('Historical migration changed or removed')
    if new.keys() - old.keys() != {MIGRATION}:
        raise RuntimeError('Unexpected migration set; only 032 is permitted')
    baseline_compose = (LIVE / 'compose.yaml').read_bytes()
    if baseline_compose.count(COMPOSE_ANCHOR) != 1 or MIGRATION.encode() in baseline_compose:
        raise RuntimeError('Compose baseline does not match the reviewed migration list')
    expected = baseline_compose.replace(COMPOSE_ANCHOR, COMPOSE_ANCHOR + COMPOSE_ADDITION)
    if (stage / 'compose.yaml').read_bytes() != expected:
        raise RuntimeError('Unexpected Compose change; only the migration 032 entry is permitted')
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
    pending = LIVE / '.RELEASE-boxes'
    try:
        pending.write_bytes(content)
        pending.replace(LIVE / 'RELEASE')
    finally:
        pending.unlink(missing_ok=True)


def caddy_reaches_gateway():
    """A box route answered by the gateway: 401 (boxes on) or the gateway's JSON 404."""
    origin = dict(line.split('=', 1) for line in (LIVE / '.env').read_text().splitlines()
                  if line.startswith('CODING_PUBLIC_ORIGIN=')).get('CODING_PUBLIC_ORIGIN', '')
    if not re.fullmatch(r'https://[a-z0-9.-]+', origin):
        raise RuntimeError('CODING_PUBLIC_ORIGIN unavailable for the route check')
    probe = subprocess.run(
        ['curl', '--silent', '--max-time', '10', '--output', '-', '--write-out', '\\n%{http_code}',
         origin + '/boxes/00000000-0000-4000-8000-000000000000/next?after=0'],
        capture_output=True, text=True)
    body, _, code = probe.stdout.rpartition('\n')
    return code == '401' or (code == '404' and body.strip().startswith('{'))


def install_caddy_route():
    """Adds the /boxes/* route before the site's catch-all, validates, reloads, verifies.
    On any failure the previous Caddyfile is restored and reloaded."""
    original = CADDYFILE.read_text()
    if CADDY_ROUTE in original:
        return 'present'
    if original.count(CADDY_ANCHOR) != 1 or '/boxes/' in original:
        raise RuntimeError('Gateway and migration installed; live Caddyfile does not match the reviewed anchor, so the route was not added')
    candidate = original.replace(CADDY_ANCHOR, CADDY_ROUTE + CADDY_ANCHOR)
    with tempfile.NamedTemporaryFile('w', suffix='.Caddyfile', delete=False) as staged:
        staged.write(candidate)
    staged_path = pathlib.Path(staged.name)
    try:
        run(['caddy', 'validate', '--config', str(staged_path), '--adapter', 'caddyfile'])
        backup = CADDYFILE.with_name('Caddyfile.before-boxes')
        backup.write_text(original)
        try:
            CADDYFILE.write_text(candidate)
            run(['systemctl', 'reload', 'caddy'])
            if not caddy_reaches_gateway():
                raise RuntimeError('route check failed')
        except Exception:
            CADDYFILE.write_text(original)
            run(['systemctl', 'reload', 'caddy'])
            raise RuntimeError('Gateway and migration installed; Caddy route failed and the previous Caddyfile was restored') from None
    except subprocess.CalledProcessError:
        raise RuntimeError('Gateway and migration installed; Caddy route failed validation and was not added') from None
    finally:
        staged_path.unlink(missing_ok=True)
    return 'added'


def main():
    if len(sys.argv) != 3 or not re.fullmatch('[0-9a-f]{40}', sys.argv[2]):
        raise RuntimeError('Usage: deploy-boxes.py <git-archive.tar> <exact reviewed main SHA>')
    archive_path, sha = sys.argv[1:]
    with open(LOCK, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        old_release = (LIVE / 'RELEASE').read_bytes()
        if old_release.decode().strip() not in BASES:
            raise RuntimeError('Box rollout requires the exact documented baseline; reconcile newer releases first')
        with tempfile.TemporaryDirectory(prefix='companion-boxes-') as temporary:
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
            migration_applied = False
            try:
                compose('stop', 'gateway')
                sql((stage / 'db' / MIGRATION).read_text())
                migration_applied = True
                if sql('SELECT count(*) FROM runtime_migrations WHERE version=32') != '1':
                    raise RuntimeError('Migration 032 marker unavailable')
                (LIVE / 'compose.yaml').write_bytes((stage / 'compose.yaml').read_bytes())
                run(['docker', 'tag', candidate, IMAGE + ':latest'])
                compose('up', '-d', '--no-deps', '--no-build', 'gateway')
                if not healthy():
                    raise RuntimeError('Candidate failed startup health')
                source_changed = True
                publish_source(stage)
                write_release((sha + '\n').encode())
            except Exception:
                try:
                    compose('stop', 'gateway')
                    # The previous image never reads the additive box tables; nothing to pause.
                    if source_changed:
                        restore_source(backup, original)
                    (LIVE / 'compose.yaml').write_bytes(old_compose)
                    run(['docker', 'tag', previous, IMAGE + ':latest'])
                    compose('up', '-d', '--no-deps', '--no-build', 'gateway')
                    if not healthy():
                        raise RuntimeError('Rollback health failed')
                    write_release(old_release)
                except Exception:
                    raise RuntimeError('Rollback needs operator inspection; no database reversal or task replay was attempted') from None
                raise RuntimeError('Candidate failed; previous application healthy; any committed additive migration 032 retained') from None
            # The trusted /usr/local/sbin release command is unchanged and is not installed here.
            route = install_caddy_route()
            print(json.dumps({'deployed': sha, 'healthy': True, 'migration': 32, 'caddy': route}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else 'Rollout failed; inspect the reviewed procedure locally', file=sys.stderr)
        sys.exit(1)
