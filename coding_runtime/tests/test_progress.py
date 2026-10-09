from __future__ import annotations

import asyncio
import copy
import json
import tempfile
import unittest
from pathlib import Path

from test_runtime import ScriptedModel, generation, report

from chief_coding_runtime import inspection
from chief_coding_runtime.loop import (
    AllocationExhausted,
    Budget,
    SquadExecutionError,
    coding_loop,
)
from chief_coding_runtime.memory import ContextRecoveryError, LoopStalled, observe
from chief_coding_runtime.model import GatewayError, InvalidGeneration
from chief_coding_runtime.protocol import LoopMemory, Notebook, text_clip, utf16_length
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

    async def test_long_audit_is_revised_without_losing_notes_or_approved_scope(self):
        findings = (
            "Verified src/fixture.ts behavior. Alternative requires owner scope change."
        )
        brief = "**Scope**\nRepair the requested fixture behavior.\n\n**Acceptance**\nRun the existing checks and retain unrelated behavior."
        model = ScriptedModel(
            generation(
                (
                    "notes_update",
                    {
                        "subtask": "Prepare proposal",
                        "findings": findings,
                        "nextAction": "Report concise complete scope",
                    },
                )
            ),
            generation(
                report("plan_ready", plan="Detailed evidence and alternatives. " * 390)
            ),
            generation(report("plan_ready", plan=brief)),
        )
        result = await self.run_loop(model)
        self.assertEqual(result.plan, brief)
        self.assertEqual(self.saved[-1].notes.findings, findings)
        errors = [
            json.loads(m["content"]) for m in model.inputs[-1] if m["role"] == "tool"
        ]
        rejected = next(
            e for e in errors if e.get("code") == "plan_brief_revision_required"
        )
        self.assertIn("Preserve every requirement", rejected["error"])
        self.assertIn("awaiting_input", rejected["error"])
        self.assertEqual(self.memory.toolsUsed, 3)

    async def test_brief_bounds_count_utf16_and_allow_clarification(self):
        for plan, summary in [("😀" * 3001, "Status"), ("Complete scope", "😀" * 201)]:
            with self.subTest(plan_length=len(plan), summary_length=len(summary)):
                model = ScriptedModel(
                    generation(
                        (
                            "report",
                            {"kind": "plan_ready", "plan": plan, "summary": summary},
                        )
                    ),
                    generation(
                        (
                            "report",
                            {
                                "kind": "awaiting_input",
                                "summary": "Scope needs dividing",
                                "question": "May we divide the work into independently approved tasks?",
                            },
                        )
                    ),
                )
                result = await self.run_loop(model)
                self.assertEqual(result.kind, "awaiting_input")
                error = next(
                    json.loads(m["content"])
                    for m in model.inputs[-1]
                    if m["role"] == "tool"
                )
                self.assertEqual(error["code"], "plan_brief_revision_required")
        model = ScriptedModel(
            generation(
                (
                    "report",
                    {"kind": "plan_ready", "plan": "😀" * 3000, "summary": "😀" * 200},
                )
            )
        )
        result = await self.run_loop(model)
        self.assertEqual(utf16_length(result.plan), 6000)
        self.assertEqual(utf16_length(result.summary), 400)

    def large_history(self):
        self.messages.extend({"role": "user", "content": "x" * 11000} for _ in range(9))
        return copy.deepcopy(self.messages)

    async def test_oversized_summary_is_revised_before_history_is_compacted(self):
        original = self.large_history()
        self.memory.notes = Notebook(
            subtask="Inspect", findings="KEEP_SCOPE", nextAction="Continue"
        )
        rejected = generation(
            (
                "notes_update",
                {
                    "subtask": "Inspect",
                    "findings": "x" * 6511,
                    "nextAction": "Continue",
                },
            ),
            reasoning=[{"type": "reasoning.encrypted", "data": "opaque summary"}],
        )
        rejected["message"].pop("content")
        model = ScriptedModel(
            rejected,
            generation(
                (
                    "notes_update",
                    {
                        "findings": "KEEP_SCOPE with evidence refs",
                    },
                )
            ),
            generation(
                report("plan_ready", plan="Complete scope and acceptance checks")
            ),
        )
        result = await self.run_loop(model)
        self.assertEqual(result.kind, "plan_ready")
        self.assertEqual(model.inputs[1][: len(original)], original)
        retry = next(m for m in model.inputs[1] if m["role"] == "assistant")
        self.assertIn("content", retry)
        self.assertIsNone(retry["content"])
        self.assertEqual(retry["tool_calls"], rejected["message"]["tool_calls"])
        self.assertEqual(
            retry["reasoning_details"], rejected["message"]["reasoning_details"]
        )
        error = next(
            json.loads(m["content"]) for m in model.inputs[1] if m["role"] == "tool"
        )
        self.assertEqual(error["code"], "notebook_revision_required")
        self.assertEqual(error["fieldUnits"]["findings"], 6511)
        self.assertEqual(self.memory.compactions, 1)
        self.assertEqual(self.memory.notes.findings, "KEEP_SCOPE with evidence refs")
        self.assertEqual(self.memory.modelCalls, 3)
        self.assertEqual(self.memory.toolsUsed, 2)

    async def test_transient_generation_and_invalid_summary_have_separate_bounded_repairs(
        self,
    ):
        for transient_first in (True, False):
            with self.subTest(transient_first=transient_first):
                self.memory = LoopMemory()
                self.messages = [
                    {"role": "system", "content": "Synthetic rules"},
                    {"role": "user", "content": "Immutable scope"},
                ]
                original = self.large_history()
                self.budget = Budget(10, 10)

                class MixedModel(ScriptedModel):
                    def __init__(inner, *responses, failure_index=0):
                        super().__init__(*responses)
                        inner.failure_index = failure_index

                    async def generate(inner, messages, tools):
                        index = len(inner.inputs)
                        if index == inner.failure_index:
                            inner.inputs.append(copy.deepcopy(messages))
                            raise GatewayError(409, "model_transient_failure")
                        return await super().generate(messages, tools)

                model = MixedModel(
                    generation(
                        (
                            "notes_update",
                            {
                                "subtask": "Inspect",
                                "findings": "x" * 6055,
                                "nextAction": "Continue",
                            },
                        )
                    ),
                    generation(
                        (
                            "notes_update",
                            {
                                "findings": "Complete scope/evidence retained",
                            },
                        )
                    ),
                    generation(
                        report("plan_ready", plan="Complete requested scope and checks")
                    ),
                )
                model.failure_index = 0 if transient_first else 1
                result = await self.run_loop(model)
                self.assertEqual(result.kind, "plan_ready")
                self.assertEqual(len(model.inputs), 4)
                self.assertEqual(self.memory.compactions, 1)
                self.assertEqual(self.memory.modelCalls, 4)
                self.assertEqual(self.memory.toolsUsed, 2)
                self.assertEqual(model.inputs[2][: len(original)], original)

    async def test_next_action_repair_retains_valid_evidence_and_scope_exactly(self):
        original = self.large_history()
        candidate = {
            "subtask": "Audit only; wait for owner approval before code",
            "findings": "Verified source, error handling and complete acceptance matrix "
            * 40,
            "nextAction": "Detailed implementation instructions " * 33,
            "questions": "No blocking questions",
        }

        class InspectRepairModel(ScriptedModel):
            async def generate(inner, messages, tools):
                if len(inner.inputs) == 1:
                    schema = tools[0]["parameters"]
                    self.assertEqual(set(schema["properties"]), {"nextAction"})
                    self.assertEqual(schema["required"], ["nextAction"])
                    self.assertFalse(schema["additionalProperties"])
                return await super().generate(messages, tools)

        model = InspectRepairModel(
            generation(("notes_update", candidate)),
            generation(
                (
                    "notes_update",
                    {
                        "nextAction": "Wait for owner scope confirmation; then implement verified design"
                    },
                )
            ),
            generation(report("plan_ready", plan="Complete scope and acceptance")),
        )
        result = await self.run_loop(model)
        self.assertEqual(result.kind, "plan_ready")
        for field in ("subtask", "findings", "questions"):
            self.assertEqual(getattr(self.memory.notes, field), candidate[field])
        self.assertEqual(model.inputs[1][: len(original)], original)
        self.assertEqual(self.memory.compactions, 1)
        self.assertEqual(self.memory.modelCalls, 3)
        feedback = next(
            json.loads(m["content"]) for m in model.inputs[1] if m["role"] == "tool"
        )
        self.assertEqual(feedback["repairOnly"], ["nextAction"])
        self.assertEqual(feedback["targetUnits"], {"nextAction": 500})

    async def test_partial_repair_cannot_replace_other_valid_fields(self):
        original = self.large_history()
        self.memory.notes = Notebook(findings="ACKNOWLEDGED")
        model = ScriptedModel(
            generation(
                (
                    "notes_update",
                    {"subtask": "Audit", "findings": "KEEP", "nextAction": "x" * 1163},
                )
            ),
            generation(
                ("notes_update", {"nextAction": "Wait", "findings": "Changed scope"})
            ),
        )
        with self.assertRaises(ContextRecoveryError):
            await self.run_loop(model)
        self.assertEqual(self.messages, original)
        self.assertEqual(self.memory.notes.findings, "ACKNOWLEDGED")
        self.assertEqual(self.memory.compactions, 0)
        self.assertEqual(self.memory.toolsUsed, 0)

    async def test_two_invalid_summaries_pause_with_old_notebook_and_history(self):
        original = self.large_history()
        self.memory.notes = Notebook(
            subtask="Inspect", findings="ACKNOWLEDGED", nextAction="Continue"
        )
        model = ScriptedModel(
            *[
                generation(
                    (
                        "notes_update",
                        {
                            "subtask": "Inspect",
                            "findings": "😀" * 3001,
                            "nextAction": "Continue",
                        },
                    )
                )
                for _ in range(2)
            ]
        )
        with self.assertRaises(ContextRecoveryError):
            await self.run_loop(model)
        self.assertEqual(len(model.inputs), 2)
        self.assertEqual(self.messages, original)
        self.assertEqual(self.memory.notes.findings, "ACKNOWLEDGED")
        self.assertEqual(self.memory.compactions, 0)
        self.assertEqual(self.memory.toolsUsed, 0)

    async def test_summary_repair_cannot_consume_the_only_remaining_continuation_call(
        self,
    ):
        original = self.large_history()
        self.budget = Budget(2, 1)
        model = ScriptedModel(
            generation(
                (
                    "notes_update",
                    {
                        "subtask": "Inspect",
                        "findings": "x" * 6511,
                        "nextAction": "Continue",
                    },
                )
            )
        )
        with self.assertRaises(AllocationExhausted):
            await self.run_loop(model)
        self.assertEqual(len(model.inputs), 1)
        self.assertEqual(self.messages, original)
        self.assertEqual(self.budget.models, 1)
        self.assertEqual(self.budget.tools, 1)

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

    async def test_nudge_cannot_discard_a_large_pending_reasoning_tool_group(self):
        for _ in range(4):
            observe(
                self.memory,
                "file_read",
                {"path": "src/fixture.ts"},
                {"fingerprint": "a" * 64, "start": 0, "end": 10, "unit": "characters"},
            )
        latest = generation(
            ("file_read", {"path": "src/fixture.ts"}),
            reasoning=[{"type": "reasoning.encrypted", "data": "x" * 90000}],
        )["message"]
        result = {
            "role": "tool",
            "tool_call_id": latest["tool_calls"][0]["id"],
            "content": "Current undelivered observation",
        }
        self.messages += [
            {"role": "assistant", "content": "old evidence " + "o" * 16000},
            latest,
            result,
        ]
        model = ScriptedModel(
            generation(
                (
                    "notes_update",
                    {
                        "subtask": "Prepare report",
                        "findings": "Important evidence",
                        "nextAction": "Finish",
                    },
                )
            ),
            generation(report("plan_ready", plan="Complete synthetic brief")),
        )
        await self.run_loop(model)
        self.assertEqual(self.memory.nudges, 1)
        self.assertIn(latest, model.inputs[-1])
        self.assertIn(result, model.inputs[-1])

    async def test_invalid_wire_batch_never_executes_its_valid_first_write(self):
        invalid = generation(
            ("file_write", {"path": "first.txt", "content": "Must not execute"}),
            ("file_write", {"path": "second.txt", "content": "invalid"}),
        )
        invalid["message"]["tool_calls"][1]["function"]["arguments"] = (
            '{"path":"second.txt"'
        )
        model = ScriptedModel(invalid)
        with self.assertRaises(InvalidGeneration):
            await coding_loop(
                model=model,
                workspace=self.w,
                messages=self.messages,
                mode="implement",
                budget=self.budget,
                stop=self.stop,
                checkpoint=self.checkpoint,
                memory=self.memory,
                runtime_checkpoint=self.checkpoint,
            )
        self.assertFalse((self.w.root / "first.txt").exists())
        self.assertFalse((self.w.root / "second.txt").exists())

    async def test_reset_with_one_tool_left_saves_one_summary_then_reports_allocation(
        self,
    ):
        self.budget = Budget(10, 1)
        self.memory.loopLevel = 1
        for _ in range(4):
            observe(
                self.memory,
                "file_read",
                {"path": "src/fixture.ts"},
                {"fingerprint": "a" * 64, "start": 0, "end": 10, "unit": "characters"},
            )
        self.memory.loopLevel = 1
        latest = generation(
            ("file_read", {"path": "src/fixture.ts"}),
            reasoning=[{"type": "reasoning.encrypted", "data": "x" * 105000}],
        )["message"]
        self.messages += [
            latest,
            {
                "role": "tool",
                "tool_call_id": latest["tool_calls"][0]["id"],
                "content": "Pending observation",
            },
        ]
        model = ScriptedModel(
            generation(
                (
                    "notes_update",
                    {
                        "subtask": "Save findings",
                        "findings": "Current evidence retained",
                        "nextAction": "Report blocker",
                    },
                )
            )
        )
        with self.assertRaises(AllocationExhausted) as caught:
            await self.run_loop(model)
        self.assertEqual(caught.exception.resource, "tool calls")
        self.assertEqual(self.budget.tools, 0)
        self.assertEqual(len(model.inputs), 1)
        self.assertEqual(self.memory.compactions, 1)
        self.assertTrue(all(saved.toolsUsed <= 1 for saved in self.saved))

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
        clipped = text_clip("😀" * 500 + ". Next: " + "😀" * 500, 2000)
        self.assertLessEqual(utf16_length(clipped), 2000)
        clipped.encode("utf-16-le", errors="strict")
        with self.assertRaises(ValueError):
            Notebook(findings="😀" * 3001)
        with self.assertRaises(ValueError):
            Notebook.model_validate({"approvedScope": "different task"})

    def test_equivalent_read_forms_and_argument_orders_are_not_new_evidence(self):
        result = {"fingerprint": "a" * 64, "start": 0, "end": 46, "unit": "characters"}
        for arguments in (
            {"path": "src/fixture.ts"},
            {"offset": 0, "path": "src/fixture.ts"},
            {"path": "src/fixture.ts", "startLine": 1, "endLine": 10},
        ):
            observe(self.memory, "file_read", arguments, result)
        self.assertEqual(len(self.memory.receipts), 1)
        self.assertEqual(self.memory.repeatStreak, 2)
