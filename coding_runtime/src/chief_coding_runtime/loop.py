"""Own tool loop with whole-group compaction and delivered-plan review gates."""

from __future__ import annotations

import asyncio
import copy
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import Field, TypeAdapter, field_validator

from .model import ModelAdapter, validate_generation
from .protocol import Json, Record, text_bound, wire_json, wire_size
from .workspace import Workspace


class Read(Record):
    operation: Literal["file_read"]
    path: str
    offset: int = Field(default=0, ge=0)


class Write(Record):
    operation: Literal["file_write"]
    path: str
    content: str


class Delete(Record):
    operation: Literal["file_delete"]
    path: str


class PlanRead(Record):
    operation: Literal["plan_read"]
    offset: int = Field(default=0, ge=0)
    section: Literal["plan", "summary"] = "plan"


class Command(Record):
    operation: Literal["command"]
    command: str = Field(min_length=1, max_length=4000)


class Report(Record):
    operation: Literal["report"]
    kind: Literal[
        "plan_ready", "awaiting_input", "candidate", "APPROVE", "REQUEST_CHANGES"
    ]
    summary: str = Field(min_length=1)
    plan: str = ""
    question: str = ""

    def validate_text(self) -> None:
        if self.kind == "plan_ready" and not self.plan.strip():
            raise ValueError("A complete requirement brief is required in plan")
        text_bound(self.summary, 4000)
        text_bound(self.plan, 32000)
        text_bound(self.question, 2000)


class DispatchRejected(ValueError):
    """Rejected before any member execution; leader may correct its request."""


class SquadExecutionError(RuntimeError):
    """A started/uncertain dispatch must pause rather than be replayed."""


class Assign(Record):
    operation: Literal["assign_coder", "assign_reviewer"]
    instructions: str = Field(min_length=1, max_length=4000)
    candidateHash: str = ""

    @field_validator("instructions")
    @classmethod
    def bounded_instructions(cls, value: str) -> str:
        return text_bound(value, 4000)


LEADER_TOOLS: list[Json] = [
    {
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": {
                "instructions": {"type": "string", "maxLength": 4000},
                "candidateHash": {"type": "string"},
            },
            "required": required,
            "additionalProperties": False,
        },
    }
    for name, description, required in (
        (
            "assign_coder",
            "Delegate implementation or review findings to the coder. Cannot change the approved scope.",
            ["instructions"],
        ),
        (
            "assign_reviewer",
            "Delegate the exact verified candidate hash to a fresh read-only reviewer. Passing checks are required.",
            ["instructions", "candidateHash"],
        ),
    )
]

