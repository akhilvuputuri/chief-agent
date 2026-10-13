import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest
import uuid
import urllib.request
import urllib.error

spec = importlib.util.spec_from_file_location(
    "broker", Path(__file__).with_name("model-broker.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BrokerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        helper = self.root / "helper.mjs"
        helper.write_text("// controlled helper placeholder")
        self.config = {
            "helper": str(helper),
            "ledger": str(self.root / "ledger.jsonl"),
            "trace": str(self.root / "private-trace.jsonl"),
            "expiresAt": time.time() + 60,
            "path": "/fixture/generate",
            "port": 0,
            "cases": [
                {
                    "id": "fixture",
                    "token": "a" * 64,
                    "models": ["fixture/model"],
                    "source": "a" * 40,
                }
            ],
        }
        self.body = {
            "callId": str(uuid.uuid4()),
            "model": "fixture/model",
            "messages": [],
            "tools": [],
            "maxOutputTokens": 4096,
            "purpose": "agent",
        }
        self.authorization = "Bearer " + self.config["cases"][0]["token"]

    def test_operator_configuration_rejects_weak_or_unbounded_capabilities(self):
        valid = {**self.config, "port": 31231}
        module.validate_config(valid)
        for invalid in (
            {**valid, "expiresAt": time.time() + 86400},
            {**valid, "cases": [{**valid["cases"][0], "token": "weak"}]},
            {**valid, "port": 80},
        ):
            with self.assertRaises(ValueError):
                module.validate_config(invalid)

    def test_admission_scope_replay_and_expiry(self):
        broker = module.Broker(self.config)
        with self.assertRaises(PermissionError):
            broker.admit("Bearer wrong", self.body)
        with self.assertRaises(PermissionError):
            broker.admit(self.authorization, {**self.body, "model": "not-selected"})
        broker.admit(self.authorization, self.body)
        with self.assertRaises(ValueError):
            broker.admit(self.authorization, self.body)
        self.config["expiresAt"] = time.time() - 1
        with self.assertRaises(ValueError):
            broker.admit(self.authorization, {**self.body, "callId": str(uuid.uuid4())})

    def test_restart_does_not_replay_unknown_dispatch(self):
        broker = module.Broker(self.config)
        broker.admit(self.authorization, self.body)
        recovered = module.Broker(self.config)
        with self.assertRaises(ValueError):
            recovered.admit(self.authorization, self.body)
        with self.assertRaises(ValueError):
            recovered.admit(
                self.authorization, {**self.body, "callId": str(uuid.uuid4())}
            )
        broker.record("fixture", self.body, {"accounting": {}}, 0)
        complete = module.Broker(self.config)
        with self.assertRaises(ValueError):
            complete.admit(self.authorization, self.body)
        complete.admit(self.authorization, {**self.body, "callId": str(uuid.uuid4())})

    def test_artifact_scope_immutable_receipt_and_restart(self):
        broker = module.Broker(self.config)
        case = self.config["cases"][0]
        body = {"case": "fixture", "source": "a" * 40, "state": "paused"}
        raw = json.dumps(body).encode()
        digest = broker.save_artifact(case, body, raw)
        self.assertEqual(
            module.Broker(self.config).save_artifact(case, body, raw), digest
        )
        self.assertEqual(len(Path(self.config["trace"]).read_text().splitlines()), 1)
        with self.assertRaises(ValueError):
            broker.save_artifact(case, {**body, "source": "wrong"}, b"wrong")

    def test_http_boundary_and_private_artifact_receipt(self):
        self.fake_docker(False)
        server = module.create_server(self.config)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        origin = "http://127.0.0.1:" + str(server.server_port)

        def send(path, body, authorization):
            request = urllib.request.Request(
                origin + path,
                json.dumps(body).encode(),
                {"Authorization": authorization, "Content-Type": "application/json"},
            )
            try:
                with urllib.request.urlopen(request, timeout=5) as response:
                    raw = response.read()
                    value = (
                        json.loads(raw.splitlines()[-1])["value"]
                        if response.headers.get("Content-Type")
                        == "application/x-ndjson"
                        else json.loads(raw)
                    )
                    return response.status, value
            except urllib.error.HTTPError as error:
                code = error.code
                error.close()
                return code, None

        self.assertEqual(send("/fixture/generate", self.body, "Bearer wrong")[0], 401)
        self.assertFalse(Path(self.config["ledger"]).exists())
        self.assertEqual(
            send(
                "/fixture/generate", {**self.body, "model": "wrong"}, self.authorization
            )[0],
            403,
        )
        self.assertEqual(
            send("/fixture/generate", self.body, self.authorization)[0], 200
        )
        self.assertEqual(
            send("/fixture/generate", self.body, self.authorization)[0], 409
        )
        artifact = {"case": "fixture", "source": "a" * 40, "state": "paused"}
        status, saved = send("/fixture/result", artifact, self.authorization)
        self.assertEqual(status, 200)
        self.assertEqual(len(saved["receipt"]), 64)
        self.assertEqual(
            send("/fixture/result", artifact, self.authorization)[1], saved
        )

    def fake_docker(self, wait_for_disconnect):
        fake = self.root / "docker"
        fake.write_text(
            "#!/usr/bin/env python3\nimport sys,json\nq=json.loads(sys.stdin.readline())\n"
            + (
                'sys.stdin.read()\nprint(json.dumps({"type":"result","value":{"failed":True,"billingUnknown":True}}))\n'
                if wait_for_disconnect
                else 'print(json.dumps({"type":"result","value":{"generation":{"message":{"content":"x"*150000}},"accounting":{"costUsd":0,"purpose":"agent"}}}))\n'
            )
        )
        fake.chmod(0o700)
        original = os.environ["PATH"]
        os.environ["PATH"] = str(self.root) + os.pathsep + original
        self.addCleanup(lambda: os.environ.__setitem__("PATH", original))

    def test_large_response_drains_and_ledger_omits_generation(self):
        self.fake_docker(False)
        broker = module.Broker(self.config)
        case, _ = broker.admit(self.authorization, self.body)
        parent, peer = socket.socketpair()
        self.addCleanup(parent.close)
        self.addCleanup(peer.close)
        result = broker.generate(case, self.body, parent)
        self.assertEqual(len(result["generation"]["message"]["content"]), 150000)
        record = json.loads(Path(self.config["ledger"]).read_text().splitlines()[-1])
        self.assertNotIn("generation", record)
        self.assertNotIn("messages", record)
        self.assertFalse(broker.in_flight)
        self.assertEqual(Path(self.config["trace"]).stat().st_mode & 0o777, 0o600)
        self.assertIn(
            "generation", json.loads(Path(self.config["trace"]).read_text())["result"]
        )

    def test_disconnect_closes_provider_cancellation_pipe(self):
        self.fake_docker(True)
        broker = module.Broker(self.config)
        case, _ = broker.admit(self.authorization, self.body)
        parent, peer = socket.socketpair()
        self.addCleanup(parent.close)
        timer = threading.Timer(0.2, peer.close)
        timer.start()
        started = time.monotonic()
        result = broker.generate(case, self.body, parent)
        self.assertLess(time.monotonic() - started, 5)
        self.assertTrue(result["failed"])
        self.assertTrue(result["billingUnknown"])


if __name__ == "__main__":
    unittest.main()
