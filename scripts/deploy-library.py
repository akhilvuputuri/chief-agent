#!/usr/bin/env python3
"""Reviewed one-time operator rollout for the NLB library migration 016, the widened approvals constraint in db/003 and db/009, and the two library environment variables."""
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
BASE = '794da5fda26482877d12d21661cb9f38adda4378'
IMAGE = 'hermes-companion-gateway'
MIGRATION = '016_library.sql'
OLD_CHECK = b"CHECK(operation IN ('job_delete','skill_activate','calendar_create'))"
NEW_CHECK = b"CHECK(operation IN ('job_delete','skill_activate','calendar_create','library_borrow','library_hold','library_hold_cancel','library_link','library_revoke'))"
WIDENED = {'003_skills.sql', '009_calendar_approval.sql'}
ENV_ANCHOR = b'      MINIAPP_ORIGIN: ${MINIAPP_ORIGIN:-}\n'
ENV_ADDITION = b'      LIBRARY_IDENTITY_KEY: ${LIBRARY_IDENTITY_KEY:-}\n      LIBRARY_HOLD_EMAIL: ${LIBRARY_HOLD_EMAIL:-}\n'
KEY_LINE = re.compile(rb'^LIBRARY_IDENTITY_KEY=[0-9a-fA-F]{64}\s*$', re.M)
COMPOSE_ANCHOR = b'        "/migrations/015_preparation_chain.sql",\n'
COMPOSE_ADDITION = b'        "-f",\n        "/migrations/016_library.sql",\n'
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
                    or relative.parts[0] in {'RELEASE', '.git', '.RELEASE-library'}
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
    for name, content in old.items():
        staged = new.get(name)
        if name in WIDENED:
            # The Calendar precedent: the historical CHECK line is widened in place, identically, in both files.
            if content.count(OLD_CHECK) != 1 or staged != content.replace(OLD_CHECK, NEW_CHECK):
                raise RuntimeError('Historical migration changed beyond the reviewed approvals constraint widening')
        elif staged != content:
            raise RuntimeError('Historical migration changed or removed')
    if new.keys() - old.keys() != {MIGRATION}:
        raise RuntimeError('Unexpected migration set; only 016 is permitted')
    if new[MIGRATION].count(NEW_CHECK) != 1:
        raise RuntimeError('Migration 016 must repeat the widened approvals constraint exactly')
    baseline_compose = (LIVE / 'compose.yaml').read_bytes()
    if (baseline_compose.count(COMPOSE_ANCHOR) != 1 or MIGRATION.encode() in baseline_compose
            or baseline_compose.count(ENV_ANCHOR) != 1 or b'LIBRARY_IDENTITY_KEY' in baseline_compose):
        raise RuntimeError('Compose baseline does not match the reviewed migration list and environment')
    expected = baseline_compose.replace(COMPOSE_ANCHOR, COMPOSE_ANCHOR + COMPOSE_ADDITION).replace(ENV_ANCHOR, ENV_ANCHOR + ENV_ADDITION)
    staged_compose = (stage / 'compose.yaml').read_bytes()
    if staged_compose != expected:
        raise RuntimeError('Unexpected Compose change; only the migration 016 entry and the two gateway library variables are permitted')
    migrate_section = staged_compose.split(b'  gateway:')[0]
    if b'LIBRARY_IDENTITY_KEY' in migrate_section:
        raise RuntimeError('The identity key must not be exposed to the migrate service')
    env = (LIVE / '.env').read_bytes() if (LIVE / '.env').is_file() else b''
    if not KEY_LINE.search(env):
        raise RuntimeError('Server .env must define LIBRARY_IDENTITY_KEY as 64 hexadecimal characters before rollout')
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
    pending = LIVE / '.RELEASE-library'
    try:
        pending.write_bytes(content)
        pending.replace(LIVE / 'RELEASE')
    finally:
        pending.unlink(missing_ok=True)


def main():
    if len(sys.argv) != 3 or not re.fullmatch('[0-9a-f]{40}', sys.argv[2]):
        raise RuntimeError('Usage: deploy-library.py <git-archive.tar> <exact reviewed main SHA>')
    archive_path, sha = sys.argv[1:]
    with open(LOCK, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        old_release = (LIVE / 'RELEASE').read_bytes()
        if old_release.decode().strip() != BASE:
            raise RuntimeError('Library rollout requires the exact documented baseline; reconcile newer releases first')
        with tempfile.TemporaryDirectory(prefix='companion-library-') as temporary:
            stage, backup = pathlib.Path(temporary) / 'stage', pathlib.Path(temporary) / 'backup'
            stage.mkdir()
            backup.mkdir()
            unpack(archive_path, sha, stage)
            validate_changes(stage)
            original = backup_source(stage, backup)
            candidate = IMAGE + ':' + sha
            try:
                run(['docker', 'build', '-t', candidate, str(stage)])
            except Exception:
                raise RuntimeError('Candidate build failed; live application unchanged') from None
            if not healthy():
                raise RuntimeError('Baseline application is not healthy; inspect before rollout')
            if sql("SELECT count(*) FROM runtime_runs WHERE state='running'") != '0':
                raise RuntimeError('Active work; retry when idle without cancelling it')
            if sql("SELECT count(*) FROM conversation_inputs WHERE state IN ('queued','running')") != '0':
                raise RuntimeError('Pending conversation input; retry after preparation and execution finish')
            previous = compose('images', '-q', 'gateway', text=True).stdout.strip()
            if not previous:
                raise RuntimeError('Previous image unavailable')
            old_compose = (LIVE / 'compose.yaml').read_bytes()
            run(['docker', 'tag', previous, IMAGE + ':rollback'])
            source_changed = False
            try:
                compose('stop', 'gateway')
                sql((stage / 'db' / MIGRATION).read_text())
                if sql('SELECT count(*) FROM runtime_migrations WHERE version=16') != '1':
                    raise RuntimeError('Migration 016 marker unavailable')
                if 'library_borrow' not in sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='approvals_operation_check'"):
                    raise RuntimeError('Approvals constraint was not widened')
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
                    # The restored narrow 003/009 validate existing rows on the next Compose start, so no
                    # library approval may remain. Only the failed candidate could have created them.
                    sql("DELETE FROM library_link_attempts; DELETE FROM approvals WHERE operation LIKE 'library\\_%'")
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
                raise RuntimeError('Candidate failed; previous application healthy; the widened constraint and empty library tables are retained, library approval rows removed') from None
            # The trusted /usr/local/sbin release command is unchanged and is not installed here.
            print(json.dumps({'deployed': sha, 'healthy': True, 'migration': 16}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else 'Rollout failed; inspect the reviewed procedure locally', file=sys.stderr)
        sys.exit(1)
