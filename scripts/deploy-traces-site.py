#!/usr/bin/env python3
"""Reviewed operator procedure: agentwatch's viewer at https://traces.52-77-47-24.sslip.io
(issue #323, docs/tracing.md#viewing-traces-from-anywhere).

Adds one Caddy site, after the live Caddyfile's existing ones, that proxies to agentwatch on
loopback and answers OTLP ingest (/v1/*) with 404: Chief exports over the Compose network, so
ingest never needs the internet. It refuses unless agentwatch on 127.0.0.1:4318 already
requires signing in, so the site never serves traces without it. The candidate is validated
beside the live file, Caddy is reloaded, and the site is checked through Caddy (with the
certificate Caddy obtains for the name); the existing site is checked too. On any failure the
previous Caddyfile is restored and reloaded. `--remove` takes the site down: it needs no
check first, and once the site is gone it never puts it back, even if a later check fails.

No application, Compose or database change. Run from a checkout of the reviewed main:
    sudo python3 scripts/deploy-traces-site.py [--remove]
"""
import fcntl
import json
import pathlib
import subprocess
import sys
import time

LOCK = pathlib.Path('/var/lock/companion-release.lock')
CADDYFILE = pathlib.Path('/etc/caddy/Caddyfile')
BACKUP = CADDYFILE.with_name('Caddyfile.before-traces')
HOST = 'traces.52-77-47-24.sslip.io'
EXISTING = 'companion.52-77-47-24.sslip.io'
# Kept byte for byte in ops/oauth-site/Caddyfile, the reviewed copy (scripts/test-deploy-traces-site.py).
SITE = (
    '\n'
    '# agentwatch, the trace viewer (docs/tracing.md#viewing-traces-from-anywhere). agentwatch\n'
    '# requires signing in; OTLP ingest stays on the Compose network.\n'
    'traces.52-77-47-24.sslip.io {\n'
    '  header {\n'
    '    -Server\n'
    '    # Not no-referrer: under it browsers send `Origin: null` with writes and the sign-in\n'
    '    # form, which agentwatch refuses as cross-site.\n'
    '    Referrer-Policy same-origin\n'
    '    X-Content-Type-Options nosniff\n'
    '    X-Frame-Options DENY\n'
    '    Strict-Transport-Security "max-age=31536000"\n'
    '  }\n'
    '  header /api/* Cache-Control no-store\n'
    '  @ingest path /v1/*\n'
    '  handle @ingest {\n'
    '    respond "Not found" 404\n'
    '  }\n'
    '  handle {\n'
    '    reverse_proxy 127.0.0.1:4318\n'
    '  }\n'
    '}\n'
)
# A new name's certificate can take a minute or two to arrive after the reload.
CHECK_ATTEMPTS = 40
CHECK_PAUSE_S = 3


def run(args, **kwargs):
    kwargs.setdefault('capture_output', True)
    return subprocess.run(args, check=True, **kwargs)


def fetch(url, *extra, host=HOST):
    """(status, headers and body) through the local Caddy, or (0, '') when it cannot connect."""
    result = subprocess.run(
        ['curl', '--silent', '--max-time', '10', '--resolve', host + ':443:127.0.0.1',
         '--include', '--output', '-', '--write-out', '\n%{http_code}', *extra, url],
        capture_output=True, text=True)
    text, _, code = result.stdout.rpartition('\n')
    return (int(code) if code.isdigit() else 0), text


def agentwatch_requires_signing_in():
    try:
        answer = run(['curl', '--fail', '--silent', '--max-time', '5',
                      'http://127.0.0.1:4318/api/auth/session'], text=True).stdout
        return json.loads(answer).get('auth') is True
    except Exception:
        return False


