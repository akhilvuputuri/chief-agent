#!/usr/bin/env python3
"""Offline operator-rollout tests: nothing here touches Docker, the database or the host."""
import importlib.util
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'deploy_public_browser', pathlib.Path(__file__).with_name('deploy-public-browser.py'))
rollout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rollout)
refresh_spec = importlib.util.spec_from_file_location(
    'refresh_public_browser', pathlib.Path(__file__).with_name('refresh-public-browser.py'))
refresh = importlib.util.module_from_spec(refresh_spec)
refresh_spec.loader.exec_module(refresh)
ROOT = pathlib.Path(__file__).resolve().parent.parent
KEY = 'a' * 64


class Compose(unittest.TestCase):
    def setUp(self):
        self.candidate = (ROOT / 'compose.yaml').read_bytes()
        self.block = rollout.services_block(self.candidate)
        baseline = self.candidate.replace(self.block, b'')
        baseline = baseline.replace(rollout.ENV_ADDITION, b'')
        baseline = baseline.replace(rollout.NETWORK_NEW, rollout.NETWORK_OLD)
        self.baseline = baseline.replace(rollout.TOP_ADDITION, b'')

    def test_the_repository_compose_is_exactly_the_reviewed_additions(self):
        self.assertEqual(rollout.expected_compose(self.baseline, self.block), self.candidate)

    def test_a_second_run_refuses_an_already_changed_baseline(self):
        with self.assertRaises(RuntimeError):
            rollout.expected_compose(self.candidate, self.block)

    def test_the_block_holds_only_the_two_services(self):
        extra = self.block + b'  gateway-copy:\n    image: x\n'
        with self.assertRaises(RuntimeError):
            rollout.services_block(self.candidate.replace(self.block, extra))

    def test_the_block_cannot_widen_access(self):
        for widened in [b'    ports: ["3001:3001"]\n', b'    privileged: true\n',
                        b'    cap_add: [SYS_ADMIN]\n', b'    network_mode: host\n',
                        b'    volumes: [/var/run/docker.sock:/s]\n']:
            changed = self.block.replace(b'    init: true\n', b'    init: true\n' + widened)
            with self.assertRaises(RuntimeError, msg=widened):
                rollout.services_block(self.candidate.replace(self.block, changed))

    def test_the_browser_holds_the_confinement_settings(self):
        for setting in [b'read_only: true', b'cap_drop: [ALL]', b'no-new-privileges:true',
                        b'seccomp:./deploy/browser/seccomp.json', b'mem_limit: 640m',
                        b'networks: [public-browser-control]\n    depends_on']:
            self.assertIn(setting, self.block)
        self.assertIn(b'public-browser-control: { internal: true }', self.candidate)


