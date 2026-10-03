"""Byte-exact Git artifacts and bounded, cancellable process supervision."""

from __future__ import annotations

import asyncio
import hashlib
import os
import shutil
import signal
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, cast

from .protocol import Checkpoint, File, utf16_length, validate_files, validate_path


@dataclass(frozen=True)
class CommandResult:
    exit_code: int
    output: bytes
    truncated: bool

    def text(self) -> str:
        return self.output.decode("utf-8", errors="replace")

    def wire(self) -> dict[str, object]:
        return {
            "exitCode": self.exit_code,
            "output": self.text(),
            "truncated": self.truncated,
        }


class Workspace:
    def __init__(self, root: Path, stop: asyncio.Event) -> None:
        self.root = root.resolve(strict=True)
        self.stop = stop
        self.home = Path(tempfile.mkdtemp(prefix="chief-tools-"))

    def close(self) -> None:
        shutil.rmtree(self.home, ignore_errors=True)
        shutil.rmtree(self.root, ignore_errors=True)

    def environment(self) -> dict[str, str]:
        return {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": str(self.home),
            "NPM_CONFIG_CACHE": str(self.home / "npm-cache"),
            "XDG_CACHE_HOME": str(self.home / "cache"),
            "TMPDIR": tempfile.gettempdir(),
            "LANG": "C.UTF-8",
            "CI": "true",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
        }

    async def command(
        self,
        command: str,
        args: Sequence[str] = (),
        *,
        shell: bool = False,
        timeout_seconds: float = 120,
        max_output: int = 32000,
    ) -> CommandResult:
        if self.stop.is_set():
            raise asyncio.CancelledError("Coding stopped")
        kwargs: dict[str, Any] = {
            "cwd": self.root,
            "env": self.environment(),
            "stdin": asyncio.subprocess.DEVNULL,
            "stdout": asyncio.subprocess.PIPE,
            "stderr": asyncio.subprocess.STDOUT,
            "start_new_session": True,
        }
        spawn = asyncio.create_task(
            asyncio.create_subprocess_shell(command, **kwargs)
            if shell
            else asyncio.create_subprocess_exec(command, *args, **kwargs)
        )
        process: asyncio.subprocess.Process | None = None
        output = bytearray()
        truncated = False
        reader: asyncio.Task[None] | None = None
        stopped: asyncio.Task[bool] | None = None
        waited: asyncio.Task[int] | None = None

        async def drain() -> None:
            nonlocal truncated
            assert process is not None and process.stdout is not None
            while chunk := await process.stdout.read(8192):
                output.extend(chunk)
                if len(output) > max_output:
                    truncated = True
                    del output[:-max_output]

        try:
            process = await asyncio.shield(spawn)
            reader = asyncio.create_task(drain())
            stopped = asyncio.create_task(self.stop.wait())
            waited = asyncio.create_task(process.wait())
            done, _ = await asyncio.wait(
                [waited, stopped],
                timeout=timeout_seconds,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if stopped in done or waited not in done:
                self._kill(process)
            await waited
            # Background descendants cannot keep pipes or writable review workspaces alive.
            self._kill(process)
            await reader
            if self.stop.is_set():
                raise asyncio.CancelledError("Coding stopped")
            return CommandResult(
                process.returncode if process.returncode is not None else -1,
                bytes(output),
                truncated,
            )
        finally:
            if process is None:
                process = await asyncio.shield(spawn)
            self._kill(process)
            await process.wait()
            for task in (reader, stopped, waited):
                if task and not task.done():
                    task.cancel()
            await asyncio.gather(
                *(t for t in (reader, stopped, waited) if t), return_exceptions=True
            )

    @staticmethod
    def _kill(process: asyncio.subprocess.Process) -> None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def path(self, value: str, writing: bool = False) -> Path:
        validate_path(value)
        result = self.root / value
        parent = result.parent
        while not parent.exists():
            parent = parent.parent
        if (
            not parent.resolve(strict=True).is_relative_to(self.root)
            or result.is_symlink()
        ):
            raise ValueError("Path leaves the workspace or is a symlink")
        if not writing and not result.exists():
            raise FileNotFoundError(value)
        return result

    async def read(
        self, path: str, offset: int = 0, limit: int = 6000
    ) -> dict[str, object]:
        text = self.path(path).read_bytes().decode("utf-8", errors="strict")
        if "\0" in text:
            raise ValueError("Binary files unsupported")
        page = text[offset : offset + limit]
        return {
            "text": page,
            "nextOffset": offset + len(page)
            if offset + len(page) < len(text)
            else None,
        }

    async def write(self, path: str, content: str) -> dict[str, bool]:
        result = self.path(path, writing=True)
        result.parent.mkdir(parents=True, exist_ok=True)
        result.write_bytes(content.encode("utf-8", errors="strict"))
        return {"written": True}

    async def remove(self, path: str) -> dict[str, bool]:
        self.path(path).unlink()
        return {"removed": True}

    async def restore(self, checkpoint: Checkpoint) -> None:
        validate_files(checkpoint.files)
        for file in checkpoint.files:
            if file.content is None:
                try:
                    await self.remove(file.path)
                except FileNotFoundError:
                    pass
            else:
                await self.write(file.path, file.content)
                if file.mode:
                    self.path(file.path).chmod(
                        0o755 if file.mode == "100755" else 0o644
                    )

    async def git(self, *args: str, limit: int = 500000) -> bytes:
        result = await self.command("git", args, max_output=limit)
        if result.exit_code or result.truncated:
            raise ValueError("Git operation failed or exceeded the artifact bound")
        return result.output

    async def snapshot(self, plan: str, summary: str) -> Checkpoint:
        await self.git("add", "-A")
        patch_bytes = await self.git(
            "diff", "--cached", "--no-ext-diff", "--no-renames", "--binary", "--patch"
        )
        patch = patch_bytes.decode("utf-8", errors="strict")
        names = (
            (
                await self.git(
                    "diff", "--cached", "--name-only", "--no-renames", "-z", limit=32000
                )
            )
            .decode("utf-8", errors="strict")
            .split("\0")
        )
        changed = [name for name in names if name]
        if len(changed) > 100:
            raise ValueError("Too many changed files")
        for name in changed:
            validate_path(name)
        index = (
            await self.git("ls-files", "--stage", "-z", "--", *changed)
            if changed
            else b""
        )
        entries: dict[str, tuple[str, str]] = {}
        for entry in index.decode("utf-8", errors="strict").split("\0"):
            if entry:
                meta, name = entry.split("\t", 1)
                mode, sha, stage = meta.split(" ")
                if stage != "0":
                    raise ValueError("Unresolved index entries")
                entries[name] = (mode, sha)
        files = []
        for name in changed:
            if name not in entries:
                files.append(File(path=name, content=None))
                continue
            mode, identity = entries[name]
            if mode not in ("100644", "100755"):
                raise ValueError("Only regular indexed files supported")
            raw = await self.git("show", f":{name}", limit=512000)
            actual = hashlib.sha1(f"blob {len(raw)}\0".encode() + raw).hexdigest()
            if actual != identity:
                raise ValueError("Indexed blob identity changed")
            content = raw.decode("utf-8", errors="strict")
            if "\0" in content or utf16_length(content) > 128000:
                raise ValueError("Only bounded UTF-8 indexed files supported")
            files.append(
                File(
                    path=name,
                    content=content,
                    mode=cast(Literal["100644", "100755"], mode),
                )
            )
        return Checkpoint(plan=plan, patch=patch, summary=summary, files=files)
