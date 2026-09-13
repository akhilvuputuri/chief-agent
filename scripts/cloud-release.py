#!/usr/bin/env python3
"""Root-owned SSH entrypoint. Never execute SSH_ORIGINAL_COMMAND as shell text."""
import fcntl, hashlib, io, json, os, pathlib, re, shutil, subprocess, sys, tarfile, tempfile, time
LIVE = pathlib.Path('/opt/hermes-companion')
IMAGE = 'hermes-companion-gateway'

def run(args, **kw):
    return subprocess.run(args, check=True, **kw)

def compose(*args, **kw):
    return run(['docker', 'compose', '--project-directory', str(LIVE), '-p', 'hermes-companion', *args], **kw)

def query(sql):
    code = "import pg from 'pg';const d=new pg.Pool({connectionString:process.env.DATABASE_URL});try{console.log(JSON.stringify((await d.query("+json.dumps(sql)+")).rows))}finally{await d.end()}"
    return json.loads(compose('exec', '-T', 'gateway', 'node', '--input-type=module', input=code, text=True, capture_output=True).stdout)

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
    command = os.environ.get('SSH_ORIGINAL_COMMAND', '')
    if command == 'diagnose':
        print(json.dumps({'release': (LIVE/'RELEASE').read_text().strip(), 'runs': query("SELECT id,state,stop_reason,model,used_models,used_tools,used_ms,started_at FROM runtime_runs ORDER BY started_at DESC LIMIT 15"), 'model_failures': query("SELECT run_id,created_at,data FROM events WHERE type='model.failed' ORDER BY created_at DESC LIMIT 15"), 'tools': query("SELECT operation,state,count(*)::int FROM runtime_calls WHERE started_at > now()-interval '24 hours' GROUP BY operation,state"), 'costs': query("SELECT run_id,count(*)::int requests,sum(actual_usd) reported_usd,count(*) FILTER(WHERE actual_usd IS NULL)::int unknown_charges FROM provider_charges WHERE created_at > now()-interval '24 hours' GROUP BY run_id"), 'research': query("SELECT e.run_id child_run_id,e.data->>'parentRunId' parent_run_id,r.state,r.stop_reason,r.used_models,r.used_tools,r.used_ms,r.started_at FROM events e JOIN runtime_runs r ON r.id=e.run_id AND r.user_id=e.user_id WHERE e.type='research.child_started' AND e.created_at > now()-interval '7 days' ORDER BY e.created_at DESC LIMIT 100"), 'telegram_delivery': query("SELECT data->>'kind' kind,count(*)::int replies,sum((data->>'messages')::int)::int messages,sum((data->>'legacyChunks')::int)::int legacy_chunks,sum((data->>'noticeMessages')::int)::int notice_messages,count(DISTINCT run_id)::int delivery_groups FROM events WHERE type='telegram.delivered' AND created_at>now()-interval '7 days' GROUP BY data->>'kind'"), 'telegram_views': query("SELECT type,count(*)::int events,round(avg((data->>'firstTapMs')::numeric)) first_tap_ms FROM events WHERE type IN ('telegram.view_opened','telegram.view_tapped','telegram.view_failed') AND created_at>now()-interval '7 days' GROUP BY type"), 'canvases': query("SELECT type,count(*)::int events,count(DISTINCT run_id)::int runs FROM events WHERE type IN ('canvas.revised','canvas.read','canvas.viewed','canvas.conflict') AND created_at>now()-interval '7 days' GROUP BY type"), 'jobs': query('SELECT status,count(*)::int FROM jobs GROUP BY status')}))
        return
    match = re.fullmatch(r'deploy ([0-9a-f]{40})', command)
    if not match:
        raise RuntimeError('Only deploy <40-character SHA> and diagnose are permitted')
    sha = match.group(1)
    with open('/var/lock/companion-release.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        payload = sys.stdin.buffer.read(100*1024*1024+1)
        if len(payload)>100*1024*1024:
            raise RuntimeError('Release archive too large')
        with tempfile.TemporaryDirectory(prefix='companion-release-') as tmp:
            stage = pathlib.Path(tmp)
            with tarfile.open(fileobj=io.BytesIO(payload)) as archive:
                members = archive.getmembers()
                for m in members:
                    path = pathlib.PurePosixPath(m.name)
                    if path.is_absolute() or '..' in path.parts or not (m.isfile() or m.isdir()) or any(p.startswith('.env') and p != '.env.example' for p in path.parts):
                        raise RuntimeError('Unsafe archive entry')
                archive.extractall(stage, members=members, filter='data')
            for name in ['Dockerfile', 'package.json', 'compose.yaml', 'src/main.ts']:
                if not (stage/name).is_file():
                    raise RuntimeError('Incomplete source archive')
            # Database and infrastructure changes need an explicit migration procedure.
            for relative in ['compose.yaml', 'db']:
                def hashes(root):
                    files = [root] if root.is_file() else sorted(root.rglob('*'))
                    return [(str(p.relative_to(root.parent if root.is_file() else root)), hashlib.sha256(p.read_bytes()).hexdigest()) for p in files if p.is_file()]
                if hashes(stage/relative) != hashes(LIVE/relative):
                    raise RuntimeError('Database or Compose change requires a reviewed migration/deployment procedure')
            candidate = IMAGE+':'+sha
            build = subprocess.run(['docker','build','-t',candidate,str(stage)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            if build.returncode:
                raise RuntimeError('Image build failed; production unchanged. Reproduce Docker build in CI.')
            active = query("SELECT count(*)::int n FROM runtime_runs WHERE state='running'")[0]['n']
            if active:
                raise RuntimeError('Active agent work detected; retry deployment when idle')
            previous = compose('images','-q','gateway',text=True,capture_output=True).stdout.strip()
            if not previous:
                raise RuntimeError('Cannot establish rollback image')
            run(['docker','tag',previous,IMAGE+':rollback'])
            run(['docker','tag',candidate,IMAGE+':latest'])
            try:
                compose('up','-d','--no-deps','--no-build','gateway')
                if not healthy():
                    raise RuntimeError('Candidate failed health checks')
            except Exception:
                run(['docker','tag',IMAGE+':rollback',IMAGE+':latest'])
                compose('up','-d','--no-deps','--no-build','gateway')
                if not healthy():
                    raise RuntimeError('Deployment and rollback health checks failed; operator intervention required')
                raise RuntimeError('Candidate failed; previous image restored and healthy')
            # Update source and release marker only after the candidate is healthy.
            for item in stage.iterdir():
                dest=LIVE/item.name
                if item.is_dir():
                    if dest.exists(): shutil.rmtree(dest)
                    shutil.copytree(item,dest)
                else: shutil.copy2(item,dest)
            (LIVE/'RELEASE').write_text(sha+'\n')
            print(json.dumps({'deployed':sha,'healthy':True}))

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
