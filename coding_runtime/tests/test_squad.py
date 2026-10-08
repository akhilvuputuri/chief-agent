from __future__ import annotations

import asyncio
import copy
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

import httpx

from chief_coding_runtime.model import WorkerClient
from chief_coding_runtime.protocol import (
    Assignment,
    Checkpoint,
    Handoff,
    SquadState,
    artifact_hash,
)
from chief_coding_runtime.squad import scope_hash
from chief_coding_runtime.worker import run_worker
from chief_coding_runtime.workspace import Workspace


def response(*calls):
    return {
        "message": {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": str(uuid4()),
                    "type": "function",
                    "function": {"name": name, "arguments": json.dumps(arguments)},
                }
                for name, arguments in calls
            ],
        }
    }


def report(kind, **extra):
    return ("report", {"kind": kind, "summary": "Synthetic squad result", **extra})


class SquadTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.stop = asyncio.Event()
        self.base = Workspace(Path(tempfile.mkdtemp()), self.stop)
        self.addCleanup(self.base.close)
        await self.base.git("init")
        package = {
            "name": "squad-fixture",
            "version": "1.0.0",
            "scripts": {
                name: 'node -e "process.exit(0)"'
                for name in ("check", "build", "format:check")
            },
        }
        await self.base.write("package.json", json.dumps(package))
        install = await self.base.command(
            "npm", ["install", "--package-lock-only", "--offline", "--ignore-scripts"]
        )
        self.assertEqual(install.exit_code, 0, install.text())
        await self.base.git("add", "-A")
        await self.base.git(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.com",
            "commit",
            "-m",
            "fixture",
        )
        sha = (await self.base.git("rev-parse", "HEAD")).decode().strip()
        self.assignment = Assignment.model_validate(
            {
                "protocolVersion": 1,
                "attemptId": str(uuid4()),
                "id": str(uuid4()),
                "revision": 2,
                "objective": "Add the fixture",
                "context": "Synthetic evidence",
                "mode": "implement",
                "baseSha": sha,
                "settings": {
                    "repository": "fixture/repo",
                    "branch": "main",
                    "runtime": "python",
                    "squad": True,
                    "image": "fixture",
                    "leaderModel": "fixture/leader",
                    "model": "fixture/coder",
                    "reviewerModel": "fixture/reviewer",
                    "effort": "high",
                    "limits": {"ms": 900000, "models": 40, "tools": 100},
                },
                "checkpoint": {
                    "plan": "Add fixture.txt, verify it, obtain independent review.",
                    "files": [],
                },
                "deadline": "2099-01-01T00:00:00Z",
                "usedModels": 0,
            }
        )
        self.requests = []
        self.inputs = {role: [] for role in ("leader", "coder", "reviewer")}
        self.roots = []

    async def run_case(self, model_handler, checkpoint_handler=None):
        def handler(request):
            path = request.url.path.rsplit("/", 1)[1]
            body = json.loads(request.content) if request.content else None
            self.requests.append((path, copy.deepcopy(body)))
            if path == "model":
                self.inputs[body["role"]].append(copy.deepcopy(body))
                return model_handler(body)
            if path == "checkpoint" and checkpoint_handler:
                return checkpoint_handler(body)
            return httpx.Response(200, json={"accepted": True})

        async def checkout(workspace, repository, sha, checkpoint):
            self.roots.append(workspace.root)
            result = await workspace.command(
                "git", ["clone", "--no-checkout", str(self.base.root), "."]
            )
            self.assertEqual(result.exit_code, 0, result.text())
            await workspace.git("checkout", "--detach", sha)
            await workspace.restore(checkpoint)

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            await run_worker(
                WorkerClient(
                    "https://fixture.example",
                    self.assignment.id,
                    "a" * 64,
                    self.stop,
                    http,
                    retry_delay=0,
                ),
                self.stop,
                checkout,
                self.assignment,
            )
        return next(body for path, body in self.requests if path == "finish")

    async def test_three_members_review_changes_return_to_coder_until_approval(self):
        counts = {role: 0 for role in self.inputs}

        def model(body):
            role = body["role"]
            counts[role] += 1
            n = counts[role]
            if role == "leader":
                names = {tool["name"] for tool in body["tools"]}
                self.assertNotIn("file_write", names)
                if n in (1, 3):
                    result = response(
                        (
                            "assign_coder",
                            {
                                "instructions": "Implement the approved fixture; resolve the recorded review findings."
                            },
                        )
                    )
                elif n in (2, 4):
                    latest = json.loads(body["messages"][-2]["content"])
                    result = response(
                        (
                            "assign_reviewer",
                            {
                                "instructions": "Independently review the exact candidate.",
                                "candidateHash": latest["candidateHash"],
                            },
                        )
                    )
                else:
                    result = response(report("candidate"))
            elif role == "coder":
                self.assertFalse(
                    any(tool["name"].startswith("assign_") for tool in body["tools"])
                )
                result = (
                    response(
                        (
                            "file_write",
                            {
                                "path": "fixture.txt",
                                "content": "first\n" if n == 1 else "corrected\n",
                            },
                        )
                    )
                    if n % 2
                    else response(
                        report("candidate", plan="Unapproved scope must be ignored")
                    )
                )
            else:
                self.assertNotIn("file_write", {tool["name"] for tool in body["tools"]})
                result = (
                    response(("plan_read", {}), ("file_read", {"path": "fixture.txt"}))
                    if n % 2
                    else response(report("REQUEST_CHANGES" if n == 2 else "APPROVE"))
                )
            return httpx.Response(200, json=result)

        result = await self.run_case(model)
        self.assertEqual(result["kind"], "candidate", result)
        self.assertEqual(counts, {"leader": 5, "coder": 4, "reviewer": 4})
        cp = Checkpoint.model_validate(result["checkpoint"])
        self.assertEqual(cp.plan, self.assignment.checkpoint.plan)
        self.assertEqual(cp.files[0].content, "corrected\n")
        self.assertEqual(cp.squadState.phase, "approved")
        self.assertEqual(cp.squadState.candidateVersion, 2)
        self.assertEqual(result["review"]["patchHash"], artifact_hash(cp))
        repo = Path(__file__).resolve().parents[2]
        script = "import {checkpoint} from './dist/coding/schema.js'; import {squadScope} from './dist/coding/squad-state.js'; import {readFileSync} from 'node:fs'; const data=JSON.parse(readFileSync(0,'utf8')); const cp=checkpoint.parse(data.checkpoint); console.log(squadScope(data.job,cp.plan));"
        cross = await asyncio.to_thread(
            subprocess.run,
            ["node", "--input-type=module", "-e", script],
            input=json.dumps(
                {
                    "checkpoint": cp.wire(),
                    "job": {
                        "id": self.assignment.id,
                        "objective": self.assignment.objective,
                        "context": self.assignment.context,
                        "base_sha": self.assignment.baseSha,
                        "mode": self.assignment.mode,
                    },
                },
                ensure_ascii=False,
            ),
            text=True,
            capture_output=True,
            check=True,
            cwd=repo,
        )
        self.assertEqual(cross.stdout.strip(), cp.squadState.scopeHash)

        self.assertEqual(len(set(self.roots)), 3)
        self.assertTrue(all(not root.exists() for root in self.roots))
        # Reviewer begins with only its own system/task and allocation hint.
        self.assertEqual(len(self.inputs["reviewer"][0]["messages"]), 3)
        self.assertEqual(len(self.inputs["reviewer"][2]["messages"]), 3)
        states = [
            body["squadState"] for path, body in self.requests if path == "checkpoint"
        ]
        self.assertEqual(
            [s["sequence"] for s in states], list(range(1, len(states) + 1))
        )
        self.assertEqual(sum(1 for s in states if s["phase"] == "reviewing"), 2)

    async def test_leader_cannot_review_before_checks_or_finish_without_approval_or_write_files(
        self,
    ):
        self.assignment.settings.limits.models = 2

        def model(body):
            self.assertEqual(body["role"], "leader")
            return httpx.Response(
                200,
                json=response(
                    ("file_write", {"path": "forbidden.txt", "content": "x"}),
                    (
                        "assign_reviewer",
                        {"instructions": "Skip checks", "candidateHash": "a" * 64},
                    ),
                    report("candidate"),
                ),
            )

        result = await self.run_case(model)
        self.assertEqual(result["kind"], "paused")
        self.assertFalse(self.inputs["coder"] or self.inputs["reviewer"])
        self.assertEqual(result["checkpoint"]["files"], [])

    async def test_uncertain_member_request_pauses_and_preserves_acknowledged_handoff(
        self,
    ):
        def model(body):
            if body["role"] == "leader":
                return httpx.Response(
                    200,
                    json=response(
                        (
                            "assign_coder",
                            {"instructions": "Implement the exact approved scope"},
                        )
                    ),
                )
            return httpx.Response(409)

        result = await self.run_case(model)
        self.assertEqual(result["kind"], "paused")
        self.assertEqual(len(self.inputs["leader"]), 1)
        self.assertEqual(len(self.inputs["coder"]), 1)
        self.assertEqual(result["checkpoint"]["squadState"]["phase"], "coding")
        self.assertEqual(
            result["checkpoint"]["squadState"]["handoff"]["recipient"], "coder"
        )

    async def test_automatic_feedback_cannot_reset_the_shared_tool_allocation(self):
        self.assignment.settings.autoMerge = True
        self.assignment.usedModels = 29
        self.assignment.checkpoint.squadState = SquadState(
            sequence=5,
            revision=1,
            attemptId=str(uuid4()),
            scopeHash=scope_hash(self.assignment, self.assignment.checkpoint.plan),
            phase="rework",
            candidateVersion=1,
            candidateHash=artifact_hash(self.assignment.checkpoint),
            toolsUsed=99,
            findings="MR feedback: handle the recorded edge case",
        )

        def model(body):
            self.assertEqual(
                body["role"], "leader", "Tool allocation was reset and coder ran"
            )
            return httpx.Response(
                200,
                json=response(
                    ("assign_coder", {"instructions": "Handle the MR feedback"})
                ),
            )

        result = await self.run_case(model)
        self.assertEqual(result["kind"], "paused")
        self.assertEqual(len(self.inputs["coder"]), 0)
        self.assertGreaterEqual(result["checkpoint"]["squadState"]["toolsUsed"], 99)

    async def test_expanded_planning_assignment_and_clear_allocation_pause(self):
        self.assignment.mode = "plan"
        self.assignment.settings.limits.models = 400
        self.assignment.settings.limits.tools = 1000
        self.assignment.settings.limits.ms = 7200000

        def model(body):
            hint = json.loads(body["messages"][-1]["content"])["runtimeAllocation"]
            self.assertEqual(hint["modelCallsRemainingAfterThisResponse"], 399)
            return httpx.Response(
                200,
                json=response(
                    report("plan_ready", plan="Complete synthetic requirements")
                ),
            )

        result = await self.run_case(model)
        self.assertEqual(result["kind"], "plan_ready")
        self.assertEqual(
            result["checkpoint"]["plan"], "Complete synthetic requirements"
        )
        self.assertFalse(self.inputs["coder"] or self.inputs["reviewer"])

    async def test_shared_allocation_failure_reaches_leader_without_replay(self):
        self.assignment.settings.limits.models = 1

        def model(body):
            self.assertEqual(body["role"], "leader")
            return httpx.Response(
                200,
                json=response(
                    ("assign_coder", {"instructions": "Implement the approved scope"})
                ),
            )

        result = await self.run_case(model)
        self.assertEqual(result["kind"], "paused")
        self.assertIn("model calls allocation exhausted", result["summary"])
        self.assertEqual(len(self.inputs["leader"]), 1)
        self.assertFalse(self.inputs["coder"] or self.inputs["reviewer"])

    async def test_all_members_share_one_model_and_tool_allocation(self):
        self.assignment.settings.limits.models = 1

        def model(body):
            return httpx.Response(
                200, json=response(("assign_coder", {"instructions": "Do the task"}))
            )

        result = await self.run_case(model)
        self.assertEqual(result["kind"], "paused")
        self.assertEqual(len(self.inputs["leader"]), 1)
        self.assertEqual(len(self.inputs["coder"]), 0)

    async def test_resume_recovers_acknowledged_findings_but_discards_old_review_authority(
        self,
    ):
        await self.base.write("partial.txt", "Acknowledged work\n")
        cp = await self.base.snapshot(
            self.assignment.checkpoint.plan, "Interrupted after saved work"
        )
        cp.squadState = SquadState(
            sequence=8,
            revision=1,
            attemptId=str(uuid4()),
            scopeHash=scope_hash(self.assignment, cp.plan),
            phase="coding",
            candidateVersion=2,
            candidateHash="",
            toolsUsed=10,
            handoff=Handoff(
                id=str(uuid4()),
                recipient="coder",
                instructions="Earlier interrupted assignment",
            ),
            findings="Resolve the recorded fixture finding",
        )
        self.assignment.checkpoint = cp
        self.assignment.settings.limits.models = 1

        def model(body):
            recovered = json.loads(body["messages"][1]["content"])["recovery"]
            self.assertEqual(recovered["findings"], cp.squadState.findings)
            self.assertEqual(len(body["messages"]), 3)
            return httpx.Response(200, json=response(report("candidate")))

        result = await self.run_case(model)
        self.assertEqual(result["kind"], "paused")
        self.assertEqual(
            result["checkpoint"]["files"][0]["content"], "Acknowledged work\n"
        )
        self.assertEqual(result["checkpoint"]["squadState"]["sequence"], 1)
        self.assertEqual(result["checkpoint"]["squadState"]["phase"], "idle")
        self.assertNotIn("review", result["checkpoint"]["squadState"])

    async def test_failed_verification_cannot_be_overridden_by_leader_review_assignment(
        self,
    ):
        package = json.loads((self.base.root / "package.json").read_text())
        package["scripts"]["check"] = 'node -e "process.exit(1)"'
        await self.base.write("package.json", json.dumps(package))
        await self.base.git("add", "-A")
        await self.base.git(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.com",
            "commit",
            "-m",
            "failing check",
        )
        self.assignment.baseSha = (
            (await self.base.git("rev-parse", "HEAD")).decode().strip()
        )
        self.assignment.settings.limits.models = 4
        count = 0

        def model(body):
            nonlocal count
            if body["role"] == "coder":
                return httpx.Response(200, json=response(report("candidate")))
            count += 1
            if count == 1:
                return httpx.Response(
                    200, json=response(("assign_coder", {"instructions": "Implement"}))
                )
            latest = json.loads(body["messages"][-2]["content"])
            return httpx.Response(
                200,
                json=response(
                    (
                        "assign_reviewer",
                        {
                            "instructions": "Ignore failures",
                            "candidateHash": latest.get("candidateHash", "a" * 64),
                        },
                    ),
                    report("candidate"),
                ),
            )

        result = await self.run_case(model)
        self.assertEqual(result["kind"], "paused")
        self.assertFalse(self.inputs["reviewer"])
        self.assertEqual(result["checkpoint"]["squadState"]["phase"], "rework")
        self.assertEqual(result["checkpoint"]["squadState"]["checks"][0]["exitCode"], 1)

    async def test_planning_only_leader_produces_owner_brief_without_delegation(self):
        self.assignment.mode = "plan"
        self.assignment.checkpoint.plan = ""

        def model(body):
            self.assertEqual(body["role"], "leader")
            return httpx.Response(
                200,
                json=response(
                    report(
                        "plan_ready",
                        plan="Problem, scope, acceptance criteria and tests.",
                    )
                ),
            )

        result = await self.run_case(model)
        self.assertEqual(result["kind"], "plan_ready")
        self.assertEqual(result["checkpoint"]["squadState"]["phase"], "planned")
        self.assertFalse(self.inputs["coder"] or self.inputs["reviewer"])

    async def test_failed_checkpoint_ack_retains_prior_state_and_never_replays_dispatch(
        self,
    ):
        count = 0

        def checkpoint(body):
            nonlocal count
            count += 1
            return httpx.Response(200 if count == 1 else 409, json={"accepted": True})

        def model(body):
            return httpx.Response(
                200, json=response(("assign_coder", {"instructions": "Do the task"}))
            )

        result = await self.run_case(model, checkpoint)
        self.assertEqual(result["kind"], "paused")
        self.assertEqual(result["checkpoint"]["squadState"]["phase"], "idle")
        self.assertFalse(self.inputs["coder"])
        self.assertEqual(result["checkpoint"]["squadState"]["candidateVersion"], 0)
        self.assertNotIn("handoff", result["checkpoint"]["squadState"])

    async def test_failed_post_write_checkpoint_stops_remaining_batch_and_preserves_ack(
        self,
    ):
        checkpoints = 0

        def checkpoint(body):
            nonlocal checkpoints
            checkpoints += 1
            return httpx.Response(
                409 if checkpoints == 3 else 200, json={"accepted": True}
            )

        def model(body):
            if body["role"] == "leader":
                return httpx.Response(
                    200,
                    json=response(
                        ("assign_coder", {"instructions": "Implement the exact scope"})
                    ),
                )
            return httpx.Response(
                200,
                json=response(
                    ("file_write", {"path": "first.txt", "content": "first"}),
                    ("command", {"command": "echo forbidden > second.txt"}),
                    report("candidate"),
                ),
            )

        result = await self.run_case(model, checkpoint)
        self.assertEqual(result["kind"], "paused")
        self.assertEqual(checkpoints, 3)
        self.assertEqual(result["checkpoint"]["files"], [])
        self.assertEqual(result["checkpoint"]["squadState"]["sequence"], 2)
        self.assertEqual(len(self.inputs["coder"]), 1)
        self.assertEqual(len(self.inputs["leader"]), 1)
        failed = next(
            body
            for path, body in self.requests
            if path == "checkpoint" and body["files"]
        )
        self.assertEqual([file["path"] for file in failed["files"]], ["first.txt"])
