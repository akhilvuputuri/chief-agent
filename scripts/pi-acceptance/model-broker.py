"""Temporary, authenticated acceptance-only broker; never starts on import.

Configuration is operator-created mode 0600 JSON: path, port, helper, ledger, trace,
expiresAt (Unix seconds), and cases [{id,token,models,source}]. It contains scoped test
capabilities, never a provider key. Model credentials stay in the existing gateway.
Only the designated owner-only trace retains synthetic test requests/generations.
The operational ledger excludes them; credentials are never intentionally logged.
"""

import hashlib
import hmac
import json
import os
import queue
import re
import select
import socket
import stat
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def validate_config(config):
    if not isinstance(config.get("port"), int) or not 1024 <= config["port"] <= 65535:
        raise ValueError("Explicit unprivileged loopback port required")
    if not re.fullmatch(r"/[A-Za-z0-9/_-]{1,160}/generate", config.get("path", "")):
        raise ValueError("Exact bounded route required")
    if not time.time() < config.get("expiresAt", 0) <= time.time() + 6 * 3600:
        raise ValueError("Temporary expiry required")
    for name in ("helper", "ledger", "trace"):
        if not os.path.isabs(config.get(name, "")):
            raise ValueError("Absolute operator paths required")
    cases = config.get("cases", [])
    if not 1 <= len(cases) <= 24:
        raise ValueError("Explicit bounded case inventory required")
    identifiers, tokens = set(), set()
    for case in cases:
        if (
            not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,99}", case.get("id", ""))
            or case["id"] in identifiers
        ):
            raise ValueError("Unique case IDs required")
        if (
            not re.fullmatch(r"[a-f0-9]{64}", case.get("token", ""))
            or case["token"] in tokens
        ):
            raise ValueError("Unique 256-bit test capabilities required")
        if not re.fullmatch(r"[a-f0-9]{40}", case.get("source", "")) or not case.get(
            "models"
        ):
            raise ValueError("Pinned source and model selection required")
        identifiers.add(case["id"])
        tokens.add(case["token"])


