#!/usr/bin/env python3
"""Reviewed one-time operator rollout for pgvector and migration 034 (docs/recall.md).

Unlike earlier rollouts this replaces the Postgres image, so the gateway and database restart.
The image is the exact one that ran before with pgvector compiled in, on the same data volume.
It takes a fresh backup first and proves the extension before starting the gateway. Once the
migration has run, a rollback must keep this image: the plain image cannot read vector columns."""
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
# Baseline: the live release and main when this PR merged (verify before rollout).
# Reconcile with the live RELEASE immediately before rollout; never rewrite RELEASE to match.
BASE = '58a921a1e1ac1e1ad8044daf747186768f897173'
BASES = {BASE}
IMAGE = 'hermes-companion-gateway'
MIGRATION = '034_embeddings.sql'
COMPOSE_ANCHOR = b'        "/migrations/033_mail_index.sql",\n'
COMPOSE_ADDITION = b'        "-f",\n        "/migrations/034_embeddings.sql",\n'
POSTGRES_IMAGE = 'chief-postgres:17-alpine-pgvector-0.8.7'
BACKUPS = pathlib.Path('/var/backups/hermes-companion')
# The same binaries must see the same data files: version and collation, compared across the swap.
DATABASE_IDENTITY = ("SELECT current_setting('server_version')||'/'||datlocprovider||'/'||datcollate||'/'||"
                     "datctype||'/'||coalesce(datcollversion,'') FROM pg_database WHERE datname=current_database()")
OLD_SERVICE = b'  postgres:\n    image: postgres:17-alpine\n'
NEW_SERVICE = (b'  postgres:\n'
               b'    # pgvector compiled onto the exact image that ran before it (docs/recall.md).\n'
               b'    image: chief-postgres:17-alpine-pgvector-0.8.7\n'
               b'    build:\n      context: .\n      dockerfile: Dockerfile.postgres\n')
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


def running_postgres_digest():
    image = compose('images', '-q', 'postgres', text=True).stdout.strip()
    return run(['docker', 'image', 'inspect', '--format', '{{json .RepoDigests}}', image], text=True).stdout


def fresh_backup(started):
    # The backup script exits 0 without a dump when another backup holds its lock.
    return any(path.stat().st_mtime >= started and path.stat().st_size > 0
               for path in BACKUPS.glob('database-*.dump.cms'))


def postgres_ready():
    for _ in range(60):
        try:
            if sql('SELECT 1') == '1':
                return True
        except Exception:
            pass
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
                    or relative.parts[0] in {'RELEASE', '.git', '.RELEASE-pgvector'}
                    or any(p.startswith('.env') and p != '.env.example' for p in relative.parts)
                    or relative in seen):
                raise RuntimeError('Unsafe archive entry')
            seen.add(relative)
        archive.extractall(stage, members=members, filter='data')