def site_serves():
    """The new site answers as reviewed: sign-in first, no data without it, no ingest."""
    base = 'https://' + HOST
    for _ in range(CHECK_ATTEMPTS):
        status, _ = fetch(base + '/healthz')
        if status == 200:
            break
        time.sleep(CHECK_PAUSE_S)
    else:
        return False
    health, health_text = fetch(base + '/healthz')
    page, page_text = fetch(base + '/')
    data, _ = fetch(base + '/api/traces')
    ingest, _ = fetch(base + '/v1/traces', '-X', 'POST', '-H', 'content-type: application/json',
                      '--data-binary', '{}')
    login, login_text = fetch(base + '/login')
    head = login_text.lower()
    return (health == 200 and health_text.rstrip().endswith('{"ok":true}')
            and page == 303 and 'location: /login' in page_text.lower()
            and data == 401 and ingest == 404 and login == 200
            and 'x-frame-options: deny' in head and 'strict-transport-security:' in head
            and 'referrer-policy: same-origin' in head)


def existing_site_serves():
    """The Mini App's site still redirects its root, as before."""
    status, text = fetch('https://' + EXISTING + '/', host=EXISTING)
    return status == 302 and 'location: /miniapp/' in text.lower()


def candidate(original, remove):
    if remove:
        if original.count(SITE) != 1:
            raise RuntimeError('The live Caddyfile does not hold the reviewed traces site; nothing changed')
        return original.replace(SITE, '')
    if HOST in original:
        raise RuntimeError('The live Caddyfile already names ' + HOST + '; nothing changed')
    if original.count(EXISTING + ' {') != 1:
        raise RuntimeError('The live Caddyfile does not hold the reviewed site; nothing changed')
    return original.rstrip('\n') + '\n' + SITE


def validate(text):
    """Validates beside the live file, so any relative imports resolve as they will live."""
    staged = CADDYFILE.with_name('.Caddyfile.traces-candidate')
    try:
        staged.write_text(text)
        run(['caddy', 'validate', '--config', str(staged), '--adapter', 'caddyfile'])
    finally:
        staged.unlink(missing_ok=True)


def main():
    if sys.argv[1:] not in ([], ['--remove']):
        raise RuntimeError('Usage: deploy-traces-site.py [--remove]')
    remove = sys.argv[1:] == ['--remove']
    with open(LOCK, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if not remove and not agentwatch_requires_signing_in():
            raise RuntimeError('agentwatch does not require signing in yet; update it first. Nothing changed')
        original = CADDYFILE.read_text()
        text = candidate(original, remove)
        try:
            validate(text)
        except Exception:
            raise RuntimeError('The candidate Caddyfile failed validation; nothing changed') from None
        if not remove and not existing_site_serves():
            raise RuntimeError('The existing site is not answering as expected; inspect before changing Caddy')
        if remove:
            # A takedown: restoring on a failed check would put the traces back on the internet.
            BACKUP.write_text(original)
            CADDYFILE.write_text(text)
            try:
                run(['systemctl', 'reload', 'caddy'])
            except Exception:
                raise RuntimeError('The site is out of the Caddyfile but Caddy did not reload; '
                                   'run systemctl reload caddy and inspect') from None
            gone, _ = fetch('https://' + HOST + '/healthz')
            if gone:
                raise RuntimeError('The site is out of the Caddyfile but still answers (HTTP ' + str(gone) +
                                   '); inspect Caddy')
            state = 'removed' if existing_site_serves() else 'removed; the existing site is not answering, inspect it'
            print(json.dumps({'site': HOST, 'state': state}))
            return
        try:
            BACKUP.write_text(original)
            CADDYFILE.write_text(text)
            run(['systemctl', 'reload', 'caddy'])
            if not site_serves():
                raise RuntimeError('site check failed')
            if not existing_site_serves():
                raise RuntimeError('existing site check failed')
        except Exception:
            try:
                CADDYFILE.write_text(original)
                run(['systemctl', 'reload', 'caddy'])
            except Exception:
                raise RuntimeError('The change failed and restoring the previous Caddyfile also failed; '
                                   'inspect /etc/caddy/Caddyfile and ' + BACKUP.name) from None
            raise RuntimeError('The change failed its checks; the previous Caddyfile was restored') from None
        print(json.dumps({'site': HOST, 'state': 'serving'}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else 'Failed; inspect the reviewed procedure locally',
              file=sys.stderr)
        sys.exit(1)
