"""Byte-exact Git artifacts and bounded, cancellable process supervision."""

from __future__ import annotations

import asyncio
import ctypes
import hashlib
import os
import shutil
import signal
import sys
import tempfile
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, cast

from .protocol import Checkpoint, File, utf16_length, validate_files, validate_path

_COMMAND_LOCK = asyncio.Lock()


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
        # One worker owns its subprocess tree. Reparent detached/double-forked
        # descendants here so they cannot escape command cleanup on Linux.
        if sys.platform == "linux" and ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
            raise ValueError("Subprocess ownership isolation failed")
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
        # The runtime intentionally runs one repository command at a time.
        async with _COMMAND_LOCK:
            return await self._command(
                command, args, shell, timeout_seconds, max_output
            )

    async def _command(
        self,
        command: str,
        args: Sequence[str],
        shell: bool,
        timeout_seconds: float,
        max_output: int,
    ) -> CommandResult:
        if self.stop.is_set():
            raise asyncio.CancelledError("Coding stopped")
        baseline = self._children(os.getpid())
        read_fd, write_fd = os.pipe()
        pipe = os.fdopen(read_fd, "rb", buffering=0)
        output_reader = asyncio.StreamReader()
        transport: asyncio.ReadTransport | None = None
        process: asyncio.subprocess.Process | None = None
        spawn: asyncio.Task[asyncio.subprocess.Process] | None = None
        reader: asyncio.Task[None] | None = None
        stopped: asyncio.Task[bool] | None = None
        waited: asyncio.Task[int] | None = None
        output = bytearray()
        truncated = False

        async def drain() -> None:
            nonlocal truncated
            while chunk := await output_reader.read(8192):
                output.extend(chunk)
                if len(output) > max_output:
                    truncated = True
                    del output[:-max_output]

        try:
            transport, _ = await asyncio.get_running_loop().connect_read_pipe(
                lambda: asyncio.StreamReaderProtocol(output_reader), pipe
            )
            kwargs: dict[str, Any] = {
                "cwd": self.root,
                "env": self.environment(),
                "stdin": asyncio.subprocess.DEVNULL,
                # Own the read transport separately: process.wait() must never
                # wait for a detached descendant's inherited output descriptor.
                "stdout": write_fd,
                "stderr": write_fd,
                "start_new_session": True,
            }
            spawn = asyncio.create_task(
                asyncio.create_subprocess_shell(command, **kwargs)
                if shell
                else asyncio.create_subprocess_exec(command, *args, **kwargs)
            )
            process = await asyncio.shield(spawn)
            os.close(write_fd)
            write_fd = -1
            reader = asyncio.create_task(drain())
            stopped = asyncio.create_task(self.stop.wait())
            waited = asyncio.create_task(process.wait())
            await asyncio.wait(
                [waited, stopped],
                timeout=timeout_seconds,
                return_when=asyncio.FIRST_COMPLETED,
            )
            await self._cleanup(process, baseline)
            await waited
            try:
                await asyncio.wait_for(asyncio.shield(reader), 1)
            except TimeoutError:
                transport.close()
                await asyncio.wait_for(reader, 1)
            if self.stop.is_set():
                raise asyncio.CancelledError("Coding stopped")
            return CommandResult(
                process.returncode if process.returncode is not None else -1,
                bytes(output),
                truncated,
            )
        finally:
            if process is None and spawn is not None:
                try:
                    process = await asyncio.shield(spawn)
                except Exception:
                    pass
            try:
                if process is not None:
                    await self._cleanup(process, baseline)
            finally:
                if write_fd >= 0:
                    os.close(write_fd)
                if transport is not None:
                    transport.close()
                else:
                    pipe.close()
                for task in (reader, stopped, waited):
                    if task and not task.done():
                        task.cancel()
                await asyncio.gather(
                    *(t for t in (reader, stopped, waited) if t), return_exceptions=True
                )

    @staticmethod
    def _children(pid: int) -> set[int]:
        if sys.platform != "linux":
            return set()
        try:
            return {
                int(value)
                for value in Path(f"/proc/{pid}/task/{pid}/children")
                .read_text()
                .split()
            }
        except FileNotFoundError:
            return set()

    async def _cleanup(
        self, process: asyncio.subprocess.Process, baseline: set[int]
    ) -> None:
        self._kill(process)
        try:
            await asyncio.wait_for(process.wait(), 2)
        except TimeoutError:
            self.stop.set()
            raise asyncio.CancelledError(
                "Command termination could not be verified"
            ) from None
        if sys.platform != "linux":
            return
        deadline = time.monotonic() + 2
        while True:
            # Killing each adopted direct child reparents its own descendants
            # here. Reading our own children needs no access to child memory.
            descendants = self._children(os.getpid()) - baseline
            for pid in descendants:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    os.waitpid(pid, os.WNOHANG)  # noqa: ASYNC222 -- WNOHANG never blocks.
                except ChildProcessError:
                    pass
            if not (self._children(os.getpid()) - baseline):
                break
            if time.monotonic() >= deadline:
                self.stop.set()
                raise asyncio.CancelledError("Subprocess cleanup could not be verified")
            await asyncio.sleep(0.01)

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
