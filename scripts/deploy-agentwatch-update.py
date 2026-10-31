#!/usr/bin/env python3
"""Reviewed, reusable operator procedure for agentwatch upgrades (issue #323).

The restricted release command refuses any compose.yaml change, so an agentwatch upgrade
(a new image digest, settings or limits) runs here first. The staged compose.yaml from the
exact reviewed main archive may differ from the live one only inside the `agentwatch`
service block, and that block must keep the promised safety properties: a digest-pinned
image from ghcr.io/akhilvuputuri/agentwatch, the loopback-only port, a read-only root,
every capability dropped and a memory limit.

This procedure replaces only LIVE/compose.yaml and recreates only the agentwatch container.
It does not require or write RELEASE, publish source, or stop, recreate or retag the
gateway (it only reads the gateway's health). Afterwards the live compose.yaml and db/ hash
the same as the reviewed main, so the next automatic release proceeds normally and keeps
the gateway's own settings, which this procedure leaves byte-identical. On any failure after
compose.yaml is written, the previous compose.yaml and agentwatch container are restored.
The agentwatch-data volume is never removed."""
import fcntl
import json
import pathlib
import re
import secrets
import subprocess
import sys
import tarfile
import tempfile
import time

LIVE = pathlib.Path('/opt/hermes-companion')
LOCK = pathlib.Path('/var/lock/companion-release.lock')
AGENTWATCH_CONTAINER = 'hermes-companion-agentwatch-1'
AGENTWATCH_REPOSITORY = 'ghcr.io/akhilvuputuri/agentwatch'
SERVICE_LINE = re.compile(rb'^  agentwatch:[ \t]*\n', re.M)
# Only the next service key or a top-level key ends the block; comments do not.
BLOCK_END = re.compile(rb'^(?:  [A-Za-z0-9_-]+:|[^\s#])', re.M)
KEY_LINE = re.compile(rb'    ([A-Za-z0-9_-]+):(.*)')
COMMENT_LINE = re.compile(rb'[ \t]*(?:#.*)?')
IMAGE_VALUE = re.compile(rb' ' + re.escape(AGENTWATCH_REPOSITORY.encode()) + rb'@sha256:[0-9a-f]{64}')
# The promised safety properties: each line exactly as reviewed, exactly once.
EXACT_VALUES = {
    b'volumes': b' ["agentwatch-data:/data"]',
    b'ports': b' ["127.0.0.1:4318:4318"]',
    b'read_only': b' true',
    b'tmpfs': b' [/tmp]',
    b'cap_drop': b' [ALL]',
    b'security_opt': b' ["no-new-privileges:true"]',
}
REQUIRED_KEYS = {b'image', b'mem_limit', *EXACT_VALUES}
# The only other permitted keys (mem_limit is also required), each with a reviewed value form.
# Any other service-level key, or repeating any key, is refused.
OPTIONAL_VALUES = {
    b'mem_limit': re.compile(rb' [0-9]+(?:[bkmgBKMG][bB]?)?'),
    b'stop_grace_period': re.compile(rb' [0-9]+(?:ms|s|m|h)'),
    b'restart': re.compile(rb' (?:unless-stopped|always|on-failure)'),
    b'command': re.compile(rb'(?: \[(?:"[^"$\\]*"(?:, )?)*\])?'),
    b'environment': re.compile(rb''),
}
# Nested lines: command list items, and environment entries that pass through only the
# same-named, reviewed host variable (never another one, such as a database password).
COMMAND_ITEM = re.compile(rb'      [ \t]*(?:\[|\]|"[^"$\\]*",?)')
ENVIRONMENT_ITEM = re.compile(rb'      ([A-Z][A-Z0-9_]*): \$\{([A-Z][A-Z0-9_]*)(?::-)?\}')
ALLOWED_ENVIRONMENT = {b'OPENROUTER_API_KEY'}
COMMAND_VALUE = re.compile(rb'"([^"$\\]*)"')
# With the key in its environment, agentwatch must start with the judge policy that keeps the
# key on OpenRouter and caps its spending; its API has no login and cannot change these.
JUDGE_ENDPOINT = b'https://openrouter.ai/api/v1'
JUDGE_KEY_ENV = b'OPENROUTER_API_KEY'
MAX_JUDGE_DAILY = 50
MAX_ARCHIVE_BYTES = 100 * 1024 * 1024


def run(args, **kwargs):
    # Never echo expanded Compose environment or raw subprocess diagnostics.
    kwargs.setdefault('capture_output', True)
    return subprocess.run(args, check=True, **kwargs)


