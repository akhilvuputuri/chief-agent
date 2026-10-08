"""Wire contract v1. All external values are data, never execution authority."""

from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

PROTOCOL_VERSION = 1
Json = dict[str, Any]


def wire_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def wire_size(value: Any) -> int:
    return len(wire_json(value).encode("utf-8", errors="strict"))


def utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le", errors="strict")) // 2


def text_bound(value: str, maximum: int) -> str:
    if utf16_length(value) > maximum:
        raise ValueError("Text exceeds the wire contract")
    return value


def text_clip(value: str, maximum: int) -> str:
    units = 0
    for index, char in enumerate(value):
        units += 2 if ord(char) > 0xFFFF else 1
        if units > maximum:
            return value[:index]
    return value


class Record(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class File(Record):
    path: str
    content: str | None
    mode: Literal["100644", "100755"] | None = None

    @field_validator("path")
    @classmethod
    def safe_path(cls, value: str) -> str:
        validate_path(value)
        return value

    @field_validator("content")
    @classmethod
    def bounded_content(cls, value: str | None) -> str | None:
        return None if value is None else text_bound(value, 128000)

    def wire(self) -> Json:
        return {
            "path": self.path,
            "content": self.content,
            **({"mode": self.mode} if self.mode else {}),
        }


def validate_path(path: str) -> None:
    parts = path.split("/")
    if (
        not re.fullmatch(r"[A-Za-z0-9_.\-/]{1,240}", path)
        or any(p in ("", ".", "..", ".git") for p in parts)
        or path.startswith(".github/")
        or (
            any(p == ".env" or p.startswith(".env.") for p in parts)
            and path != ".env.example"
        )
    ):
        raise ValueError("Unsafe credential, workflow or workspace path")


def validate_files(files: list[File]) -> None:
    if len(files) > 100 or len({f.path for f in files}) != len(files):
        raise ValueError("Artifact has too many or duplicate paths")
    if wire_size([f.wire() for f in files]) > 500000:
        raise ValueError("Artifact exceeds supported size")


class Check(Record):
    command: str
    exitCode: int
    output: str


class Review(Record):
    verdict: Literal["APPROVE", "REQUEST_CHANGES"]
    findings: str
    model: str
    patchHash: str


class Handoff(Record):
    id: str
    sender: Literal["leader"] = "leader"
    recipient: Literal["coder", "reviewer"]
    instructions: str
    candidateHash: str = ""

    @field_validator("id")
    @classmethod
    def handoff_id(cls, value: str) -> str:
        UUID(value)
        return value

    @field_validator("instructions")
    @classmethod
    def bounded_instructions(cls, value: str) -> str:
        return text_bound(value, 4000)


Phase = Literal[
    "planning",
    "planned",
    "idle",
    "coding",
    "verifying",
    "reviewing",
    "rework",
    "approved",
    "awaiting_input",
]


class SquadState(Record):
    sequence: Annotated[int, Field(gt=0)]
    revision: Annotated[int, Field(gt=0)]
    attemptId: str
    scopeHash: str
    phase: Phase
    candidateVersion: Annotated[int, Field(ge=0)] = 0
    candidateHash: str = ""
    toolsUsed: Annotated[int, Field(ge=0, le=1000)] = 0
    handoff: Handoff | None = None
    checks: list[Check] = Field(default_factory=list, max_length=4)
    review: Review | None = None
    findings: str = ""

    @field_validator("findings")
    @classmethod
    def bounded_findings(cls, value: str) -> str:
        return text_bound(value, 8000)


class Notebook(Record):
    subtask: str = ""
    findings: str = ""
    nextAction: str = ""
    questions: str = ""

    @field_validator("subtask", "findings", "nextAction", "questions")
    @classmethod
    def bounded_notes(cls, value: str, info: Any) -> str:
        return text_bound(
            value,
            {"subtask": 1000, "findings": 6000, "nextAction": 1000, "questions": 2000}[
                info.field_name
            ],
        )


class Receipt(Record):
    key: str = Field(pattern=r"^[a-f0-9]{64}$")
    tool: str = Field(max_length=40)
    path: str | None = Field(default=None, max_length=240)
    fingerprint: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    start: int | None = Field(default=None, ge=0)
    end: int | None = Field(default=None, ge=0)
    unit: Literal["characters", "lines"] | None = None

    @field_validator("path")
    @classmethod
    def receipt_path(cls, value: str | None) -> str | None:
        if value is not None:
            validate_path(value)
        return value


class LoopMemory(Record):
    notes: Notebook = Field(default_factory=Notebook)
    receipts: list[Receipt] = Field(default_factory=list, max_length=80)
    recent: list[str] = Field(default_factory=list, max_length=16)
    modelCalls: int = Field(default=0, ge=0, le=400)
    toolsUsed: int = Field(default=0, ge=0, le=1000)
    compactions: int = Field(default=0, ge=0, le=400)
    nudges: int = Field(default=0, ge=0, le=1000)
    resets: int = Field(default=0, ge=0, le=400)
    loopLevel: int = Field(default=0, ge=0, le=2)
    repeatStreak: int = Field(default=0, ge=0, le=1000)
    lastProgressAt: str | None = None

    @field_validator("recent")
    @classmethod
    def recent_hashes(cls, value: list[str]) -> list[str]:
        if any(not re.fullmatch(r"[a-f0-9]{64}", item) for item in value):
            raise ValueError("Invalid evidence key")
        return value

    @field_validator("lastProgressAt")
    @classmethod
    def progress_timestamp(cls, value: str | None) -> str | None:
        if value is not None:
            from datetime import datetime

            if not value.endswith("Z"):
                raise ValueError("Progress time must be UTC")
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        return value


class RuntimeMemory(Record):
    scopeHash: str = Field(pattern=r"^[a-f0-9]{64}$")
    leader: LoopMemory | None = None
    coder: LoopMemory | None = None
    reviewer: LoopMemory | None = None


class Checkpoint(Record):
    plan: str = ""
    patch: str = ""
    summary: str = ""
    files: list[File] = Field(default_factory=list, max_length=100)
    squadState: SquadState | None = None
    runtimeMemory: RuntimeMemory | None = None

    @field_validator("plan", "patch", "summary")
    @classmethod
    def bounded_text(cls, value: str, info: Any) -> str:
        return text_bound(
            value, {"plan": 32000, "patch": 500000, "summary": 4000}[info.field_name]
        )

    @field_validator("files")
    @classmethod
    def checked_files(cls, value: list[File]) -> list[File]:
        validate_files(value)
        return value

    def wire(self) -> Json:
        return {
            "plan": self.plan,
            "patch": self.patch,
            "summary": self.summary,
            "files": [f.wire() for f in self.files],
            **(
                {"squadState": self.squadState.model_dump(exclude_none=True)}
                if self.squadState
                else {}
            ),
            **(
                {"runtimeMemory": self.runtimeMemory.model_dump(exclude_none=True)}
                if self.runtimeMemory
                else {}
            ),
        }


def artifact_hash(checkpoint: Checkpoint) -> str:
    value = {
        "patch": checkpoint.patch,
        "files": [f.wire() for f in sorted(checkpoint.files, key=lambda f: f.path)],
    }
    canonical = json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class Limits(Record):
    ms: Annotated[int, Field(gt=0, le=7200000)]
    models: Annotated[int, Field(gt=0, le=400)]
    tools: Annotated[int, Field(gt=0, le=1000)]


class Settings(Record):
    repository: str
    branch: Literal["main"]
    image: str
    model: str
    reviewerModel: str
    leaderModel: str | None = None
    squad: bool = False
    autoMerge: bool = False
    effort: Literal["low", "medium", "high"]
    limits: Limits
    runtime: Literal["node", "python"] = "node"
    harnessVersion: Literal[2] | None = None

    @model_validator(mode="after")
    def harness_compatibility(self) -> Settings:
        if self.harnessVersion == 2 and (self.runtime != "python" or not self.squad):
            raise ValueError("Working-state harness requires the Python squad")
        return self

    @field_validator("repository")
    @classmethod
    def repository_name(cls, value: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value):
            raise ValueError("Invalid repository")
        return value


class Assignment(Record):
    protocolVersion: Literal[1]
    attemptId: str | None = None
    id: str
    revision: Annotated[int, Field(gt=0)]
    objective: str
    context: str
    mode: Literal["plan", "implement"]
    baseSha: str
    settings: Settings
    checkpoint: Checkpoint
    deadline: str
    usedModels: Annotated[int, Field(ge=0)]

    @field_validator("id")
    @classmethod
    def uuid(cls, value: str) -> str:
        UUID(value)
        return value

    @field_validator("baseSha")
    @classmethod
    def sha(cls, value: str) -> str:
        if not re.fullmatch(r"[a-f0-9]{40}", value):
            raise ValueError("Invalid base identity")
        return value


def assert_brief(objective: str, context: str) -> None:
    content = wire_json(
        {
            "objective": objective,
            "context": context,
            "savedPlan": "",
            "savedSummary": "",
        }
    )
    if wire_size({"messages": [{"role": "user", "content": content}]}) > 70000:
        raise ValueError(
            "Owner brief exceeds supported envelope; original instructions must remain intact"
        )


class Outcome(Record):
    kind: Literal["plan_ready", "awaiting_input", "candidate", "paused", "failed"]
    summary: str
    question: str = ""
    checkpoint: Checkpoint
    checks: list[Check] = Field(default_factory=list, max_length=4)
    review: Review | None = None

    def wire(self) -> Json:
        return {
            "kind": self.kind,
            "summary": text_bound(self.summary, 4000),
            "question": text_bound(self.question, 2000),
            "checkpoint": self.checkpoint.wire(),
            "checks": [c.model_dump() for c in self.checks],
            **({"review": self.review.model_dump()} if self.review else {}),
        }


def deadline_seconds(value: str) -> float:
    from datetime import datetime

    timestamp = datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    if not math.isfinite(timestamp):
        raise ValueError("Invalid deadline")
    return timestamp
