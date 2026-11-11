#!/usr/bin/env python3
"""Offline tests for the traces site procedure: Caddy, curl and systemctl are stubbed."""
import contextlib
import importlib.util
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__)
spec = importlib.util.spec_from_file_location('deploy_traces_site', HERE.with_name('deploy-traces-site.py'))
site = importlib.util.module_from_spec(spec)
spec.loader.exec_module(site)
REVIEWED = (HERE.parent.parent / 'ops/oauth-site/Caddyfile').read_text()
LIVE = ('# Exact static information routes; private API authorization is unchanged.\n'
        'companion.52-77-47-24.sslip.io {\n  handle {\n    respond "Not found" 404\n  }\n}\n')
AGENTWATCH_ON = '{"auth":true,"user":null}'
GOOD = {
    '/healthz': (200, 'HTTP/2 200\r\ncontent-type: application/json\r\n\r\n{"ok":true}'),
    '/': (303, 'HTTP/2 303\r\nlocation: /login\r\n\r\n'),
    '/api/traces': (401, 'HTTP/2 401\r\n\r\nsign in or send an API key'),
    '/v1/traces': (404, 'HTTP/2 404\r\n\r\nNot found'),
    '/login': (200, 'HTTP/2 200\r\nx-frame-options: DENY\r\nreferrer-policy: same-origin\r\n'
                    'strict-transport-security: max-age=31536000\r\n\r\n<form>'),
}


