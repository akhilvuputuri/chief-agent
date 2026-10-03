from __future__ import annotations

import asyncio
import copy
import json
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from uuid import uuid4

import httpx

from chief_coding_runtime.loop import Budget, coding_loop, compact
from chief_coding_runtime.model import GatewayError, OpenRouter, WorkerClient
from chief_coding_runtime.protocol import (
    Assignment,
    Checkpoint,
    File,
    artifact_hash,
    assert_brief,
)
from chief_coding_runtime.worker import run_worker
from chief_coding_runtime.workspace import Workspace


def generation(*calls, reasoning=None):
    return {
        "message": {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": str(uuid4()),
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": json.dumps(arguments, ensure_ascii=False),
                    },
                }
                for name, arguments in calls
            ],
            **({"reasoning_details": reasoning} if reasoning else {}),
        }
    }


def report(kind, **extra):
    return ("report", {"kind": kind, "summary": "Synthetic result", **extra})


class ScriptedModel:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.inputs = []

    async def generate(self, messages, tools):
        self.inputs.append(copy.deepcopy(messages))
        return self.responses.pop(0)


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.stop = asyncio.Event()
        self.w = Workspace(Path(tempfile.mkdtemp()), self.stop)
        self.addCleanup(self.w.close)
        await self.w.git("init")
        await self.w.git(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.com",
            "commit",
            "--allow-empty",
            "-m",
            "fixture",
        )

    async def loop(self, model, mode="review", plan="", budget=None):
        return await coding_loop(
            model=model,
            workspace=self.w,
            messages=[
                {"role": "system", "content": "Fixture"},
                {"role": "user", "content": "Fixture"},
            ],
            mode=mode,
            budget=budget or Budget(10, 30),
            stop=self.stop,
            checkpoint=lambda: asyncio.sleep(0),
            plan=lambda: plan,
        )

    async def test_artifact_rename_delete_mode_and_unicode(self):
        await self.w.write("old.txt", "hello 😀\n")
        await self.w.git("add", "-A")
        await self.w.git(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.com",
            "commit",
            "-m",
            "base",
        )
        (self.w.root / "old.txt").rename(self.w.root / "new.txt")
        (self.w.root / "new.txt").chmod(0o755)
        cp = await self.w.snapshot("plan", "summary")
        self.assertEqual(
            [(f.path, f.content, f.mode) for f in cp.files],
            [("new.txt", "hello 😀\n", "100755"), ("old.txt", None, None)],
        )
        self.assertIn("deleted file mode", cp.patch)
        self.assertEqual(
            artifact_hash(cp),
            artifact_hash(cp.model_copy(update={"files": list(reversed(cp.files))})),
        )
        other = Workspace(Path(tempfile.mkdtemp()), asyncio.Event())
        self.addCleanup(other.close)
        await other.restore(cp)
        self.assertEqual(
            (other.root / "new.txt").read_bytes(), b"hello \xf0\x9f\x98\x80\n"
        )
        self.assertEqual((other.root / "new.txt").stat().st_mode & 0o777, 0o755)

    async def test_rejects_binary_symlink_and_paths(self):
        for path in (
            "../escape",
            "/tmp/escape",
            ".git/config",
            ".env",
            ".github/workflows/x.yml",
        ):
            with self.assertRaises(ValueError):
                await self.w.write(path, "x")
        (self.w.root / "link").symlink_to("/tmp")
        with self.assertRaises(ValueError):
            await self.w.write("link/escape", "x")
        (self.w.root / "link").unlink()
        for content in (b"\xff", b"binary\0data"):
            (self.w.root / "blob").write_bytes(content)
            with self.assertRaises((ValueError, UnicodeError)):
                await self.w.snapshot("", "")

    async def test_large_index_only_changed_paths_and_cache_outside_artifact(self):
        for i in range(500):
            (self.w.root / f"file-{i}.txt").write_text("base")
        await self.w.git("add", "-A")
        await self.w.git(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.com",
            "commit",
            "-m",
            "base",
        )
        await self.w.write("file-1.txt", "changed")
        env = self.w.environment()
        self.assertFalse(Path(env["HOME"]).is_relative_to(self.w.root))
        self.assertNotIn("CODING_JOB_TOKEN", env)
        cp = await self.w.snapshot("", "")
        self.assertEqual(len(cp.files), 1)

    async def test_process_timeout_cancellation_and_output_bound(self):
        r = await self.w.command(
            "python3", ["-c", "print('x'*100000)"], max_output=1000
        )
        self.assertTrue(r.truncated)
        self.assertEqual(len(r.output), 1000)
        started = time.monotonic()
        r = await self.w.command("sleep", ["20"], timeout_seconds=0.05)
        self.assertNotEqual(r.exit_code, 0)
        self.assertLess(time.monotonic() - started, 2)
        task = asyncio.create_task(self.w.command("sleep", ["20"]))
        await asyncio.sleep(0.05)
        self.stop.set()
        with self.assertRaises(asyncio.CancelledError):
            await task

    async def test_reasoning_survives_tool_continuation(self):
        reasoning = [{"type": "reasoning.encrypted", "data": "opaque", "index": 0}]
        model = ScriptedModel(
            generation(("plan_read", {}), reasoning=reasoning),
            generation(report("APPROVE")),
        )
        self.assertEqual((await self.loop(model, plan="complete plan")).kind, "APPROVE")
        self.assertEqual(model.inputs[1][2]["reasoning_details"], reasoning)

    async def test_review_requires_plan_delivered_on_later_generation_both_batch_orders(
        self,
    ):
        for batch in (
            (report("APPROVE"), ("plan_read", {})),
            (("plan_read", {}), report("APPROVE")),
        ):
            model = ScriptedModel(generation(*batch), generation(report("APPROVE")))
            self.assertEqual((await self.loop(model, plan="full plan")).kind, "APPROVE")
            self.assertEqual(len(model.inputs), 2)
            self.assertTrue(
                any(
                    "later model request" in m.get("content", "")
                    for m in model.inputs[1]
                    if m["role"] == "tool"
                )
            )

    async def test_review_pages_unicode_and_rejects_skipped_coverage(self):
        model = ScriptedModel(
            generation(("plan_read", {"offset": 2})),
            generation(report("APPROVE")),
            generation(("plan_read", {})),
            generation(("plan_read", {"offset": 6000})),
            generation(report("APPROVE")),
        )
        self.assertEqual((await self.loop(model, plan="😀" * 7000)).kind, "APPROVE")
        self.assertEqual(len(model.inputs), 5)

    async def test_review_cannot_write_or_run_shell(self):
        model = ScriptedModel(
            generation(
                ("file_write", {"path": "evil", "content": "x"}),
                ("command", {"command": "touch evil"}),
            ),
            generation(report("APPROVE")),
        )
        await self.loop(model)
        self.assertFalse((self.w.root / "evil").exists())
        self.assertEqual(
            sum(
                '"error"' in m.get("content", "")
                for m in model.inputs[1]
                if m["role"] == "tool"
            ),
            2,
        )

    async def test_complete_tool_batch_before_report_and_allocation(self):
        model = ScriptedModel(
            generation(report("APPROVE"), ("file_read", {"path": "missing"}))
        )
        messages = [
            {"role": "system", "content": "fixture"},
            {"role": "user", "content": "fixture"},
        ]
        await coding_loop(
            model=model,
            workspace=self.w,
            messages=messages,
            mode="review",
            budget=Budget(1, 2),
            stop=self.stop,
            checkpoint=lambda: asyncio.sleep(0),
        )
        self.assertEqual(
            [m["tool_call_id"] for m in messages if m["role"] == "tool"],
            [c["id"] for c in messages[2]["tool_calls"]],
        )
        with self.assertRaises(ValueError):
            await self.loop(
                ScriptedModel(
                    generation(("file_read", {"path": "missing"}), report("APPROVE"))
                ),
                budget=Budget(2, 1),
            )

    async def test_gateway_retry_stable_call_and_no_retry_for_revocation(self):
        requests = []

        def handler(request):
            requests.append(json.loads(request.content))
            return httpx.Response(
                503 if len(requests) == 1 else 200,
                json=generation(report("plan_ready")),
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            client = WorkerClient(
                "https://fixture.example",
                str(uuid4()),
                "a" * 64,
                self.stop,
                http,
                retry_delay=0,
            )
            await client.adapter("coder").generate(
                [{"role": "user", "content": "fixture"}], []
            )
        self.assertEqual(requests[0], requests[1])
        calls = 0

        def denied(request):
            nonlocal calls
            calls += 1
            return httpx.Response(401)

        async with httpx.AsyncClient(transport=httpx.MockTransport(denied)) as http:
            with self.assertRaises(GatewayError):
                await WorkerClient(
                    "https://fixture.example",
                    str(uuid4()),
                    "a" * 64,
                    self.stop,
                    http,
                    retry_delay=0,
                ).request("heartbeat", {})
        self.assertEqual(calls, 1)

    async def test_openrouter_contract(self):
        captured = []

        def handler(request):
            captured.append(json.loads(request.content))
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {"message": generation(report("candidate"))["message"]}
                    ],
                    "model": "deepseek/deepseek-v4.1-flash",
                },
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            model = OpenRouter(
                "synthetic", "deepseek/deepseek-v4.1-flash", http, self.stop
            )
            await model.generate([{"role": "user", "content": "fixture"}], [])
        self.assertEqual(
            captured[0]["provider"]["max_price"], {"prompt": 2, "completion": 10}
        )
        self.assertEqual(captured[0]["reasoning"], {"enabled": True, "effort": "high"})

    async def test_worker_candidate_actual_git_npm_checks_fresh_review(self):
        package = {
            "name": "fixture",
            "version": "1.0.0",
            "scripts": {
                s: 'node -e "process.exit(0)"'
                for s in ("check", "build", "format:check")
            },
        }
        await self.w.write("package.json", json.dumps(package))
        r = await self.w.command(
            "npm", ["install", "--package-lock-only", "--ignore-scripts", "--offline"]
        )
        self.assertEqual(r.exit_code, 0, r.text())
        await self.w.git("add", "-A")
        await self.w.git(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.com",
            "commit",
            "-m",
            "base",
        )
        base = (await self.w.git("rev-parse", "HEAD")).decode().strip()
        assignment = Assignment.model_validate(
            {
                "protocolVersion": 1,
                "id": str(uuid4()),
                "revision": 1,
                "objective": "Add fixture",
                "context": "",
                "mode": "implement",
                "baseSha": base,
                "settings": {
                    "repository": "fixture/repo",
                    "branch": "main",
                    "image": "fixture",
                    "runtime": "python",
                    "model": "deepseek/deepseek-v4.1-flash",
                    "reviewerModel": "openai/gpt-6.1-sol",
                    "effort": "high",
                    "limits": {"ms": 900000, "models": 10, "tools": 20},
                },
                "checkpoint": {"plan": "Add fixture file"},
                "deadline": "2099-01-01T00:00:00Z",
                "usedModels": 0,
            }
        )
        models = {
            "coder": ScriptedModel(
                generation(
                    ("file_write", {"path": "fixture.txt", "content": "correct 😀\n"})
                ),
                generation(report("candidate")),
            ),
            "reviewer": ScriptedModel(
                generation(("plan_read", {}), ("file_read", {"path": "fixture.txt"})),
                generation(report("APPROVE")),
            ),
        }
        requests = []

        def handler(request):
            body = json.loads(request.content) if request.content else None
            path = request.url.path.rsplit("/", 1)[1]
            requests.append((path, body))
            if path == "model":
                model = models[body["role"]]
                model.inputs.append(body["messages"])
                return httpx.Response(200, json=model.responses.pop(0))
            return httpx.Response(200, json={"accepted": True})

        roots = []

        async def checkout(workspace, repository, sha, cp):
            roots.append(workspace.root)
            r = await workspace.command(
                "git", ["clone", "--no-checkout", str(self.w.root), "."]
            )
            self.assertEqual(r.exit_code, 0, r.text())
            await workspace.git("checkout", "--detach", sha)
            await workspace.restore(cp)

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            await run_worker(
                WorkerClient(
                    "https://fixture.example", assignment.id, "a" * 64, self.stop, http
                ),
                self.stop,
                checkout,
                assignment,
            )
        result = next(body for path, body in requests if path == "finish")
        self.assertEqual(result["kind"], "candidate", result)
        self.assertEqual([c["exitCode"] for c in result["checks"]], [0, 0, 0])
        self.assertEqual(
            result["review"]["patchHash"],
            artifact_hash(Checkpoint.model_validate(result["checkpoint"])),
        )
        self.assertEqual(len(set(roots)), 2)
        self.assertTrue(all(not root.exists() for root in roots))
        self.assertEqual(result["checkpoint"]["files"][0]["path"], "fixture.txt")

    async def test_worker_retains_only_acknowledged_checkpoint_on_failure(self):
        a = {
            "protocolVersion": 1,
            "id": str(uuid4()),
            "revision": 1,
            "objective": "Plan fixture",
            "context": "",
            "mode": "plan",
            "baseSha": (await self.w.git("rev-parse", "HEAD")).decode().strip(),
            "settings": {
                "repository": "fixture/repo",
                "branch": "main",
                "image": "fixture",
                "model": "fixture",
                "reviewerModel": "fixture",
                "effort": "high",
                "limits": {"ms": 900000, "models": 5, "tools": 10},
            },
            "checkpoint": {"plan": "acknowledged", "summary": "saved"},
            "deadline": "2099-01-01T00:00:00Z",
            "usedModels": 0,
        }
        finished = []

        def handler(request):
            path = request.url.path.rsplit("/", 1)[1]
            if path == "model":
                return httpx.Response(
                    200, json=generation(report("plan_ready", plan="not acknowledged"))
                )
            if path == "checkpoint":
                return httpx.Response(409)
            if path == "finish":
                finished.append(json.loads(request.content))
            return httpx.Response(200, json={"accepted": True})

        async def checkout(workspace, repository, sha, cp):
            shutil.copytree(self.w.root / ".git", workspace.root / ".git")

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            await run_worker(
                WorkerClient(
                    "https://fixture.example", a["id"], "a" * 64, self.stop, http
                ),
                self.stop,
                checkout,
                Assignment.model_validate(a),
            )
        self.assertEqual(finished[0]["kind"], "paused")
        self.assertEqual(finished[0]["checkpoint"]["plan"], "acknowledged")

    def test_python_artifact_and_outcome_match_chiefs_typescript_contract(self):
        cp = Checkpoint(
            plan="unicode 😀",
            patch="diff fixture\n",
            summary="fixture",
            files=[
                File(path="z.txt", content=None),
                File(path="a.txt", content="漢字 😀\n", mode="100755"),
            ],
        )
        repo = Path(__file__).resolve().parents[2]
        if not (repo / "dist/coding/schema.js").exists():
            self.skipTest(
                "Build Chief to exercise the optional cross-language contract check"
            )
        script = "import {checkpoint} from './dist/coding/schema.js'; import {artifactHash} from './dist/coding/github.js'; import {readFileSync} from 'node:fs'; const cp=checkpoint.parse(JSON.parse(readFileSync(0,'utf8'))); console.log(artifactHash(cp));"
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            input=json.dumps(cp.wire(), ensure_ascii=False),
            text=True,
            capture_output=True,
            cwd=repo,
            check=True,
        )
        self.assertEqual(result.stdout.strip(), artifact_hash(cp))

    async def test_model_transport_cancellation_and_invalid_duplicate_calls(self):
        from chief_coding_runtime.model import validate_generation

        response = generation(("file_read", {"path": "x"}), report("candidate"))
        response["message"]["tool_calls"][1]["id"] = response["message"]["tool_calls"][
            0
        ]["id"]
        with self.assertRaises(ValueError):
            validate_generation(response)

        async def handler(request):
            await asyncio.sleep(30)
            return httpx.Response(200, json={"accepted": True})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            task = asyncio.create_task(
                WorkerClient(
                    "https://fixture.example", str(uuid4()), "a" * 64, self.stop, http
                ).request("heartbeat", {})
            )
            await asyncio.sleep(0.01)
            self.stop.set()
            with self.assertRaises(asyncio.CancelledError):
                await task

    def test_wire_utf16_limits_brief_and_protocol(self):
        with self.assertRaises(ValueError):
            File(path="unicode.txt", content="😀" * 64001)
        with self.assertRaises(ValueError):
            assert_brief("😀" * 40000, "")
        with self.assertRaises(ValueError):
            Checkpoint(files=[File(path="x", content="1"), File(path="x", content="2")])

    def test_compaction_removes_whole_groups_without_mutation(self):
        group = generation(
            ("file_write", {"path": "x", "content": "a" * 20000}),
            reasoning=[{"data": "opaque"}],
        )["message"]
        messages = [
            {"role": "system", "content": "protected"},
            {"role": "user", "content": "protected"},
        ]
        for _ in range(10):
            messages.extend(
                [
                    copy.deepcopy(group),
                    {
                        "role": "tool",
                        "content": "fixture",
                        "tool_call_id": group["tool_calls"][0]["id"],
                    },
                ]
            )
        compact(messages, [])
        self.assertEqual(
            messages[:2],
            [
                {"role": "system", "content": "protected"},
                {"role": "user", "content": "protected"},
            ],
        )
        self.assertLess(len(messages), 22)
        for message in messages[2::2]:
            self.assertEqual(message, group)


if __name__ == "__main__":
    unittest.main()