TOOLS: list[Json] = [
    {
        "name": "plan_read",
        "description": "Read the saved plan or progress summary in bounded pages. Follow nextOffset until null; previews are incomplete. Approval requires the complete plan.",
        "parameters": {
            "type": "object",
            "properties": {
                "offset": {"type": "integer", "minimum": 0},
                "section": {"type": "string", "enum": ["plan", "summary"]},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "file_read",
        "description": "Read a repository file in bounded pages.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "offset": {"type": "integer", "minimum": 0},
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "file_write",
        "description": "Write a complete UTF-8 repository file. Read before editing.",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"],
            "additionalProperties": False,
        },
    },
    {
        "name": "file_delete",
        "description": "Delete a repository file in the requested change.",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "command",
        "description": "Execute a command in the disposable checkout. Prefer rg to search. Output is bounded; use files for large results.",
        "parameters": {
            "type": "object",
            "properties": {"command": {"type": "string"}},
            "required": ["command"],
            "additionalProperties": False,
        },
    },
    {
        "name": "report",
        "description": "Return a plan, question, candidate or independent review verdict. For plan_ready, put the complete requirement brief in the non-empty plan field; summary alone is insufficient.",
        "parameters": {
            "type": "object",
            "properties": {
                "kind": {
                    "type": "string",
                    "enum": [
                        "plan_ready",
                        "awaiting_input",
                        "candidate",
                        "APPROVE",
                        "REQUEST_CHANGES",
                    ],
                },
                "summary": {"type": "string"},
                "plan": {"type": "string"},
                "question": {"type": "string"},
            },
            "required": ["kind", "summary"],
            "additionalProperties": False,
        },
    },
]
READ_COMMANDS: dict[str, tuple[str, ...]] = {
    "git status --short": ("git", "status", "--short"),
    "git diff --cached --no-ext-diff": ("git", "diff", "--cached", "--no-ext-diff"),
    "git ls-files": ("git", "ls-files"),
    "rg --files": ("rg", "--files"),
}
ACTION: TypeAdapter[Read | Write | Delete | PlanRead | Command | Report | Assign] = (
    TypeAdapter(Read | Write | Delete | PlanRead | Command | Report | Assign)
)


@dataclass
class Budget:
    models: int
    tools: int


def compact(messages: list[Json], tools: list[Json]) -> None:
    # Provider reasoning and tool arguments are immutable; omit complete old groups.
    while (
        wire_size(
            {
                "callId": "00000000-0000-4000-8000-000000000000",
                "role": "reviewer",
                "messages": messages,
                "tools": tools,
            }
        )
        > 150000
        or len(messages) > 110
    ):
        end = 2
        if len(messages) <= end:
            raise ValueError("Protected assignment exceeds model envelope")
        if messages[end].get("role") == "assistant" and messages[end].get("tool_calls"):
            end += 1
            while end < len(messages) and messages[end].get("role") == "tool":
                end += 1
        else:
            end += 1
        if end >= len(messages):
            raise ValueError(
                "Current call group exceeds model envelope; no reasoning may be altered"
            )
        del messages[2:end]


async def coding_loop(
    *,
    model: ModelAdapter,
    workspace: Workspace,
    messages: list[Json],
    mode: Literal["plan", "implement", "review", "lead"],
    budget: Budget,
    stop: asyncio.Event,
    checkpoint: Callable[[], Awaitable[None]],
    plan: Callable[[], str] | None = None,
    summary: Callable[[], str] | None = None,
    dispatch: Callable[[Assign], Awaitable[Json]] | None = None,
    can_finish: Callable[[], bool] | None = None,
) -> Report:
    tools = [
        copy.deepcopy(t)
        for t in TOOLS
        if (
            mode == "implement"
            or t["name"] in ("file_read", "plan_read", "report", "command")
        )
        and (t["name"] != "plan_read" or plan is not None)
    ]
    if mode == "lead":
        tools += copy.deepcopy(LEADER_TOOLS)
    plan_read_until = 0
    while budget.models > 0 and budget.tools > 0 and not stop.is_set():
        compact(messages, tools)
        delivered = plan_read_until
        budget.models -= 1
        generation = validate_generation(await model.generate(messages, tools))
        raw = generation["message"]
        message = {
            key: copy.deepcopy(raw[key])
            for key in ("role", "content", "tool_calls", "reasoning_details")
            if key in raw
        }
        message.setdefault("content", None)
        messages.append(message)
        calls = message.get("tool_calls", [])
        if not calls:
            messages.append(
                {
                    "role": "user",
                    "content": "Use report for the result, or continue with the available tools.",
                }
            )
            continue
        observation_chars = max(500, 36000 // (6 * len(calls)))
        for index, call in enumerate(calls):
            if stop.is_set():
                raise asyncio.CancelledError("Coding stopped")
            if budget.tools <= 0:
                # Fill unstarted slots coherently; the allocation remains exhausted.
                for pending in calls[index:]:
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": pending["id"],
                            "content": '{"skipped":"allocation exhausted"}',
                        }
                    )
                raise ValueError("Coding allocation exhausted")
            budget.tools -= 1
            result: Any
            try:
                arguments = json.loads(call["function"]["arguments"])
                if not isinstance(arguments, dict) or "operation" in arguments:
                    raise ValueError("Invalid tool arguments")
                action = ACTION.validate_python(
                    {**arguments, "operation": call["function"]["name"]}
                )
                if isinstance(action, Report):
                    action.validate_text()
                    allowed = {
                        "plan": ("plan_ready", "awaiting_input"),
                        "implement": ("candidate", "awaiting_input"),
                        "review": ("APPROVE", "REQUEST_CHANGES"),
                        "lead": ("candidate", "awaiting_input"),
                    }[mode]
                    if (
                        mode == "lead"
                        and action.kind == "candidate"
                        and (can_finish is None or not can_finish())
                    ):
                        raise ValueError(
                            "The latest candidate needs passing checks and reviewer approval"
                        )
                    if action.kind not in allowed:
                        raise ValueError("Report does not match runtime mode")
                    if (
                        mode == "review"
                        and action.kind == "APPROVE"
                        and plan
                        and delivered < len(plan())
                    ):
                        result = {
                            "error": "Read the complete saved plan before approving; a later model request must receive the final page.",
                            "nextOffset": plan_read_until,
                        }
                    else:
                        for pending in calls[index:]:
                            messages.append(
                                {
                                    "role": "tool",
                                    "tool_call_id": pending["id"],
                                    "content": wire_json(
                                        {
                                            "reported": pending["id"] == call["id"],
                                            "skipped": pending["id"] != call["id"],
                                        }
                                    ),
                                }
                            )
                        return action
                elif isinstance(action, Assign):
                    if mode != "lead" or dispatch is None:
                        raise ValueError(
                            "Only the leader can delegate to fixed squad members"
                        )
                    try:
                        result = await dispatch(action)
                    except DispatchRejected:
                        raise
                    except Exception as error:
                        raise SquadExecutionError(
                            "Member execution stopped; inspect acknowledged state"
                        ) from error
                elif isinstance(action, PlanRead):
                    if plan is None:
                        raise ValueError("Plan reader unavailable")
                    text = (
                        (summary() if summary else "")
                        if action.section == "summary"
                        else plan()
                    )
                    page = text[action.offset : action.offset + observation_chars]
                    if action.section == "plan" and action.offset <= plan_read_until:
                        plan_read_until = max(
                            plan_read_until, min(len(text), action.offset + len(page))
                        )
                    result = {
                        "text": page,
                        "nextOffset": action.offset + len(page)
                        if action.offset + len(page) < len(text)
                        else None,
                    }
                elif isinstance(action, Read):
                    result = await workspace.read(
                        action.path, action.offset, observation_chars
                    )
                elif isinstance(action, (Write, Delete)):
                    if mode != "implement":
                        raise ValueError("Read-only agent cannot change files")
                    if isinstance(action, Write):
                        text_bound(action.content, 128000)
                        result = await workspace.write(action.path, action.content)
                    else:
                        result = await workspace.remove(action.path)
                    await checkpoint()
                elif isinstance(action, Command):
                    if mode != "implement":
                        parts = READ_COMMANDS.get(action.command)
                        if parts is None:
                            raise ValueError("Read-only command form rejected")
                        result = (
                            await workspace.command(
                                parts[0], parts[1:], max_output=observation_chars
                            )
                        ).wire()
                    else:
                        result = (
                            await workspace.command(
                                action.command, shell=True, max_output=observation_chars
                            )
                        ).wire()
                        await checkpoint()
            except Exception as error:
                if isinstance(error, SquadExecutionError):
                    raise
                result = {
                    "error": "Tool rejected or failed; inspect files and adjust the call. Paths, modes and limits are enforced by the host."
                }
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call["id"],
                    "content": wire_json(result),
                }
            )
    if stop.is_set():
        raise asyncio.CancelledError("Coding stopped")
    raise ValueError("Coding allocation exhausted")
