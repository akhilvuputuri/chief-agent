#!/usr/bin/env python3
"""Reviewed one-time operator rollout for the public browser agent (docs/public-browser.md).

Builds the gateway and the two public-browser images, writes the new key and flag, starts the
new services, and runs the confinement probe inside the candidate browser. The gateway reads
the flag only when it is recreated after the probe passes, so the agent stays off until then.
No migration. The invoice browser and its proxy are not touched. Prints no secret."""
import fcntl
import json
import os
import pathlib
import re
import secrets
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
BASE = '4a2f4b88ca52b31645ced4ddf656d71803e832fa'
BASES = {BASE}
IMAGE = 'hermes-companion-gateway'
PROFILE = ['--profile', 'public-browser']
SERVICES = ['public-browser-proxy', 'public-browser']
MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
ENV_ANCHOR = b'      BOXES_RUNTIME: ${BOXES_RUNTIME:-off}\n'
ENV_ADDITION = (b'      PUBLIC_BROWSER: ${PUBLIC_BROWSER:-off}\n'
                b'      PUBLIC_BROWSER_KEY: ${PUBLIC_BROWSER_KEY:-}\n')
NETWORK_OLD = b'    networks: [default, browser-control]\n'
NETWORK_NEW = b'    networks: [default, browser-control, public-browser-control]\n'
TOP_ANCHOR = b'  browser-control: { internal: true }\n'
TOP_ADDITION = b'  public-browser-control: { internal: true }\n'
SERVICES_ANCHOR = b'  agentwatch:\n'


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
                    or relative.parts[0] in {'RELEASE', '.git', '.RELEASE-public-browser'}
                    or any(p.startswith('.env') and p != '.env.example' for p in relative.parts)
                    or relative in seen):
                raise RuntimeError('Unsafe archive entry')
            seen.add(relative)
        archive.extractall(stage, members=members, filter='data')


def expected_compose(baseline, services_block):
    """The live Compose file plus exactly this rollout's additions."""
    if (baseline.count(ENV_ANCHOR) != 1 or baseline.count(NETWORK_OLD) != 1
            or baseline.count(TOP_ANCHOR) != 1 or baseline.count(SERVICES_ANCHOR) != 1
            or b'public-browser' in baseline or b'PUBLIC_BROWSER' in baseline):
        raise RuntimeError('Compose baseline does not match the reviewed anchors')
    result = baseline.replace(ENV_ANCHOR, ENV_ADDITION + ENV_ANCHOR)
    result = result.replace(NETWORK_OLD, NETWORK_NEW)
    result = result.replace(SERVICES_ANCHOR, services_block + SERVICES_ANCHOR)
    return result.replace(TOP_ANCHOR, TOP_ANCHOR + TOP_ADDITION)


def services_block(candidate):
    """The one new block of services, cut from the candidate between its marker and agentwatch."""
    start = candidate.find(b'  # The anonymous browser agent')
    end = candidate.find(SERVICES_ANCHOR, start)
    if start < 0 or end < 0:
        raise RuntimeError('Candidate Compose has no public browser services')
    block = candidate[start:end]
    # Only these two services, each on its own internal network and without host access.
    names = re.findall(rb'^  ([a-z-]+):\n', block, flags=re.M)
    if names != [s.encode() for s in SERVICES]:
        raise RuntimeError('Unexpected services in the public browser block')
    for forbidden in [b'ports:', b'volumes:', b'privileged', b'docker.sock', b'network_mode',
                      b'unconfined', b'cap_add', b'.env']:
        if forbidden in block:
            raise RuntimeError('The public browser block widens access')
    return block