def validate_changes(stage):
    for name in ['Dockerfile', 'Dockerfile.postgres', 'package.json', 'package-lock.json', 'compose.yaml',
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
        raise RuntimeError('Unexpected migration set; only 034 is permitted')
    baseline_compose = (LIVE / 'compose.yaml').read_bytes()
    if (baseline_compose.count(COMPOSE_ANCHOR) != 1 or MIGRATION.encode() in baseline_compose
            or baseline_compose.count(OLD_SERVICE) != 1):
        raise RuntimeError('Compose baseline does not match the reviewed migration list')
    expected = baseline_compose.replace(COMPOSE_ANCHOR, COMPOSE_ANCHOR + COMPOSE_ADDITION).replace(
        OLD_SERVICE, NEW_SERVICE)
    if (stage / 'compose.yaml').read_bytes() != expected:
        raise RuntimeError('Unexpected Compose change; only the migration 034 entry and the pgvector image are permitted')
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
    pending = LIVE / '.RELEASE-pgvector'
    try:
        pending.write_bytes(content)
        pending.replace(LIVE / 'RELEASE')
    finally:
        pending.unlink(missing_ok=True)


def main():
    if len(sys.argv) != 3 or not re.fullmatch('[0-9a-f]{40}', sys.argv[2]):
        raise RuntimeError('Usage: deploy-pgvector.py <git-archive.tar> <exact reviewed main SHA>')
    archive_path, sha = sys.argv[1:]
    with open(LOCK, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        old_release = (LIVE / 'RELEASE').read_bytes()
        if old_release.decode().strip() not in BASES:
            raise RuntimeError('pgvector rollout requires the exact documented baseline; reconcile newer releases first')
        with tempfile.TemporaryDirectory(prefix='companion-pgvector-') as temporary:
            stage, backup = pathlib.Path(temporary) / 'stage', pathlib.Path(temporary) / 'backup'
            stage.mkdir()
            backup.mkdir()
            unpack(archive_path, sha, stage)
            validate_changes(stage)
            bases = set(re.findall(r'^FROM postgres:17-alpine@(sha256:[0-9a-f]{64})',
                                   (stage / 'Dockerfile.postgres').read_text(), re.M))
            if len(bases) != 1 or bases.pop() not in running_postgres_digest():
                raise RuntimeError('Running Postgres is not the base of the pgvector image; live application unchanged')
            original = backup_source(stage, backup)
            candidate = IMAGE + ':' + sha
            try:
                run(['docker', 'build', '--build-arg', 'RELEASE_SHA=' + sha, '-t', candidate, str(stage)])
            except Exception:
                raise RuntimeError('Candidate build failed; live application unchanged') from None
            try:
                run(['docker', 'build', '-f', str(stage / 'Dockerfile.postgres'), '-t', POSTGRES_IMAGE, str(stage)])
            except Exception:
                raise RuntimeError('Postgres image build failed; live application unchanged') from None
            if not healthy():
                raise RuntimeError('Baseline application is not healthy; inspect before rollout')
            if sql("SELECT count(*) FROM runtime_runs WHERE state='running'") != '0':
                raise RuntimeError('Active work; retry when idle without cancelling it')
            if sql("SELECT count(*) FROM conversation_inputs WHERE state IN ('queued','running')") != '0':
                raise RuntimeError('Pending conversation input; retry after scheduled work and execution finish')
            previous = compose('images', '-q', 'gateway', text=True).stdout.strip()
            if not previous:
                raise RuntimeError('Previous image unavailable')
            old_identity = sql(DATABASE_IDENTITY)
            started = int(time.time())
            try:
                # A recovery point from just before the database restarts.
                run(['systemctl', 'start', 'hermes-backup.service'])
                backed_up = fresh_backup(started)
            except Exception:
                backed_up = False
            if not backed_up:
                raise RuntimeError('Fresh backup failed; live application unchanged')
            old_compose = (LIVE / 'compose.yaml').read_bytes()
            run(['docker', 'tag', previous, IMAGE + ':rollback'])
            source_changed = False
            image_replaced = False
            migration_applied = False
            try:
                compose('stop', 'gateway')
                (LIVE / 'compose.yaml').write_bytes((stage / 'compose.yaml').read_bytes())
                image_replaced = True
                compose('up', '-d', '--no-deps', '--no-build', 'postgres')
                if not postgres_ready():
                    raise RuntimeError('Postgres did not come back on the pgvector image')
                if sql(DATABASE_IDENTITY) != old_identity:
                    raise RuntimeError('The pgvector image changed the Postgres version or collation')
                sql((stage / 'db' / MIGRATION).read_text())
                migration_applied = True
                if sql('SELECT count(*) FROM runtime_migrations WHERE version=34') != '1':
                    raise RuntimeError('Migration 034 marker unavailable')
                if sql("SELECT '[1,0]'::vector <=> '[1,0]'::vector") != '0':
                    raise RuntimeError('pgvector did not answer a distance query')
                run(['docker', 'tag', candidate, IMAGE + ':latest'])
                compose('up', '-d', '--no-deps', '--no-build', 'gateway')
                if not healthy():
                    raise RuntimeError('Candidate failed startup health')
                source_changed = True
                publish_source(stage)
                write_release((sha + '\n').encode())
            except Exception:
                try:
                    # A lost reply after COMMIT must not bring back an image that cannot read it.
                    if image_replaced and not migration_applied:
                        migration_applied = sql('SELECT count(*) FROM runtime_migrations WHERE version=34') == '1'
                except Exception:
                    pass
                try:
                    compose('stop', 'gateway')
                    if source_changed:
                        restore_source(backup, original)
                    if migration_applied:
                        # A full Compose start needs these: it builds this image and reapplies 034.
                        for name in ['compose.yaml', 'Dockerfile.postgres', f'db/{MIGRATION}']:
                            copy_entry(stage / name, LIVE / name)
                    else:
                        # Nothing depends on pgvector yet, so the plain image comes back too.
                        (LIVE / 'compose.yaml').write_bytes(old_compose)
                        if image_replaced:
                            compose('up', '-d', '--no-deps', '--no-build', 'postgres')
                            if not postgres_ready():
                                raise RuntimeError('Postgres rollback failed')
                    run(['docker', 'tag', previous, IMAGE + ':latest'])
                    compose('up', '-d', '--no-deps', '--no-build', 'gateway')
                    if not healthy():
                        raise RuntimeError('Rollback health failed')
                    write_release(old_release)
                except Exception:
                    raise RuntimeError('Rollback needs operator inspection; a fresh backup exists; no database reversal or task replay was attempted') from None
                if migration_applied:
                    # The plain image cannot read vector columns, so Postgres keeps this one.
                    # The old gateway ignores the table. This script cannot run again, and the
                    # release guard now passes, so a release deploys the same candidate.
                    raise RuntimeError('Candidate failed; previous gateway healthy on the pgvector image; migration 034 and the Compose change retained; automatic releases are no longer refused, so find the cause first: a release of this commit deploys the same candidate, with its own rollback') from None
                raise RuntimeError('Candidate failed; previous application healthy on the plain Postgres image; nothing retained') from None
            # The trusted /usr/local/sbin release command is unchanged and is not installed here.
            print(json.dumps({'deployed': sha, 'healthy': True, 'migration': 34, 'postgres': POSTGRES_IMAGE}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else 'Rollout failed; inspect the reviewed procedure locally', file=sys.stderr)
        sys.exit(1)
