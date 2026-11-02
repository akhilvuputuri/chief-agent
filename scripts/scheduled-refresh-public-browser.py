#!/usr/bin/env python3
"""Daily timer target that keeps the public browser about a month old (docs/public-browser.md#keeping-it-current).

It does nothing until the image the browser is running is DUE_DAYS old, so a manual refresh also resets the clock.
A refresh refused for other work tries again at the next tick; after STALE_DAYS that counts as a
failure, so a stuck run cannot hide it for ever. Any failure, including this script being killed,
exits non-zero and systemd's OnFailure runs --notify, which sends the owner one Telegram message.
--now ignores the age, for a Chromium advisory, and prints the same disk figures."""
import datetime
import fcntl
import importlib.util
import json
import pathlib
import shutil
import sys
import urllib.parse
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('refresh_public_browser', HERE / 'refresh-public-browser.py')
refresh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refresh)
deploy = refresh.deploy

STATE = pathlib.Path('/var/lib/chief/public-browser-refresh.json')
CONTAINER = 'hermes-companion-public-browser-1'
DUE_DAYS = 28
STALE_DAYS = 35
# One refresh measured at most 3.2 GB; the rest keeps room for Postgres and backups.
MIN_FREE_BYTES = 8 * 1024 ** 3
REPEAT_NOTICE = datetime.timedelta(days=7)
# A recorded failure older than this cannot belong to the run that just stopped; ticks are a day apart.
FRESH_FAILURE = datetime.timedelta(hours=6)
UNFINISHED = 'The scheduled run did not finish: killed, timed out or never started. Check for leftovers'


def now():
    return datetime.datetime.now(datetime.timezone.utc)


def read_state():
    """Damaged state must never stop a refresh or its notice, so it reads as empty."""
    try:
        state = json.loads(STATE.read_text())
    except (OSError, ValueError):
        return {}
    return state if isinstance(state, dict) else {}


def write_state(state):
    """Best effort: on a full disk the notice still goes, reporting an unfinished run."""
    try:
        pending = STATE.with_suffix('.pending')
        pending.write_text(json.dumps(state))
        pending.replace(STATE)
    except OSError:
        print('State not saved', file=sys.stderr)


def within(record, limit):
    """Whether a saved {'at': ...} record is recent; anything malformed is not."""
    try:
        return now() - datetime.datetime.fromisoformat(record['at']) < limit
    except (KeyError, TypeError, ValueError):
        return False


def env_value(name):
    """One named value; never hand .env to anything that could print it."""
    value = None
    for line in (deploy.LIVE / '.env').read_text().splitlines():
        line = line.removeprefix('export ')
        if line.startswith(name + '='):
            value = line.split('=', 1)[1].split(' #')[0].strip().strip('"\'')
    return value


def age_days():
    """From the container, not the tag: a swap killed halfway leaves a new tag on an old browser."""
    image = deploy.run(['docker', 'inspect', '--format', '{{.Image}}', CONTAINER], text=True).stdout.strip()
    created = deploy.run(['docker', 'image', 'inspect', '--format', '{{.Created}}', image],
                         text=True).stdout.strip()
    return (now() - datetime.datetime.fromisoformat(created)).total_seconds() / 86400


def running():
    result = deploy.subprocess.run(['docker', 'inspect', '--format', '{{.State.Running}}', CONTAINER],
                                   capture_output=True, text=True)
    return result.stdout.strip() == 'true'


def used():
    return shutil.disk_usage('/').used


def free():
    return shutil.disk_usage('/').free