def compose(*args, **kwargs):
    return run(['docker', 'compose', '--project-directory', str(LIVE),
                '-p', 'hermes-companion', *args], **kwargs)


def gateway_healthy():
    # Read-only: the gateway is never stopped, recreated or retagged here.
    for _ in range(10):
        try:
            run(['curl', '--fail', '--silent', '--max-time', '3', 'http://127.0.0.1:3000/healthz'])
            return True
        except subprocess.CalledProcessError:
            time.sleep(2)
    return False


def agentwatch_healthy():
    # The image's HEALTHCHECK probes every 30 s after a 60 s start period (sooner on Docker
    # 25+, which probes every 5 s while starting); allow about 150 s.
    for _ in range(75):
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


def agentwatch_ingests():
    """Sends one labelled span and reads it back: the database is writable as configured
    (read-only root, no capabilities), which the health check alone does not show."""
    trace = secrets.token_hex(16)
    now = str(time.time_ns())
    body = json.dumps({'resourceSpans': [{
        'resource': {'attributes': [
            {'key': 'service.name', 'value': {'stringValue': 'chief-rollout-check'}}]},
        'scopeSpans': [{'spans': [{
            'traceId': trace, 'spanId': secrets.token_hex(8), 'name': 'rollout check',
            'kind': 1, 'startTimeUnixNano': now, 'endTimeUnixNano': now}]}]}]})
    run(['curl', '--fail', '--silent', '--max-time', '5', '-X', 'POST',
         '-H', 'content-type: application/json', '--data-binary', body,
         'http://127.0.0.1:4318/v1/traces'])
    run(['curl', '--fail', '--silent', '--max-time', '5',
         'http://127.0.0.1:4318/api/traces/' + trace])


def agentwatch_image_id():
    return run(['docker', 'inspect', '--format', '{{.Image}}', AGENTWATCH_CONTAINER],
               text=True).stdout.strip()


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
                    or relative.parts[0] in {'RELEASE', '.git'}
                    or any(p.startswith('.env') and p != '.env.example' for p in relative.parts)
                    or relative in seen):
                raise RuntimeError('Unsafe archive entry')
            seen.add(relative)
        archive.extractall(stage, members=members, filter='data')


def split_compose(content, which):
    """Returns (before, agentwatch block, after) for a compose.yaml with one agentwatch service."""
    starts = [match.start() for match in SERVICE_LINE.finditer(content)]
    if len(starts) != 1:
        raise RuntimeError(which + ' compose.yaml must contain exactly one agentwatch service')
    start = starts[0]
    end_match = BLOCK_END.search(content, content.index(b'\n', start) + 1)
    end = end_match.start() if end_match else len(content)
    return content[:start], content[start:end], content[end:]


def validate_command(command, environment):
    """Refuses arguments that would undo the Host guard or, with a key, the judge policy."""
    if b'*' in command:
        raise RuntimeError('agentwatch command must not allow any host')
    if b'OPENROUTER_API_KEY' not in environment:
        return

    def values(flag):
        return [command[i + 1] for i, item in enumerate(command[:-1]) if item == flag]

    if values(b'--judge-endpoint') != [JUDGE_ENDPOINT]:
        raise RuntimeError('agentwatch with a key must pin --judge-endpoint to OpenRouter')
    if values(b'--judge-key-env') != [JUDGE_KEY_ENV]:
        raise RuntimeError('agentwatch with a key must pin --judge-key-env')
    daily = values(b'--judge-max-daily')
    if (len(daily) != 1 or not daily[0].isdigit() or not 1 <= int(daily[0]) <= MAX_JUDGE_DAILY):
        raise RuntimeError('agentwatch with a key must cap --judge-max-daily at ' + str(MAX_JUDGE_DAILY))