class TracesSiteTests(unittest.TestCase):
    def test_the_reviewed_caddyfile_holds_the_site_byte_for_byte(self):
        self.assertEqual(REVIEWED.count(site.SITE), 1)
        self.assertTrue(REVIEWED.endswith(site.SITE))
        self.assertNotIn('Referrer-Policy no-referrer', site.SITE)
        self.assertIn('    Referrer-Policy same-origin\n', site.SITE)
        self.assertIn('reverse_proxy 127.0.0.1:4318', site.SITE)

    def scenario(self, *, live=LIVE, argv=(), agentwatch=AGENTWATCH_ON, answers=None,
                 existing=(302, 'HTTP/2 302\r\nlocation: /miniapp/\r\n\r\n'),
                 existing_after=None, validate_failure=False, reload_failure=False,
                 expected_error=None):
        answers = GOOD if answers is None else answers
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            caddyfile = root / 'Caddyfile'
            caddyfile.write_text(live)
            calls = []
            state = {'reloads': 0}

            def run(args, **kwargs):
                calls.append(tuple(args))
                if args[0] == 'caddy' and validate_failure:
                    raise subprocess.CalledProcessError(1, args)
                if args[:2] == ['systemctl', 'reload']:
                    state['reloads'] += 1
                    if reload_failure and state['reloads'] == 1:
                        raise subprocess.CalledProcessError(1, args)
                if args[0] == 'curl' and args[-1].endswith('/api/auth/session'):
                    if agentwatch is None:
                        raise subprocess.CalledProcessError(7, args)
                    return subprocess.CompletedProcess(args, 0, stdout=agentwatch)
                return subprocess.CompletedProcess(args, 0, stdout='')

            def fetch(url, *extra, host=site.HOST):
                calls.append(('fetch', url))
                if host == site.EXISTING:
                    return existing_after if existing_after and state['reloads'] else existing
                path = url.split(host, 1)[1]
                return answers.get(path, (0, ''))

            output = io.StringIO()
            with patch.object(site, 'CADDYFILE', caddyfile), \
                    patch.object(site, 'BACKUP', root / 'Caddyfile.before-traces'), \
                    patch.object(site, 'LOCK', root / 'release.lock'), \
                    patch.object(site, 'run', side_effect=run), \
                    patch.object(site, 'fetch', side_effect=fetch), \
                    patch.object(site, 'CHECK_PAUSE_S', 0), \
                    patch.object(sys, 'argv', ['deploy-traces-site.py', *argv]), \
                    contextlib.redirect_stdout(output):
                if expected_error:
                    with self.assertRaisesRegex(RuntimeError, expected_error):
                        site.main()
                else:
                    site.main()
            return caddyfile.read_text(), calls, output.getvalue()

    def test_adds_the_site_after_the_existing_one_and_checks_it(self):
        text, calls, output = self.scenario()
        self.assertEqual(text, LIVE + site.SITE)
        self.assertEqual(json.loads(output), {'site': site.HOST, 'state': 'serving'})
        reload = calls.index(('systemctl', 'reload', 'caddy'))
        validate = next(i for i, c in enumerate(calls) if c[0] == 'caddy')
        self.assertLess(validate, reload)
        self.assertIn(('fetch', 'https://' + site.HOST + '/v1/traces'), calls)

    def test_refuses_before_any_change_unless_agentwatch_requires_signing_in(self):
        for agentwatch in ('{"auth":false,"user":null}', None, 'not json'):
            with self.subTest(agentwatch=agentwatch):
                text, calls, _ = self.scenario(agentwatch=agentwatch, expected_error='does not require signing in')
                self.assertEqual(text, LIVE)
                self.assertFalse(any(c[0] in ('caddy', 'systemctl') for c in calls))

    def test_refuses_an_unexpected_live_caddyfile(self):
        for live, reason in ((LIVE + site.SITE, 'already names'),
                             (LIVE.replace('companion.', 'other.'), 'does not hold the reviewed site'),
                             (LIVE + LIVE, 'does not hold the reviewed site')):
            with self.subTest(reason=reason):
                text, calls, _ = self.scenario(live=live, expected_error=reason)
                self.assertEqual(text, live)
                self.assertFalse(any(c[0] == 'systemctl' for c in calls))

    def test_validation_failure_changes_nothing(self):
        text, calls, _ = self.scenario(validate_failure=True, expected_error='failed validation')
        self.assertEqual(text, LIVE)
        self.assertFalse(any(c[0] == 'systemctl' for c in calls))

    def test_an_existing_site_already_failing_stops_before_changing(self):
        text, calls, _ = self.scenario(existing=(502, ''), expected_error='existing site is not answering')
        self.assertEqual(text, LIVE)
        self.assertFalse(any(c[0] == 'systemctl' for c in calls))

    def test_any_failed_check_restores_the_previous_caddyfile(self):
        broken = [
            dict(GOOD, **{'/v1/traces': (200, 'HTTP/2 200\r\n\r\n{}')}),   # ingest reachable
            dict(GOOD, **{'/api/traces': (200, 'HTTP/2 200\r\n\r\n{}')}),  # data without signing in
            dict(GOOD, **{'/': (200, 'HTTP/2 200\r\n\r\n<html>')}),        # no sign-in page
            dict(GOOD, **{'/healthz': (200, 'HTTP/2 200\r\n\r\n{"ok":true,"spans":9}')}),
            dict(GOOD, **{'/login': (200, 'HTTP/2 200\r\nreferrer-policy: no-referrer\r\n\r\n')}),
            {},                                                            # never answers
        ]
        for answers in broken:
            with self.subTest(answers=answers):
                text, calls, _ = self.scenario(answers=answers, expected_error='previous Caddyfile was restored')
                self.assertEqual(text, LIVE)
                self.assertEqual(calls.count(('systemctl', 'reload', 'caddy')), 2)
        text, _, _ = self.scenario(existing_after=(502, ''), expected_error='previous Caddyfile was restored')
        self.assertEqual(text, LIVE)
        text, _, _ = self.scenario(reload_failure=True, expected_error='previous Caddyfile was restored')
        self.assertEqual(text, LIVE)

    def test_remove_takes_exactly_the_site_away(self):
        text, calls, output = self.scenario(live=LIVE + site.SITE, argv=['--remove'], agentwatch=None, answers={})
        self.assertEqual(text, LIVE)
        self.assertEqual(json.loads(output)['state'], 'removed')
        self.assertEqual(calls.count(('fetch', 'https://' + site.HOST + '/healthz')), 1)
        _, _, _ = self.scenario(live=LIVE + site.SITE, argv=['--remove'], expected_error='still answers')
        text, _, _ = self.scenario(argv=['--remove'], expected_error='does not hold the reviewed traces site')
        self.assertEqual(text, LIVE)

    def test_remove_needs_no_check_first_and_never_puts_the_site_back(self):
        text, calls, output = self.scenario(live=LIVE + site.SITE, argv=['--remove'], agentwatch=None,
                                            existing=(502, ''), answers={})
        self.assertEqual(text, LIVE)
        self.assertIn('inspect it', json.loads(output)['state'])
        self.assertEqual(calls.count(('systemctl', 'reload', 'caddy')), 1)
        text, _, _ = self.scenario(live=LIVE + site.SITE, argv=['--remove'], reload_failure=True,
                                   expected_error='did not reload')
        self.assertEqual(text, LIVE)

    def test_usage(self):
        self.scenario(argv=['--force'], expected_error='Usage')


if __name__ == '__main__':
    unittest.main()
