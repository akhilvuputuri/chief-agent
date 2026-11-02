#!/usr/bin/env python3
"""Offline tests of the scheduled refresh: nothing here touches Docker, Telegram or the host."""
import datetime
import importlib.util
import json
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'scheduled_refresh', pathlib.Path(__file__).with_name('scheduled-refresh-public-browser.py'))
scheduled = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scheduled)
ROOT = pathlib.Path(__file__).resolve().parent.parent
GB = 1024 ** 3
REAL_SEND = scheduled.send


class Base(unittest.TestCase):
    def setUp(self):
        self.home = pathlib.Path(tempfile.mkdtemp())
        (self.home / '.env').write_text(
            'PUBLIC_BROWSER=on\nTELEGRAM_BOT_TOKEN=secret-token\nTELEGRAM_ALLOWED_USER_IDS=42,43\n')
        self.calls = []
        self.age = 30
        self.running = 'true'
        self.free = 20 * GB
        self.refresh_outcome = {'refreshed': True}
        self.sent = []
        for item in [
            patch.object(scheduled, 'STATE', self.home / 'state.json'),
            patch.object(scheduled.deploy, 'LIVE', self.home),
            patch.object(scheduled.deploy, 'LOCK', self.home / 'lock'),
            patch.object(scheduled.deploy, 'sql', return_value='0'),
            patch.object(scheduled.deploy, 'run', side_effect=self.inspect_image),
            patch.object(scheduled.deploy.subprocess, 'run', side_effect=self.process),
            patch.object(scheduled.refresh, 'refresh', side_effect=self.do_refresh),
            patch.object(scheduled.shutil, 'disk_usage', side_effect=self.disk),
            patch.object(scheduled, 'send', side_effect=self.sent.append),
        ]:
            item.start()
            self.addCleanup(item.stop)

    def disk(self, _):
        return type('Usage', (), {'used': 30 * GB, 'free': self.free})

    def inspect_image(self, args, **_):
        created = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=self.age)
        return subprocess.CompletedProcess(args, 0, stdout=created.isoformat().replace('+00:00', 'Z'), stderr='')

    def process(self, args, **_):
        self.calls.append(args)
        return subprocess.CompletedProcess(args, 0, stdout=self.running + '\n', stderr='')

    def do_refresh(self):
        self.calls.append(['refresh'])
        if isinstance(self.refresh_outcome, Exception):
            raise self.refresh_outcome
        return self.refresh_outcome

    def refreshed(self):
        return ['refresh'] in self.calls

    def pruned(self):
        return ['docker', 'image', 'prune', '-f'] in self.calls


class Schedule(Base):
    def test_a_young_image_is_left_alone(self):
        self.age = 27
        self.assertEqual(scheduled.scheduled(), 0)
        self.assertFalse(self.refreshed())
        self.assertFalse(self.pruned())

    def test_now_refreshes_a_young_image_and_still_checks_for_work(self):
        self.age = 1
        self.assertEqual(scheduled.scheduled(force=True), 0)
        self.assertTrue(self.refreshed())
        self.calls.clear()
        with patch.object(scheduled.deploy, 'sql', return_value='1'):
            self.assertEqual(scheduled.scheduled(force=True), 0)
        self.assertFalse(self.refreshed())

    def test_a_due_image_is_refreshed_then_pruned(self):
        self.assertEqual(scheduled.scheduled(), 0)
        self.assertLess(self.calls.index(['refresh']), self.calls.index(['docker', 'image', 'prune', '-f']))
        self.assertIn(['docker', 'builder', 'prune', '-af'], self.calls)

    def test_the_prune_never_reaches_tagged_images_such_as_rollback(self):
        scheduled.scheduled()
        prunes = [c for c in self.calls if 'prune' in c]
        self.assertTrue(prunes)
        self.assertFalse([c for c in prunes if c[1] == 'image' and ('-a' in c or '-af' in c)])
        self.assertFalse([c for c in self.calls if c[:2] in (['docker', 'rmi'], ['docker', 'system'])])

    def test_the_off_flag_is_respected_whatever_the_age(self):
        (self.home / '.env').write_text('PUBLIC_BROWSER=off\n')
        self.age = 400
        self.assertEqual(scheduled.scheduled(), 0)
        self.assertFalse(self.refreshed())

    def test_a_stopped_service_is_reported_not_started(self):
        self.running = 'false'
        self.assertEqual(scheduled.scheduled(), 1)
        self.assertFalse(self.refreshed())
        self.assertIn('not running', scheduled.read_state()['failure'])

    def test_a_short_disk_prunes_then_refuses_to_build(self):
        self.free = 5 * GB
        self.assertEqual(scheduled.scheduled(), 1)
        self.assertTrue(self.pruned())
        self.assertFalse(self.refreshed())
        self.assertIn('GB free', scheduled.read_state()['failure'])