class RolloutGuards(unittest.TestCase):
    def test_idle_is_checked_again_after_the_probe_and_before_the_gateway_stops(self):
        source = pathlib.Path(rollout.__file__).read_text()
        probed = source.index('failed, peak = probe()')
        again = source.index('require_idle()', probed)
        stopped = source.index("compose('stop', 'gateway')")
        self.assertLess(probed, again)
        self.assertLess(again, stopped)

    def test_busy_work_refuses(self):
        for answers, message in [(['1'], 'Active work'), (['0', '1'], 'Pending conversation')]:
            with patch.object(rollout, 'sql', side_effect=answers):
                with self.assertRaisesRegex(RuntimeError, message):
                    rollout.require_idle()

    def test_rollback_runs_every_step_even_after_a_failure(self):
        ran = []

        def fail():
            ran.append('first')
            raise OSError('no')
        self.assertFalse(rollout.rollback([fail, lambda: ran.append('second')]))
        self.assertEqual(ran, ['first', 'second'])
        self.assertTrue(rollout.rollback([lambda: None]))

    def test_probe_reports_failed_check_names_and_peak_only(self):
        output = ('ok   opens a page\nFAIL renderer runs under a seccomp filter (detail)\n'
                  'memory peak so far: 228 MiB\n1 check(s) failed\n')
        done = subprocess.CompletedProcess([], 1, stdout=output, stderr='')
        with patch.object(rollout.subprocess, 'run', return_value=done):
            self.assertEqual(rollout.probe(), (['renderer runs under a seccomp filter'],
                                               'memory peak so far: 228 MiB'))
        crashed = subprocess.CompletedProcess([], 1, stdout='', stderr='boom')
        with patch.object(rollout.subprocess, 'run', return_value=crashed):
            self.assertEqual(rollout.probe()[0], ['probe stopped before finishing'])
        timed = subprocess.TimeoutExpired('x', 240)
        with patch.object(rollout.subprocess, 'run', side_effect=timed):
            self.assertEqual(rollout.probe()[0], ['probe timed out'])

    def test_a_gateway_that_never_stopped_is_left_alone(self):
        with patch.object(rollout, 'run') as run, patch.object(rollout, 'compose') as compose:
            rollout.restore_gateway(False, 'sha256:old')
        run.assert_not_called()
        compose.assert_not_called()

    def test_a_stopped_gateway_comes_back_on_its_previous_image(self):
        with (patch.object(rollout, 'run') as run, patch.object(rollout, 'compose') as compose,
              patch.object(rollout, 'healthy', return_value=True)):
            rollout.restore_gateway(True, 'sha256:old')
        run.assert_called_once_with(['docker', 'tag', 'sha256:old', rollout.IMAGE + ':latest'])
        compose.assert_called_once()
        with (patch.object(rollout, 'run'), patch.object(rollout, 'compose'),
              patch.object(rollout, 'healthy', return_value=False)):
            with self.assertRaisesRegex(RuntimeError, 'Rollback health failed'):
                rollout.restore_gateway(True, 'sha256:old')

    def test_env_is_replaced_whole_with_its_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / '.env'
            path.write_text('OLD=1\n')
            path.chmod(0o640)
            rollout.write_env(path, 'NEW=1\n')
            self.assertEqual(path.read_text(), 'NEW=1\n')
            self.assertEqual(path.stat().st_mode & 0o777, 0o640)
            self.assertEqual([p.name for p in pathlib.Path(directory).iterdir()], ['.env'])