def validate_block(block):
    """Returns the pinned image reference when the block uses only the reviewed settings."""
    keys, environment, command, image, current = [], [], [], None, None
    for line in block.split(b'\n')[1:]:
        if COMMENT_LINE.fullmatch(line):
            continue
        key_line = KEY_LINE.fullmatch(line)
        if key_line:
            current, value = key_line.groups()
            keys.append(current)
            if current == b'command':
                command.extend(COMMAND_VALUE.findall(value))
            if current == b'image':
                if not IMAGE_VALUE.fullmatch(value):
                    raise RuntimeError('agentwatch image must be pinned by digest from ' + AGENTWATCH_REPOSITORY)
                image = value.strip()
            elif current in EXACT_VALUES:
                if value != EXACT_VALUES[current]:
                    raise RuntimeError('agentwatch block must keep ' + current.decode() + ' as reviewed')
            elif current not in OPTIONAL_VALUES:
                raise RuntimeError('agentwatch block uses a setting outside the reviewed allow-list')
            elif not OPTIONAL_VALUES[current].fullmatch(value):
                raise RuntimeError('agentwatch block must keep ' + current.decode() + ' as reviewed')
            continue
        if current == b'command' and COMMAND_ITEM.fullmatch(line):
            command.extend(COMMAND_VALUE.findall(line))
            continue
        item = ENVIRONMENT_ITEM.fullmatch(line) if current == b'environment' else None
        if item:
            name, reference = item.groups()
            if name != reference or name not in ALLOWED_ENVIRONMENT:
                raise RuntimeError('agentwatch environment may only pass through reviewed variables')
            environment.append(name)
            continue
        raise RuntimeError('agentwatch block uses a setting outside the reviewed allow-list')
    if keys.count(b'image') != 1:
        raise RuntimeError('agentwatch image must be pinned by digest from ' + AGENTWATCH_REPOSITORY)
    for key in sorted(REQUIRED_KEYS):
        if keys.count(key) != 1:
            raise RuntimeError('agentwatch block must keep ' + key.decode() + ' as reviewed')
    if len(keys) != len(set(keys)) or len(environment) != len(set(environment)):
        raise RuntimeError('agentwatch block repeats a setting')
    validate_command(command, environment)
    return image.decode()


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
        raise RuntimeError('Migration set changed; this procedure permits no db/ change')
    if (stage / 'scripts/cloud-release.py').read_bytes() != (LIVE / 'scripts/cloud-release.py').read_bytes():
        raise RuntimeError('Trusted release-handler source changed; requires separate review')
    return validate_compose((LIVE / 'compose.yaml').read_bytes(), (stage / 'compose.yaml').read_bytes())


def validate_compose(live, staged):
    """Returns the new image reference; refuses any change outside the agentwatch block."""
    live_before, _, live_after = split_compose(live, 'Live')
    before, block, after = split_compose(staged, 'Staged')
    if (before, after) != (live_before, live_after):
        raise RuntimeError('Unexpected Compose change outside the agentwatch service')
    image = validate_block(block)
    if staged == live:
        raise RuntimeError('agentwatch is already up to date; nothing to do')
    return image


def main():
    if len(sys.argv) != 3 or not re.fullmatch('[0-9a-f]{40}', sys.argv[2]):
        raise RuntimeError('Usage: deploy-agentwatch-update.py <git-archive.tar> <exact reviewed main SHA>')
    archive_path, sha = sys.argv[1:]
    with open(LOCK, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with tempfile.TemporaryDirectory(prefix='companion-agentwatch-update-') as temporary:
            stage = pathlib.Path(temporary) / 'stage'
            stage.mkdir()
            unpack(archive_path, sha, stage)
            image = validate_changes(stage)
            try:
                run(['docker', 'pull', image])
            except Exception:
                raise RuntimeError('agentwatch image pull failed; nothing changed') from None
            try:
                previous = agentwatch_image_id()
            except Exception:
                raise RuntimeError('Current agentwatch container unavailable; nothing changed') from None
            if not previous:
                raise RuntimeError('Current agentwatch container unavailable; nothing changed')
            if not gateway_healthy():
                raise RuntimeError('Gateway is not healthy; inspect before updating agentwatch')
            old_compose = (LIVE / 'compose.yaml').read_bytes()
            try:
                (LIVE / 'compose.yaml').write_bytes((stage / 'compose.yaml').read_bytes())
                compose('up', '-d', '--no-deps', 'agentwatch')
                if not agentwatch_healthy():
                    raise RuntimeError('agentwatch failed startup health')
                agentwatch_ingests()
                if not gateway_healthy():
                    raise RuntimeError('Gateway health failed after the agentwatch update')
            except Exception:
                try:
                    (LIVE / 'compose.yaml').write_bytes(old_compose)
                    compose('up', '-d', '--no-deps', 'agentwatch')
                    if not agentwatch_healthy() or agentwatch_image_id() != previous:
                        raise RuntimeError('Rollback health failed')
                except Exception:
                    raise RuntimeError('Rollback needs operator inspection; gateway untouched; agentwatch volume kept') from None
                raise RuntimeError('agentwatch update failed; previous agentwatch restored') from None
            print(json.dumps({'agentwatch': image, 'healthy': True}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else 'Update failed; inspect the reviewed procedure locally', file=sys.stderr)
        sys.exit(1)