def prune():
    """Under the release lock, because a prune must not race a release's pull or build. It is best
    effort as in cloud-release.py: a lost lock means a release, which prunes for itself. Tagged
    images are untouched, so this keeps :rollback. All cache goes, since the refresh never reuses
    it; the only cost is a slower next operator build."""
    with open(deploy.LOCK, 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        deploy.subprocess.run(['docker', 'image', 'prune', '-f'], capture_output=True)
        deploy.subprocess.run(['docker', 'builder', 'prune', '-af'], capture_output=True)


def busy(age, reason):
    if age >= STALE_DAYS:
        raise RuntimeError(f'Over {STALE_DAYS} days old and the host stays busy: {reason}')
    print(json.dumps({'outcome': 'busy', 'ageDays': round(age, 1), 'reason': reason}))


def run(force=False):
    if env_value('PUBLIC_BROWSER') != 'on':
        print(json.dumps({'outcome': 'off'}))
        return
    # The refresh would start a stopped service, which could be an operator's deliberate stop.
    if not running():
        raise RuntimeError('The flag is on but the browser is not running; not refreshing it')
    age = age_days()
    if age < DUE_DAYS and not force:
        print(json.dumps({'outcome': 'not due', 'ageDays': round(age, 1)}))
        return
    if free() < MIN_FREE_BYTES:
        prune()
        if free() < MIN_FREE_BYTES:
            raise RuntimeError(f'Under {MIN_FREE_BYTES // 1024 ** 3} GB free; refused to build')
    # Refused here it costs nothing; the refresh checks again after its builds.
    try:
        deploy.require_idle()
    except RuntimeError as error:
        busy(age, str(error))
        return
    before = used()
    try:
        result = refresh.refresh()
    except refresh.Busy as error:
        prune()
        busy(age, str(error))
        return
    except Exception:
        prune()
        raise
    after = used()
    prune()
    print(json.dumps({**result, 'disk': {'before': before, 'afterRefresh': after, 'afterPrune': used()}}))


def scheduled(force=False):
    try:
        run(force)
    except Exception as error:
        reason = str(error) if isinstance(error, RuntimeError) else f'Refresh stopped on {type(error).__name__}'
        write_state({**read_state(), 'failure': {'reason': reason, 'at': now().isoformat()}})
        print(reason, file=sys.stderr)
        return 1
    write_state({})
    return 0


def send(text):
    token = env_value('TELEGRAM_BOT_TOKEN')
    chat = (env_value('TELEGRAM_ALLOWED_USER_IDS') or '').split(',')[0]
    body = urllib.parse.urlencode({'chat_id': chat, 'text': text}).encode()
    # POST with no logging of the URL: it holds the token, and urllib's errors do not.
    with urllib.request.urlopen('https://api.telegram.org/bot' + str(token) + '/sendMessage',
                                data=body, timeout=20) as response:
        if response.status != 200:
            raise RuntimeError('Telegram refused the notice')


def notify():
    """Reasons hold no daily figures, so the same failure is sent once a week though it retries
    daily. Sent straight to Telegram, so it still arrives when the gateway is the thing that is
    down. A failed send exits non-zero and the unit retries it."""
    state = read_state()
    failure = state.get('failure')
    reason = failure.get('reason') if isinstance(failure, dict) and within(failure, FRESH_FAILURE) else None
    reason = reason or UNFINISHED
    notified = state.get('notified')
    if isinstance(notified, dict) and notified.get('reason') == reason and within(notified, REPEAT_NOTICE):
        print(json.dumps({'notice': 'repeat withheld'}))
        return 0
    try:
        send('Public browser refresh failed: ' + reason
             + '\nIt retries daily. Details: journalctl -u chief-public-browser-refresh')
    except Exception as error:
        print('Notice not sent: ' + type(error).__name__, file=sys.stderr)
        return 1
    write_state({**state, 'notified': {'reason': reason, 'at': now().isoformat()}})
    print(json.dumps({'notice': 'sent'}))
    return 0


def test_notice():
    try:
        send('Public browser refresh: test notice, nothing is wrong.')
    except Exception as error:
        print('Notice not sent: ' + type(error).__name__, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    actions = {'--notify': notify, '--test-notice': test_notice, '--now': lambda: scheduled(force=True)}
    if len(sys.argv) > 2 or (len(sys.argv) == 2 and sys.argv[1] not in actions):
        sys.exit('Usage: scheduled-refresh-public-browser.py [' + ' | '.join(actions) + ']')
    sys.exit(actions[sys.argv[1]]() if len(sys.argv) == 2 else scheduled())