class Refresh(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.deploy = refresh.deploy
        self.probe_output = (0, 'ok   a check\nmemory peak so far: 1 MiB\n')
        for item in [
            patch.object(self.deploy, 'LOCK', pathlib.Path(tempfile.mkdtemp()) / 'lock'),
            patch.object(self.deploy, 'LIVE', pathlib.Path('/live')),
            patch.object(self.deploy, 'sql', return_value='0'),
            patch.object(self.deploy, 'run', side_effect=self.run_step),
            patch.object(self.deploy, 'compose', side_effect=self.compose_step),
            patch.object(self.deploy.subprocess, 'run', side_effect=self.process),
        ]:
            item.start()
            self.addCleanup(item.stop)

    def run_step(self, args, **_):
        self.calls.append(args)
        return subprocess.CompletedProcess(args, 0, stdout='sha256:old', stderr='')

    def compose_step(self, *args, **_):
        self.calls.append(['compose', *args])
        return subprocess.CompletedProcess(args, 0, stdout='', stderr='')

    def process(self, args, **_):
        self.calls.append(args)
        if 'public-browser-probe.mjs' in args:
            return subprocess.CompletedProcess(args, self.probe_output[0], stdout=self.probe_output[1], stderr='')
        return subprocess.CompletedProcess(args, 0, stdout='', stderr='')

    def named(self, *start):
        return [c for c in self.calls if c[:len(start)] == list(start)]

    def swapped(self):
        return sum('--force-recreate' in c for c in self.calls)

    def live_tags(self):
        return [c for c in self.named('docker', 'tag') if not c[-1].endswith(':candidate')]

    def test_rebuilds_uncached_under_candidate_tags_then_proves_then_swaps(self):
        result = refresh.refresh()
        builds = self.named('docker', 'build')
        self.assertEqual(len(builds), 2)
        for build in builds:
            self.assertIn('--pull', build)
            self.assertIn('--no-cache', build)
            self.assertTrue(build[build.index('-t') + 1].endswith(':candidate'))
        order = [i for i, c in enumerate(self.calls) if 'public-browser-probe.mjs' in c]
        swap = next(i for i, c in enumerate(self.calls) if '--force-recreate' in c)
        self.assertLess(order[0], swap)
        self.assertEqual(result['probe'], 'passed')
        self.assertEqual(result['memory'], 'memory peak so far: 1 MiB')

    def test_the_proof_uses_the_confinement_the_live_service_has(self):
        refresh.refresh()
        probe = next(c for c in self.calls if 'public-browser-probe.mjs' in c)
        compose = (ROOT / 'compose.yaml').read_text()
        for flag, setting in [('--read-only', 'read_only: true'), ('--cap-drop=ALL', 'cap_drop: [ALL]'),
                              ('--memory=640m', 'mem_limit: 640m'), ('--memory-swap=640m', 'memswap_limit: 640m'),
                              ('--pids-limit=512', 'pids_limit: 512'), ('--shm-size=192m', 'shm_size: 192m')]:
            self.assertIn(flag, probe)
            self.assertIn(setting, compose)
        self.assertIn('--security-opt=seccomp=/live/deploy/browser/seccomp.json', probe)

    def test_the_proof_dies_first_and_a_killed_refresh_is_cleaned_up(self):
        refresh.refresh()
        probe = next(c for c in self.calls if 'public-browser-probe.mjs' in c)
        self.assertIn('--oom-score-adj=1000', probe)
        self.assertLess(
            self.calls.index(['docker', 'ps', '-aq', '--filter', 'name=pb-refresh-']),
            self.calls.index(probe))

    def test_a_failed_proof_never_touches_the_running_browser(self):
        self.probe_output = (1, 'FAIL renderer runs under a seccomp filter (x)\n')
        with self.assertRaisesRegex(RuntimeError, 'seccomp filter; the running browser is unchanged'):
            refresh.refresh()
        self.assertEqual(self.swapped(), 0)
        self.assertEqual(self.live_tags(), [])
        self.assertTrue(any(c[:3] == ['docker', 'rm', '-f'] for c in self.calls), 'throwaways removed')

    def test_busy_work_keeps_the_running_browser(self):
        with patch.object(self.deploy, 'sql', return_value='1'):
            with self.assertRaisesRegex(RuntimeError, 'Active work'):
                refresh.refresh()
        self.assertEqual(self.swapped(), 0)
        self.assertEqual(self.live_tags(), [])

    def test_a_failed_swap_puts_the_previous_images_back(self):
        attempts = []

        def compose_step(*args, **_):
            attempts.append(args)
            if len(attempts) == 1:
                raise RuntimeError('up failed')
            return subprocess.CompletedProcess(args, 0, stdout='', stderr='')
        with patch.object(self.deploy, 'compose', side_effect=compose_step):
            with self.assertRaisesRegex(RuntimeError, 'Swap failed; previous images restored'):
                refresh.refresh()
        self.assertEqual(len(attempts), 2)
        self.assertEqual([c[2] for c in self.live_tags()[-2:]], ['sha256:old', 'sha256:old'])

    def test_a_version_lookup_failure_does_not_fail_a_finished_refresh(self):
        real = self.run_step

        def run_step(args, **kwargs):
            if '--entrypoint' in args:
                raise subprocess.CalledProcessError(1, args)
            return real(args, **kwargs)
        with patch.object(self.deploy, 'run', side_effect=run_step):
            self.assertEqual(refresh.refresh()['chromium'], 'unknown')


class Environment(unittest.TestCase):
    def test_generates_a_key_once_and_turns_the_agent_on(self):
        first = rollout.env_with_browser('A=1\n')
        self.assertRegex(first, r'PUBLIC_BROWSER_KEY=[0-9a-f]{64}\n')
        self.assertTrue(first.endswith('PUBLIC_BROWSER=on\n'))
        self.assertIn('A=1\n', first)
        self.assertEqual(rollout.env_with_browser(first), first)

    def test_replaces_a_malformed_key_and_an_off_flag(self):
        text = rollout.env_with_browser('PUBLIC_BROWSER_KEY=short\nPUBLIC_BROWSER=off\n')
        self.assertNotIn('short', text)
        self.assertNotIn('PUBLIC_BROWSER=off', text)

    def test_keeps_a_good_key(self):
        text = rollout.env_with_browser('PUBLIC_BROWSER_KEY=' + KEY + '\n')
        self.assertIn(KEY, text)


if __name__ == '__main__':
    unittest.main()