class Broker:
    def __init__(self, config):
        self.config = config
        if config["ledger"] == config["trace"]:
            raise ValueError("Trace and operational ledger must be separate")
        self.helper = Path(config["helper"]).read_text()
        self.lock = threading.Lock()
        self.calls = {}
        self.in_flight = set()
        self.artifacts = {}
        ledger = Path(config["ledger"])
        if ledger.exists():
            if stat.S_IMODE(ledger.stat().st_mode) & 0o077:
                raise ValueError("Ledger must be owner-only")
            for line in ledger.read_text().splitlines():
                event = json.loads(line)
                if event["event"] == "artifact":
                    self.artifacts.setdefault(event["case"], set()).add(event["digest"])
                    continue
                self.calls.setdefault(event["case"], set()).add(event["callId"])
                if event["event"] == "admitted":
                    self.in_flight.add(event["case"])
                elif event["event"] == "result":
                    if event.get("outcome") in ("complete", "failed_known"):
                        self.in_flight.discard(event["case"])
                    else:
                        self.in_flight.add(event["case"])

    def append(self, event, path=None):
        path = path or self.config["ledger"]
        if Path(path).exists() and stat.S_IMODE(Path(path).stat().st_mode) & 0o077:
            raise ValueError("Output must be owner-only")
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(descriptor, "a", encoding="utf8") as output:
            output.write(json.dumps(event) + "\n")
            output.flush()
            os.fsync(output.fileno())

    def admit(self, authorization, body):
        now = time.time()
        if now >= self.config["expiresAt"]:
            raise ValueError("expired")
        case = next(
            (
                c
                for c in self.config["cases"]
                if hmac.compare_digest(
                    authorization.encode(), ("Bearer " + c["token"]).encode()
                )
            ),
            None,
        )
        if case is None:
            raise PermissionError("unauthorized")
        if body.get("model") not in case["models"]:
            raise PermissionError("model not selected")
        call_id = str(uuid.UUID(body["callId"]))
        key = (case["id"], call_id)
        with self.lock:
            used = self.calls.setdefault(case["id"], set())
            if (
                call_id in used
                or len(used) >= 400
                or case["id"] in self.in_flight
                or len(self.in_flight) >= 2
            ):
                raise ValueError("inspect state before retrying")
            self.append({"event": "admitted", "case": case["id"], "callId": call_id})
            used.add(call_id)
            self.in_flight.add(case["id"])
        return case["id"], key

    def record(self, case_id, body, result, seconds):
        # Allowlisted accounting only; never copy response or request bodies.
        accounting = result.get("accounting", {})
        complete = isinstance(result.get("generation"), dict) and isinstance(
            result["generation"].get("message"), dict
        )
        outcome = (
            "complete"
            if complete
            else "failed_known"
            if result.get("failed") and result.get("outcomeKnown") is True
            else "unresolved"
        )
        event = {
            "event": "result",
            "outcome": outcome,
            "case": case_id,
            "callId": body["callId"],
            "seconds": seconds,
            "failed": bool(result.get("failed")),
            "dispatchAttempted": result.get("dispatchAttempted"),
            "billingUnknown": bool(result.get("billingUnknown")),
            "accounting": {
                k: accounting[k]
                for k in (
                    "adapterSha",
                    "inputPriceFilter",
                    "outputPriceFilter",
                    "model",
                    "provider",
                    "promptTokens",
                    "completionTokens",
                    "costUsd",
                    "requestedOutputTokens",
                    "purpose",
                )
                if k in accounting
            },
        }
        with self.lock:
            trace = json.dumps({"case": case_id, "request": body, "result": result})
            for configured in self.config["cases"]:
                trace = trace.replace(
                    configured["token"], "<redacted acceptance capability>"
                )
            self.append(json.loads(trace), self.config["trace"])
            self.append(event)
            if outcome != "unresolved":
                self.in_flight.discard(case_id)

    def save_artifact(self, case, body, raw):
        if (
            time.time() >= self.config["expiresAt"]
            or body.get("case") != case["id"]
            or body.get("source") != case["source"]
        ):
            raise ValueError("artifact scope mismatch")
        digest = hashlib.sha256(raw).hexdigest()
        with self.lock:
            seen = self.artifacts.setdefault(case["id"], set())
            if digest in seen:
                return digest
            if len(seen) >= 4:
                raise ValueError("artifact count bound")
            trace = json.dumps(
                {"case": case["id"], "artifactDigest": digest, "artifact": body}
            )
            for configured in self.config["cases"]:
                trace = trace.replace(
                    configured["token"], "<redacted acceptance capability>"
                )
            self.append(json.loads(trace), self.config["trace"])
            self.append({"event": "artifact", "case": case["id"], "digest": digest})
            seen.add(digest)
        return digest

    def generate(self, case_id, body, connection, on_progress=None):
        started = time.monotonic()
        child = subprocess.Popen(
            [
                "docker",
                "exec",
                "-i",
                "hermes-companion-gateway-1",
                "node",
                "--input-type=module",
                "-e",
                self.helper,
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        cancellation_pipe = child.stdin
        cancellation_pipe.write((json.dumps(body) + "\n").encode())
        cancellation_pipe.flush()
        child.stdin = None  # communicate drains both outputs without closing our cancellation channel.
        finished = threading.Event()

        def disconnect():
            while not finished.wait(0.1):
                readable, _, _ = select.select([connection], [], [], 0)
                if readable:
                    try:
                        disconnected = not connection.recv(1, socket.MSG_PEEK)
                    except OSError:
                        disconnected = True
                    if disconnected:
                        try:
                            cancellation_pipe.close()  # EOF aborts the trusted provider request.
                        except OSError:
                            pass
                        return

        watcher = threading.Thread(target=disconnect, daemon=True)
        watcher.start()
        result = {"failed": True, "category": "broker", "billingUnknown": True}
        frames = queue.Queue()

        def read_frames():
            try:
                while True:
                    line = child.stdout.readline(2_000_001)
                    if not line:
                        break
                    if len(line) > 2_000_000:
                        raise ValueError("response bound")
                    frames.put(json.loads(line))
            except (ValueError, OSError):
                pass
            finally:
                frames.put(None)

        def drain_errors():
            while child.stderr.read(65536):
                pass

        reader = threading.Thread(target=read_frames, daemon=True)
        errors = threading.Thread(target=drain_errors, daemon=True)
        reader.start()
        errors.start()
        try:
            while time.monotonic() - started < 310:
                try:
                    frame = frames.get(timeout=0.25)
                except queue.Empty:
                    continue
                if frame is None:
                    break
                if frame.get("type") == "progress" and on_progress:
                    try:
                        on_progress(frame["value"])
                    except OSError:
                        cancellation_pipe.close()
                        on_progress = None
                elif frame.get("type") == "result":
                    result = frame["value"]
                    break
        except (ValueError, OSError):
            pass
        finally:
            finished.set()
            try:
                cancellation_pipe.close()
            except OSError:
                pass
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
            reader.join(timeout=1)
            errors.join(timeout=1)
            child.stdout.close()
            child.stderr.close()
            self.record(case_id, body, result, round(time.monotonic() - started, 3))
        return result


def create_server(config):
    broker = Broker(config)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            artifact = self.path == config["path"].removesuffix("/generate") + "/result"
            if self.path != config["path"] and not artifact:
                self.send_error(404)
                return
            authorization = self.headers.get("Authorization", "")
            case = next(
                (
                    c
                    for c in config["cases"]
                    if hmac.compare_digest(
                        authorization.encode(), ("Bearer " + c["token"]).encode()
                    )
                ),
                None,
            )
            if case is None:
                self.send_error(401)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= (5000000 if artifact else 180000):
                    raise ValueError("body bound")
                self.connection.settimeout(10)
                raw = self.rfile.read(length)
                body = json.loads(raw)
                if not isinstance(body, dict):
                    raise ValueError("object required")
                if artifact:
                    result = {"receipt": broker.save_artifact(case, body, raw)}
                else:
                    case_id, _key = broker.admit(authorization, body)
            except PermissionError:
                self.send_error(403)
                return
            except (ValueError, KeyError, TypeError, OSError):
                self.send_error(409)
                return
            if not artifact:
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()

                def progress(value):
                    self.wfile.write(
                        (
                            json.dumps({"type": "progress", "value": value}) + "\n"
                        ).encode()
                    )
                    self.wfile.flush()

                result = broker.generate(case_id, body, self.connection, progress)
                try:
                    self.wfile.write(
                        (
                            json.dumps({"type": "result", "value": result}) + "\n"
                        ).encode()
                    )
                    self.wfile.flush()
                except OSError:
                    pass
                return
            wire = json.dumps(result).encode()
            try:
                self.send_response(409 if result.get("failed") else 200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(wire)))
                self.end_headers()
                self.wfile.write(wire)
            except OSError:
                pass

    server = ThreadingHTTPServer(("127.0.0.1", config["port"]), Handler)
    server.daemon_threads = True
    return server


if __name__ == "__main__":
    config_path = Path(sys.argv[1])
    if stat.S_IMODE(config_path.stat().st_mode) & 0o077:
        raise SystemExit("Configuration must be owner-only")
    os.umask(0o077)
    if config_path.stat().st_uid != os.getuid():
        raise SystemExit("Configuration must belong to the running operator")
    configuration = json.loads(config_path.read_text())
    validate_config(configuration)
    create_server(configuration).serve_forever()
