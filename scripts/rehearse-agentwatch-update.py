#!/usr/bin/env python3
"""Rehearses the agentwatch update's copy and rollback (deploy-agentwatch-update.py) with two
real images on a throwaway volume, on any machine with Docker. Not for the production host:
it is how a change to the copy scripts, or an image that changes the database format, is
tried before the reviewed procedure runs there.

    python3 scripts/rehearse-agentwatch-update.py <old image> <new image> <empty work directory>

It starts the old image on a new volume and records a trace; stops it, plants the scratch
directories a killed agentwatch leaves, and makes the copy with the procedure's own `back_up`;
starts the new image, records another trace and kills it; shows whether the old image can
open what the new one left; restores with the procedure's own `restore`; and starts the old
image again. It prints each step. It removes the container and volume it made.
"""
import importlib.util, json, pathlib, shutil, subprocess, sys, time

if len(sys.argv) != 4:
    raise SystemExit(__doc__)
OLD, NEW, WORK = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])
SCRIPT = pathlib.Path(__file__).with_name('deploy-agentwatch-update.py')
spec = importlib.util.spec_from_file_location('update', SCRIPT)
u = importlib.util.module_from_spec(spec); spec.loader.exec_module(u)
VOLUME, NAME = 'aw-dryrun-data', 'aw-dryrun'
u.DATA_VOLUME, u.BACKUPS = VOLUME, WORK / 'backups'

def sh(*args, check=True):
    done = subprocess.run(args, capture_output=True, text=True)
    if check and done.returncode:
        raise SystemExit(f'{args[:4]} failed: {done.stderr.strip()[-400:]}')
    return done

def start(image):
    sh('docker', 'rm', '-f', NAME, check=False)
    sh('docker', 'run', '-d', '--name', NAME, '--volume', VOLUME + ':/data', '--read-only', '--tmpfs', '/tmp',
       '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', image,
       'serve', '--host', '0.0.0.0', '--allow-host', 'localhost', '--memory-limit', '256MB')
    for _ in range(60):
        state = sh('docker', 'inspect', '--format', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}', NAME).stdout.split()
        if state[0] != 'running':
            return False
        if ask('/healthz') is not None:
            return True
        time.sleep(1)
    return False

def ask(path, body=None):
    code = ('import json,sys,urllib.request\n'
            f'r=urllib.request.Request("http://127.0.0.1:4318{path}"' + (', data=sys.stdin.buffer.read(), headers={"content-type":"application/json"}' if body else '') + ')\n'
            'print(urllib.request.urlopen(r, timeout=5).read().decode())')
    done = subprocess.run(['docker', 'exec', '-i', NAME, 'python', '-c', code], input=body, capture_output=True, text=True)
    return done.stdout if done.returncode == 0 else None

def span(name):
    now = str(time.time_ns())
    return json.dumps({'resourceSpans': [{'resource': {'attributes': [{'key': 'service.name', 'value': {'stringValue': 'dryrun'}}]},
        'scopeSpans': [{'spans': [{'traceId': name * 32, 'spanId': name * 16, 'name': 'rehearsal ' + name, 'kind': 1,
                                   'startTimeUnixNano': now, 'endTimeUnixNano': now}]}]}]})

def traces():
    return sorted(t['root_name'] for t in json.loads(ask('/api/traces'))['traces'])

def listing():
    return sh('docker', 'run', '--rm', '--network', 'none', '--volume', VOLUME + ':/data:ro', '--entrypoint', 'sh',
              '--user', '0:0', OLD, '-c', 'cd /data && ls -lnA | tail -n +2 | awk \'{print $1, $3, $4, $9}\'').stdout.strip()

def as_root(script):
    sh('docker', 'run', '--rm', '--network', 'none', '--volume', VOLUME + ':/data', '--user', '0:0', '--entrypoint', 'sh', OLD, '-c', script)

sh('docker', 'rm', '-f', NAME, check=False); sh('docker', 'volume', 'rm', '-f', VOLUME, check=False)
shutil.rmtree(WORK / 'backups', ignore_errors=True)
sh('docker', 'volume', 'create', VOLUME)
print('1 old image starts on an empty volume:', start(OLD))
ask('/v1/traces', span('a'))
print('  traces:', traces())
image_id = sh('docker', 'inspect', '--format', '{{.Image}}', NAME).stdout.strip()
print('  previous image id:', image_id[:19])
sh('docker', 'stop', '--time', '15', NAME)
# What a killed agentwatch can leave behind.
as_root('mkdir -p /data/agentwatch.duckdb.tmp /data/agentwatch-ab12 && echo x > /data/agentwatch.duckdb.tmp/spill && chown -R 10001:999 /data/agentwatch.duckdb.tmp /data/agentwatch-ab12')
print('  volume before the copy:\n   ', listing().replace('\n', '\n    '))
backup = u.back_up(image_id, 'a' * 40)
print('2 copy made:', backup.name, sorted(p.name for p in backup.iterdir()), oct(backup.stat().st_mode & 0o777), oct(u.BACKUPS.stat().st_mode & 0o777))
print('3 new image starts and upgrades the database:', start(NEW))
ask('/v1/traces', span('b'))
print('  traces:', traces(), '| alerts API answers:', ask('/api/alerts') is not None)
sh('docker', 'kill', NAME)  # unclean, as at the end of a grace period
as_root('mkdir -p /data/agentwatch-cd34 && echo y > /data/agentwatch-cd34/part')
print('  volume after the new image was killed:\n   ', listing().replace('\n', '\n    '))
print('4 the premise, old image on the upgraded database:', 'starts' if start(OLD) else 'REFUSES',
      '|', sh('docker', 'logs', NAME, check=False).stderr.strip().splitlines()[-1][:110])
sh('docker', 'rm', '-f', NAME)
u.restore(image_id, backup)
print('5 volume after the restore:\n   ', listing().replace('\n', '\n    '))
print('6 old image starts on the restored data:', start(OLD))
print('  traces:', traces())
sh('docker', 'rm', '-f', NAME); sh('docker', 'volume', 'rm', VOLUME)
# A volume that does not exist is refused, not created.
try:
    u.back_up(image_id, 'b' * 40); print('7 missing volume: COPIED (wrong)')
except subprocess.CalledProcessError:
    print('7 missing volume: refused;', 'volume created' if sh('docker', 'volume', 'inspect', VOLUME, check=False).returncode == 0 else 'no volume created',
          '| leftovers:', sorted(p.name for p in u.BACKUPS.iterdir()))
shutil.rmtree(WORK / 'backups', ignore_errors=True)
