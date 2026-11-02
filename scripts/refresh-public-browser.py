#!/usr/bin/env python3
"""Reviewed, repeatable operator refresh of the public browser and its proxy.

Run it on the host as root from the live source (docs/public-browser.md#keeping-it-current). The
ordinary release updates only the gateway, so Chromium's security fixes and changes to what these
images hold arrive here. It rebuilds both under candidate tags with a fresh base and no layer
cache, proves them in throwaway containers that share nothing with the live browser, and only
then swaps them in, so a failed proof or a busy host never touches a running task. If the swap
fails it puts the previous images back. It changes no Compose file, key or setting."""
import fcntl
import importlib.util
import json
import pathlib
import secrets
import sys

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('deploy_public_browser', HERE / 'deploy-public-browser.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

PROXY, BROWSER = 'chief-public-browser-proxy', 'chief-public-browser'
TARGETS = {PROXY: 'proxy', BROWSER: 'public-browser'}
PROBE_SECONDS = 240


def image_id(tag):
    return deploy.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', tag], text=True).stdout.strip()


def recreate():
    deploy.compose(*deploy.PROFILE, 'up', '-d', '--no-deps', '--no-build', '--force-recreate',
                   '--wait', '--wait-timeout', '120', *deploy.SERVICES)


def remove_leftovers():
    """A killed refresh (an SSH drop, say) never reached its own cleanup."""
    listed = deploy.subprocess.run(['docker', 'ps', '-aq', '--filter', 'name=pb-refresh-'],
                                   capture_output=True, text=True)
    for container in listed.stdout.split():
        deploy.subprocess.run(['docker', 'rm', '-f', container], capture_output=True)
    networks = deploy.subprocess.run(['docker', 'network', 'ls', '-q', '--filter', 'name=pb-refresh-'],
                                     capture_output=True, text=True)
    for network in networks.stdout.split():
        deploy.subprocess.run(['docker', 'network', 'rm', network], capture_output=True)


def prove():
    """The confinement probe on the candidates, with the flags Compose gives the live service.
    Returns the failed checks and the memory peak line."""
    name = 'pb-refresh-' + secrets.token_hex(4)
    inner, outer, proxy = name + '-inner', name + '-outer', name + '-proxy'
    teardown = [['docker', 'rm', '-f', proxy, name], ['docker', 'network', 'rm', inner, outer]]
    remove_leftovers()
    try:
        deploy.run(['docker', 'network', 'create', '--internal', inner])
        deploy.run(['docker', 'network', 'create', outer])
        deploy.run(['docker', 'run', '-d', '--name', proxy, '--network', inner, '--read-only',
                    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=96m',
                    '--pids-limit=64', PROXY + ':candidate'])
        deploy.run(['docker', 'network', 'connect', outer, proxy])
        result = deploy.subprocess.run(
            ['docker', 'run', '--name', name, '--init', '--network', inner, '--read-only',
             '--tmpfs', '/tmp:size=192m,mode=1777', '--shm-size=192m', '--cap-drop=ALL',
             '--security-opt=no-new-privileges',
             '--security-opt=seccomp=' + str(deploy.LIVE / 'deploy/browser/seccomp.json'),
             '--memory=640m', '--memory-swap=640m', '--cpus=1', '--pids-limit=512',
             # If the host runs short, the proof dies before the live browser or the gateway.
             '--oom-score-adj=1000',
             '--env', 'BROWSER_CONTROL_KEY=synthetic', '--env', 'BROWSER_PROXY=http://' + proxy + ':3002',
             BROWSER + ':candidate', 'node', 'public-browser-probe.mjs'],
            capture_output=True, text=True, timeout=PROBE_SECONDS)
        return deploy.probe_outcome(result.returncode, result.stdout)
    except deploy.subprocess.TimeoutExpired:
        return ['probe timed out'], ''
    finally:
        for command in teardown:
            deploy.subprocess.run(command, capture_output=True)


def chromium_version():
    """For the record only: a successful refresh must not fail on it."""
    try:
        return deploy.run(['docker', 'run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL',
                           '--entrypoint', 'chromium', BROWSER, '--version'],
                          text=True, timeout=30).stdout.strip()[:80]
    except Exception:
        return 'unknown'


def refresh():
    with open(deploy.LOCK, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        previous = {tag: image_id(tag) for tag in TARGETS}
        try:
            for tag, target in TARGETS.items():
                deploy.run(['docker', 'build', '--pull', '--no-cache', '-f',
                            str(deploy.LIVE / 'Dockerfile.browser'), '--target', target,
                            '-t', tag + ':candidate', str(deploy.LIVE)])
        except Exception:
            raise RuntimeError('Build failed; the running browser is unchanged') from None
        failed, peak = prove()
        if failed:
            raise RuntimeError('Confinement probe failed: ' + '; '.join(failed)[:400]
                               + '; the running browser is unchanged')
        # A browser task would lose its session in the swap; never cancel user work.
        deploy.require_idle()
        try:
            for tag in TARGETS:
                deploy.run(['docker', 'tag', tag + ':candidate', tag])
            recreate()
        except Exception:
            restored = deploy.rollback(
                [lambda t=tag, i=image: deploy.run(['docker', 'tag', i, t]) for tag, image in previous.items()]
                + [recreate])
            raise RuntimeError('Swap failed' + ('; previous images restored' if restored
                                                else '; rollback needs operator inspection')) from None
        return {'refreshed': True, 'probe': 'passed', 'memory': peak, 'chromium': chromium_version()}


if __name__ == '__main__':
    try:
        print(json.dumps(refresh()))
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else 'Refresh failed; inspect the reviewed procedure locally',
              file=sys.stderr)
        sys.exit(1)