def validate_changes(stage):
    for name in ['Dockerfile', 'Dockerfile.browser', 'package.json', 'compose.yaml',
                 'src/main.ts', 'scripts/cloud-release.py', 'tools/agent-browser.json']:
        if not (stage / name).is_file():
            raise RuntimeError('Incomplete source archive')

    def files(directory):
        if not directory.is_dir() or directory.is_symlink():
            raise RuntimeError('Migration directory unavailable')
        return {str(p.relative_to(directory)): p.read_bytes()
                for p in directory.rglob('*') if p.is_file()}

    if files(LIVE / 'db') != files(stage / 'db'):
        raise RuntimeError('This rollout carries no migration; reconcile db first')
    candidate = (stage / 'compose.yaml').read_bytes()
    baseline = (LIVE / 'compose.yaml').read_bytes()
    if candidate != expected_compose(baseline, services_block(candidate)):
        raise RuntimeError('Unexpected Compose change; only the public browser additions are permitted')
    if (stage / 'scripts/cloud-release.py').read_bytes() != (LIVE / 'scripts/cloud-release.py').read_bytes():
        raise RuntimeError('Trusted release-handler source changed; requires separate review')


def env_with_browser(text):
    """The .env text with the agent on, keeping an existing key so a retry does not rotate it."""
    lines = [line for line in text.splitlines() if not line.startswith('PUBLIC_BROWSER=')]
    if not any(re.fullmatch('PUBLIC_BROWSER_KEY=[0-9a-f]{64}', line) for line in lines):
        lines = [line for line in lines if not line.startswith('PUBLIC_BROWSER_KEY=')]
        lines.append('PUBLIC_BROWSER_KEY=' + secrets.token_hex(32))
    lines.append('PUBLIC_BROWSER=on')
    return '\n'.join(lines) + '\n'


def probe():
    """The confinement proof, in the running candidate on its own network. Any failure refuses.
    Returns the failed checks' names and the memory peak line, never other probe output."""
    try:
        result = subprocess.run(
            ['docker', 'compose', '--project-directory', str(LIVE), '-p', 'hermes-companion',
             *PROFILE, 'exec', '-T', 'public-browser', 'node', 'public-browser-probe.mjs'],
            capture_output=True, text=True, timeout=240)
    except subprocess.TimeoutExpired:
        return ['probe timed out'], ''
    return probe_outcome(result.returncode, result.stdout)


def probe_outcome(returncode, stdout):
    lines = stdout.splitlines()
    failed = [line[5:].split(' (')[0][:100] for line in lines if line.startswith('FAIL ')]
    if returncode != 0 and not failed:
        failed = ['probe stopped before finishing']
    return failed, next((line[:60] for line in lines if line.startswith('memory peak')), '')


def require_idle():
    """Run just before the gateway stops: an earlier check goes stale during builds and the probe."""
    if sql("SELECT count(*) FROM runtime_runs WHERE state='running'") != '0':
        raise RuntimeError('Active work; retry when idle without cancelling it')
    if sql("SELECT count(*) FROM conversation_inputs WHERE state IN ('queued','running')") != '0':
        raise RuntimeError('Pending conversation input; retry after scheduled work and execution finish')


def write_env(path, text):
    """Replaces .env in one step with its existing owner and mode."""
    status = path.stat()
    pending = path.with_name('.env.public-browser')
    try:
        pending.touch(mode=0o600)
        os.chown(pending, status.st_uid, status.st_gid)
        os.chmod(pending, status.st_mode & 0o777)
        pending.write_text(text)
        pending.replace(path)
    finally:
        pending.unlink(missing_ok=True)


def restore_gateway(stopped, previous):
    """Before the stop it still runs its old image, and recreating it could drop running work."""
    if not stopped:
        return
    run(['docker', 'tag', previous, IMAGE + ':latest'])
    compose('up', '-d', '--no-deps', '--no-build', 'gateway')
    if not healthy():
        raise RuntimeError('Rollback health failed')


def rollback(steps):
    """Every step runs even if an earlier one fails, so one failure cannot leave the rest undone."""
    failed = False
    for step in steps:
        try:
            step()
        except Exception:
            failed = True
    return not failed


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
    pending = LIVE / '.RELEASE-public-browser'
    try:
        pending.write_bytes(content)
        pending.replace(LIVE / 'RELEASE')
    finally:
        pending.unlink(missing_ok=True)


