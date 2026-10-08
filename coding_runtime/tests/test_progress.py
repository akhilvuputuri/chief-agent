from __future__ import annotations

import asyncio
import copy
import json
import tempfile
import unittest
from pathlib import Path

from test_runtime import ScriptedModel, generation, report

from chief_coding_runtime import inspection
from chief_coding_runtime.loop import Budget, SquadExecutionError, coding_loop
from chief_coding_runtime.memory import LoopStalled
from chief_coding_runtime.model import GatewayError
from chief_coding_runtime.protocol import LoopMemory, Notebook
from chief_coding_runtime.workspace import Workspace


class ProgressTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.stop = asyncio.Event()
        self.w = Workspace(Path(tempfile.mkdtemp()), self.stop)
        self.addCleanup(self.w.close)
        await self.w.git("init")
        await self.w.write(
            "src/fixture.ts", "export const first = 1;\nexport const second = 2;\n"
        )
        self.memory = LoopMemory()
        self.saved = []
        self.messages = [
            {"role": "system", "content": "Synthetic immutable rules"},
            {"role": "user", "content": "Synthetic immutable owner task"},
        ]
        self.budget = Budget(40, 100)

    async def checkpoint(self):
        self.saved.append(self.memory.model_copy(deep=True))

    async def run_loop(self, model, **kwargs):
        return await coding_loop(
            model=model,
            workspace=self.w,
            messages=self.messages,
            mode="plan",
            budget=self.budget,
            stop=self.stop,
            checkpoint=self.checkpoint,
            memory=self.memory,
            runtime_checkpoint=kwargs.pop("runtime_checkpoint", self.checkpoint),
            **kwargs,
        )

    async def test_search_and_line_reads_are_safe_paginated_and_fingerprinted(self):
        (self.w.root / ".env").write_text("synthetic forbidden text")
        (self.w.root / ".gitignore").write_text("ignored.txt\n")
        (self.w.root / "ignored.txt").write_text("export ignored")
        (self.w.root / "link.txt").symlink_to("src/fixture.ts")
        listing = await inspection.glob(self.w, "*", 0, 100)
        self.assertNotIn(".env", listing["paths"])
        self.assertNotIn("ignored.txt", listing["paths"])
        self.assertNotIn("link.txt", listing["paths"])
        matches = await inspection.grep(self.w, "export", "src/*.ts", 0, 1, False, True)
        self.assertEqual(matches["matches"][0]["line"], 1)
        self.assertEqual(matches["nextOffset"], 1)
        section = await inspection.read(self.w, "src/fixture.ts", 0, 1000, 2, 2)
        self.assertEqual(section["text"], "export const second = 2;\n")
        self.assertEqual(section["lineStart"], 2)
        self.assertEqual(section["lineEnd"], 2)
        old = section["fingerprint"]
        await self.w.write("src/fixture.ts", "changed\n")
        self.assertNotEqual(
            old,
            (await inspection.read(self.w, "src/fixture.ts", 0, 1000, None, None))[
                "fingerprint"
            ],
        )
        with self.assertRaises(ValueError):
            await inspection.read(self.w, "../outside", 0, 1000, None, None)

    async def test_planning_notes_and_counters_survive_a_provider_failure(self):
        class FailingModel(ScriptedModel):
            async def generate(inner, messages, tools):
                if len(inner.inputs) == 2:
                    raise GatewayError(409, "invalid_worker_payload")
                return await super().generate(messages, tools)

        model = FailingModel(
            generation(("file_read", {"path": "src/fixture.ts"})),
            generation(
                (
                    "notes_update",
                    {
                        "subtask": "Inspect fixture",
                        "findings": "src/fixture.ts defines first and second",
                        "nextAction": "Prepare the brief",
                    },
                )
            ),
        )
        with self.assertRaises(GatewayError):
            await self.run_loop(model)
        self.assertEqual(
            self.saved[-1].notes.findings, "src/fixture.ts defines first and second"
        )
        self.assertEqual(self.saved[-1].toolsUsed, 2)
        self.assertEqual(self.saved[-1].modelCalls, 3)
        self.assertEqual(len(self.saved[-1].receipts), 1)

    async def test_compaction_delivers_latest_opaque_tool_group_and_retains_findings(
        self,
    ):
        for i in range(42):
            generated = generation(
                ("file_read", {"path": "src/fixture.ts"}),
                reasoning=[{"type": "reasoning.encrypted", "data": "opaque" + str(i)}],
            )["message"]
            self.messages.extend(
                [
                    generated,
                    {
                        "role": "tool",
                        "tool_call_id": generated["tool_calls"][0]["id"],
                        "content": json.dumps(
                            {"text": "EARLY_EVIDENCE" if i == 0 else "x" * 2500}
                        ),
                    },
                ]
            )
        latest = copy.deepcopy(self.messages[-2:])
        original = copy.deepcopy(self.messages[:2])
        model = ScriptedModel(
            generation(
                (
                    "notes_update",
                    {
                        "subtask": "Prepare brief",
                        "findings": "EARLY_EVIDENCE was observed at src/fixture.ts",
                        "nextAction": "Report plan",
                    },
                )
            ),
            generation(report("plan_ready", plan="Use EARLY_EVIDENCE in the repair")),
        )
        result = await self.run_loop(model)
        self.assertEqual(result.kind, "plan_ready")
        self.assertEqual(self.memory.compactions, 1)
        self.assertEqual(self.messages[:2], original)
        self.assertTrue(all(m in model.inputs[-1] for m in latest))
        self.assertTrue(
            any(
                "EARLY_EVIDENCE was observed" in (m.get("content") or "")
                for m in model.inputs[-1]
            )
        )
        self.assertLess(len(model.inputs[-1]), len(model.inputs[0]))
        self.assertEqual(self.budget.tools, 98)  # Summary update and final report.

    async def test_failed_summary_checkpoint_does_not_discard_history(self):
        self.messages += [
            {"role": "user", "content": "historic evidence " + str(i)}
            for i in range(90)
        ]
        before = copy.deepcopy(self.messages)

        async def rejected():
            raise GatewayError(409)

        model = ScriptedModel(
            generation(
                (
                    "notes_update",
                    {
                        "subtask": "Summary",
                        "findings": "Retained evidence",
                        "nextAction": "Continue",
                    },
                )
            )
        )
        with self.assertRaises(SquadExecutionError):
            await self.run_loop(model, runtime_checkpoint=rejected)
        self.assertEqual(self.messages, before)

    async def test_repeated_reads_receive_nudge_reset_then_specific_pause(self):
        class RepeatingModel:
            async def generate(inner, messages, tools):
                if len(tools) == 1 and tools[0]["name"] == "notes_update":
                    return generation(
                        (
                            "notes_update",
                            {
                                "subtask": "Repeated fixture inspection",
                                "findings": "The file remains unchanged",
                                "nextAction": "Search for another relevant file",
                            },
                        )
                    )
                return generation(("file_read", {"path": "src/fixture.ts"}))

        with self.assertRaises(LoopStalled):
            await self.run_loop(RepeatingModel())
        self.assertEqual(self.memory.nudges, 1)
        self.assertEqual(self.memory.resets, 1)
        self.assertGreater(self.budget.models, 0)
        self.assertTrue(self.saved[-1].notes.findings)

    async def test_changed_file_reads_are_progress_and_not_a_loop(self):
        class ChangingModel:
            def __init__(inner):
                inner.turn = 0

            async def generate(inner, messages, tools):
                inner.turn += 1
                if inner.turn == 15:
                    return generation(
                        report("plan_ready", plan="A complete synthetic brief")
                    )
                await self.w.write("src/fixture.ts", "new evidence " + str(inner.turn))
                return generation(("file_read", {"path": "src/fixture.ts"}))

        result = await self.run_loop(ChangingModel())
        self.assertEqual(result.kind, "plan_ready")
        self.assertEqual(self.memory.nudges, 0)
        self.assertEqual(len(self.memory.receipts), 14)

    async def test_one_fresh_generation_recovers_without_replaying_tools(self):
        class RetryModel:
            def __init__(inner):
                inner.calls = 0

            async def generate(inner, messages, tools):
                inner.calls += 1
                if inner.calls == 1:
                    raise GatewayError(409, "model_disconnected")
                return generation(
                    report("plan_ready", plan="The recovered synthetic brief")
                )

        model = RetryModel()
        result = await self.run_loop(model)
        self.assertEqual(result.kind, "plan_ready")
        self.assertEqual(model.calls, 2)
        self.assertEqual(self.budget.models, 38)
        self.assertEqual(self.memory.toolsUsed, 1)

    async def test_notes_cannot_approve_an_unread_plan(self):
        model = ScriptedModel(
            generation(
                (
                    "notes_update",
                    {
                        "subtask": "Review",
                        "findings": "I claim the plan was read",
                        "nextAction": "Approve",
                    },
                )
            ),
            generation(report("APPROVE")),
            generation(("plan_read", {})),
            generation(report("APPROVE")),
        )
        result = await coding_loop(
            model=model,
            workspace=self.w,
            messages=self.messages,
            mode="review",
            budget=self.budget,
            stop=self.stop,
            checkpoint=self.checkpoint,
            memory=self.memory,
            runtime_checkpoint=self.checkpoint,
            plan=lambda: "The complete approved scope",
        )
        self.assertEqual(result.kind, "APPROVE")
        self.assertEqual(len(model.inputs), 4)
        self.assertTrue(
            any(
                "Read the complete saved plan" in (m.get("content") or "")
                for m in model.inputs[2]
            )
        )

    def test_notebook_unicode_and_unknown_fields_remain_bounded(self):
        with self.assertRaises(ValueError):
            Notebook(findings="😀" * 3001)
        with self.assertRaises(ValueError):
            Notebook.model_validate({"approvedScope": "different task"})
