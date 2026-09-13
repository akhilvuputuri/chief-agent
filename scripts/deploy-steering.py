#!/usr/bin/env python3
"""Reviewed operator rollout for checkpoint steering 014. Not a cloud SSH capability."""
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
BASE = 'd0e33365c7cec7b7cb1eb64c22de7c09d5d9a314'
IMAGE = 'hermes-companion-gateway'


def run(args, **kw):
    return subprocess.run(args, check=True, **kw)


def compose(*args, **kw):
    return run(['docker', 'compose', '--project-directory', str(LIVE), '-p', 'hermes-companion', *args], **kw)


def sql(statement):
    return run(['docker', 'exec', '-i', 'hermes-companion-postgres-1', 'psql', '-X', '-U', 'companion', '-d', 'companion', '-v', 'ON_ERROR_STOP=1', '-tA'], input=statement, text=True, capture_output=True).stdout.strip()


def healthy():
    for _ in range(30):
        result = subprocess.run(['curl', '--fail', '--silent', '--max-time', '3', 'http://127.0.0.1:3000/healthz'], capture_output=True)
        if result.returncode == 0:
            time.sleep(3)
            state = compose('ps', '--format', 'json', 'gateway', capture_output=True, text=True).stdout
            if 'healthy' in state and 'unhealthy' not in state:
                return True
        time.sleep(2)
    return False


def main():
    archive_path, sha = sys.argv[1:]
    if not re.fullmatch('[0-9a-f]{40}', sha):
        raise RuntimeError('Expected exact reviewed main SHA')
    with open('/var/lock/companion-release.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if (LIVE/'RELEASE').read_text().strip() != BASE:
            raise RuntimeError('Checkpoint steering rollout requires the documented v0.3.8 baseline; reconcile newer releases first')
        with tempfile.TemporaryDirectory(prefix='companion-steering-') as tmp:
            stage = pathlib.Path(tmp)
            with tarfile.open(archive_path) as archive:
                if archive.pax_headers.get('comment') != sha:
                    raise RuntimeError('Archive commit does not match requested SHA')
                for member in archive.getmembers():
                    path = pathlib.PurePosixPath(member.name)
                    if path.is_absolute() or '..' in path.parts or not(member.isfile() or member.isdir()) or any(p.startswith('.env') and p != '.env.example' for p in path.parts):
                        raise RuntimeError('Unsafe archive entry')
                archive.extractall(stage, filter='data')
            for old in (LIVE/'db').glob('*.sql'):
                if not (stage/'db'/old.name).exists() or old.read_bytes() != (stage/'db'/old.name).read_bytes():
                    raise RuntimeError('Historical migration changed')
            if set(p.name for p in (stage/'db').glob('*.sql')) - set(p.name for p in (LIVE/'db').glob('*.sql')) != {'014_checkpoint_steering.sql'}:
                raise RuntimeError('Unexpected migration set')
            candidate = IMAGE+':'+sha
            built = subprocess.run(['docker','build','-t',candidate,str(stage)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            if built.returncode:
                raise RuntimeError('Candidate build failed; live application unchanged')
            if sql("SELECT count(*) FROM runtime_runs WHERE state='running'") != '0':
                raise RuntimeError('Active work; retry when idle without cancelling it')
            if sql("SELECT count(*) FROM conversation_inputs WHERE state IN ('queued','running')") != '0':
                raise RuntimeError('Pending conversation input; retry after preparation and execution finish')
            previous = compose('images','-q','gateway',capture_output=True,text=True).stdout.strip()
            if not previous:
                raise RuntimeError('Previous image unavailable')
            old_compose = (LIVE/'compose.yaml').read_bytes()
            run(['docker','tag',previous,IMAGE+':rollback'])
            compose('stop','gateway')
            try:
                sql((stage/'db/014_checkpoint_steering.sql').read_text())
                (LIVE/'compose.yaml').write_bytes((stage/'compose.yaml').read_bytes())
                run(['docker','tag',candidate,IMAGE+':latest'])
                compose('up','-d','--no-deps','--no-build','gateway')
                if not healthy():
                    raise RuntimeError('Candidate failed startup health')
            except Exception:
                compose('stop','gateway')
                # Migration014 adds columns/indexes only. Preserve input and delivery
                # records on rollback; never reconstruct or replay conversation/actions.
                (LIVE/'compose.yaml').write_bytes(old_compose)
                run(['docker','tag',previous,IMAGE+':latest'])
                compose('up','-d','--no-deps','--no-build','gateway')
                if not healthy():
                    raise RuntimeError('Rollback needs operator inspection; data has not been removed')
                raise RuntimeError('Candidate failed; previous application healthy; additive input and delivery records retained')
            for item in stage.iterdir():
                dest = LIVE/item.name
                if item.is_dir():
                    if dest.exists():
                        shutil.rmtree(dest)
                    shutil.copytree(item,dest)
                else:
                    shutil.copy2(item,dest)
            shutil.copyfile(stage/'scripts/cloud-release.py','/usr/local/sbin/companion-cloud-release')
            pathlib.Path('/usr/local/sbin/companion-cloud-release').chmod(0o755)
            (LIVE/'RELEASE').write_text(sha+'\n')
            print(json.dumps({'deployed':sha,'healthy':True,'migration':14}))


if __name__ == '__main__':
    main()