def main():
    if len(sys.argv) != 3 or not re.fullmatch('[0-9a-f]{40}', sys.argv[2]):
        raise RuntimeError('Usage: deploy-public-browser.py <git-archive.tar> <exact reviewed main SHA>')
    archive_path, sha = sys.argv[1:]
    with open(LOCK, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        old_release = (LIVE / 'RELEASE').read_bytes()
        if old_release.decode().strip() not in BASES:
            raise RuntimeError('Rollout requires the exact documented baseline; reconcile newer releases first')
        with tempfile.TemporaryDirectory(prefix='companion-public-browser-') as temporary:
            stage, backup = pathlib.Path(temporary) / 'stage', pathlib.Path(temporary) / 'backup'
            stage.mkdir()
            backup.mkdir()
            unpack(archive_path, sha, stage)
            validate_changes(stage)
            candidate = IMAGE + ':' + sha
            try:
                run(['docker', 'build', '--build-arg', 'RELEASE_SHA=' + sha, '-t', candidate, str(stage)])
                run(['docker', 'build', '-f', str(stage / 'Dockerfile.browser'), '--target', 'proxy',
                     '-t', 'chief-public-browser-proxy', str(stage)])
                run(['docker', 'build', '-f', str(stage / 'Dockerfile.browser'), '--target', 'public-browser',
                     '-t', 'chief-public-browser', str(stage)])
            except Exception:
                raise RuntimeError('Candidate build failed; live application unchanged') from None
            if not healthy():
                raise RuntimeError('Baseline application is not healthy; inspect before rollout')
            require_idle()
            previous = compose('images', '-q', 'gateway', text=True).stdout.strip()
            if not previous:
                raise RuntimeError('Previous image unavailable')
            env_path = LIVE / '.env'
            old_compose = (LIVE / 'compose.yaml').read_bytes()
            old_env = env_path.read_bytes()
            old_seccomp = (LIVE / 'deploy/browser/seccomp.json').read_bytes()
            if old_seccomp != (stage / 'deploy/browser/seccomp.json').read_bytes():
                raise RuntimeError('The seccomp profile changed; requires separate review')
            run(['docker', 'tag', previous, IMAGE + ':rollback'])
            source_changed = False
            gateway_stopped = False
            original = backup_source(stage, backup)
            try:
                (LIVE / 'compose.yaml').write_bytes((stage / 'compose.yaml').read_bytes())
                write_env(env_path, env_with_browser(old_env.decode()))
                compose(*PROFILE, 'up', '-d', '--no-build', '--wait', '--wait-timeout', '120', *SERVICES)
                failed, peak = probe()
                if failed:
                    raise RuntimeError('Confinement probe failed: ' + '; '.join(failed)[:400])
                require_idle()
                gateway_stopped = True
                compose('stop', 'gateway')
                run(['docker', 'tag', candidate, IMAGE + ':latest'])
                compose('up', '-d', '--no-deps', '--no-build', 'gateway')
                if not healthy():
                    raise RuntimeError('Candidate failed startup health')
                source_changed = True
                publish_source(stage)
                write_release((sha + '\n').encode())
            except Exception as error:
                reason = str(error) if isinstance(error, RuntimeError) else 'Rollout step failed'
                restored = rollback([
                    lambda: compose(*PROFILE, 'rm', '--stop', '--force', *SERVICES),
                    lambda: restore_source(backup, original) if source_changed else None,
                    lambda: write_env(env_path, old_env.decode()),
                    lambda: (LIVE / 'compose.yaml').write_bytes(old_compose),
                    lambda: restore_gateway(gateway_stopped, previous),
                    lambda: write_release(old_release),
                ])
                if not restored:
                    raise RuntimeError(reason + '; rollback needs operator inspection') from None
                raise RuntimeError(reason + '; previous application restored and the agent stays off') from None
            print(json.dumps({'deployed': sha, 'healthy': True, 'publicBrowser': 'on', 'probe': 'passed', 'memory': peak}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else 'Rollout failed; inspect the reviewed procedure locally', file=sys.stderr)
        sys.exit(1)