class Retry(Base):
    def test_busy_before_building_costs_nothing_and_exits_clean(self):
        with patch.object(scheduled.deploy, 'sql', return_value='1'):
            self.assertEqual(scheduled.scheduled(), 0)
        self.assertFalse(self.refreshed())
        self.assertNotIn('failure', scheduled.read_state())

    def test_busy_at_the_swap_prunes_and_exits_clean(self):
        self.refresh_outcome = scheduled.refresh.Busy('Active work; retry when idle')
        self.assertEqual(scheduled.scheduled(), 0)
        self.assertTrue(self.pruned())

    def test_busy_past_the_limit_becomes_a_failure(self):
        self.age = 36
        self.refresh_outcome = scheduled.refresh.Busy('A release holds the lock')
        self.assertEqual(scheduled.scheduled(), 1)
        self.assertIn('stays busy', scheduled.read_state()['failure'])

    def test_a_stuck_idle_check_also_reaches_the_limit(self):
        self.age = 36
        with patch.object(scheduled.deploy, 'sql', return_value='1'):
            self.assertEqual(scheduled.scheduled(), 1)

    def test_a_real_failure_is_kept_for_the_notice_and_still_pruned(self):
        self.refresh_outcome = RuntimeError('Confinement probe failed: x; the running browser is unchanged')
        self.assertEqual(scheduled.scheduled(), 1)
        self.assertTrue(self.pruned())
        self.assertIn('Confinement probe failed', scheduled.read_state()['failure'])

    def test_an_unexpected_error_gives_no_raw_detail(self):
        self.refresh_outcome = subprocess.CalledProcessError(1, ['docker', 'secret-arg'])
        self.assertEqual(scheduled.scheduled(), 1)
        self.assertNotIn('secret-arg', json.dumps(scheduled.read_state()))


class Notice(Base):
    def test_the_failure_reason_reaches_the_owner(self):
        scheduled.write_state({'failure': 'Build failed; the running browser is unchanged'})
        self.assertEqual(scheduled.notify(), 0)
        self.assertEqual(len(self.sent), 1)
        self.assertIn('Build failed', self.sent[0])

    def test_a_killed_run_left_no_reason_and_still_notifies(self):
        self.age = 30
        with patch.object(scheduled, 'run', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                scheduled.scheduled()
        scheduled.notify()
        self.assertIn('killed', self.sent[0])

    def test_a_stale_failure_cannot_explain_a_later_kill(self):
        scheduled.write_state({'failure': 'old reason'})
        with patch.object(scheduled, 'run', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                scheduled.scheduled()
        scheduled.notify()
        self.assertNotIn('old reason', self.sent[0])

    def test_the_same_failure_is_sent_once_a_week(self):
        for _ in range(3):
            scheduled.write_state({**scheduled.read_state(), 'failure': 'same'})
            scheduled.notify()
        self.assertEqual(len(self.sent), 1)
        state = scheduled.read_state()
        old = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=8)
        state['notified']['at'] = old.isoformat()
        scheduled.write_state(state)
        scheduled.notify()
        self.assertEqual(len(self.sent), 2)

    def test_a_different_failure_is_sent_at_once(self):
        scheduled.write_state({'failure': 'one'})
        scheduled.notify()
        scheduled.write_state({**scheduled.read_state(), 'failure': 'two'})
        scheduled.notify()
        self.assertEqual(len(self.sent), 2)

    def test_success_rearms_the_notice(self):
        scheduled.write_state({'failure': 'one'})
        scheduled.notify()
        self.assertEqual(scheduled.scheduled(), 0)
        scheduled.write_state({**scheduled.read_state(), 'failure': 'one'})
        scheduled.notify()
        self.assertEqual(len(self.sent), 2)

    def test_a_refused_notice_fails_without_marking_it_sent(self):
        scheduled.write_state({'failure': 'one'})
        with patch.object(scheduled, 'send', side_effect=OSError('x')):
            self.assertEqual(scheduled.notify(), 1)
        self.assertNotIn('notified', scheduled.read_state())


class Send(Base):
    def test_it_uses_the_first_owner_and_never_prints_the_token(self):
        captured = {}

        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *_): return False

        def urlopen(url, data, timeout):
            captured.update(url=url, data=data.decode(), timeout=timeout)
            return Response()
        with patch.object(scheduled.urllib.request, 'urlopen', side_effect=urlopen):
            REAL_SEND('hello there')
        self.assertIn('chat_id=42', captured['data'])
        self.assertNotIn('secret-token', captured['data'])
        self.assertTrue(captured['url'].endswith('/botsecret-token/sendMessage'))


class Units(unittest.TestCase):
    def read(self, name):
        return (ROOT / 'deploy/lightsail' / name).read_text()

    def test_any_failure_reaches_the_notice_unit(self):
        self.assertIn('OnFailure=chief-public-browser-refresh-notify.service',
                      self.read('chief-public-browser-refresh.service'))
        self.assertIn('--notify', self.read('chief-public-browser-refresh-notify.service'))

    def test_the_units_run_the_reviewed_script_from_the_live_tree(self):
        for name in ['chief-public-browser-refresh.service', 'chief-public-browser-refresh-notify.service']:
            self.assertIn('/opt/hermes-companion/scripts/scheduled-refresh-public-browser.py', self.read(name))

    def test_the_timer_runs_in_the_measured_quiet_hours_only(self):
        timer = self.read('chief-public-browser-refresh.timer')
        self.assertIn('OnCalendar=*-*-* 21:00:00 UTC', timer)
        self.assertNotIn('Persistent', timer)

    def test_a_host_rebuild_installs_the_timer(self):
        install = self.read('install-host.sh')
        self.assertIn('chief-public-browser-refresh.timer', install)


if __name__ == '__main__':
    unittest.main()
