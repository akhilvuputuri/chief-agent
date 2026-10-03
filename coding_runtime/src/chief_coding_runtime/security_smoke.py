"""CI executes the real Linux launcher using synthetic credentials only."""

import asyncio
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from .worker import lockdown
from .workspace import Workspace

lockdown()
assert os.getuid() == 1000
subprocess.run(
    [
        sys.executable,
        "-I",
        "-c",
        f"""
from pathlib import Path
try:
    Path('/proc/{os.getpid()}/environ').read_bytes()
except PermissionError:
    pass
else:
    raise SystemExit('Parent environment must be inaccessible')
""",
    ],
    env={"PATH": os.environ.get("PATH", "")},
    check=True,
    capture_output=True,
)
print("Python worker capability is protected from same-UID commands.")


async def detached_cleanup() -> None:
    workspace = Workspace(
        Path(tempfile.mkdtemp(prefix="chief-smoke-")), asyncio.Event()
    )
    child: int | None = None
    try:
        result = await workspace.command(
            sys.executable,
            [
                "-c",
                "import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'],start_new_session=True); print(p.pid,flush=True); time.sleep(30)",
            ],
            timeout_seconds=0.2,
        )
        child = int(result.text().strip())
        assert result.exit_code != 0
        try:
            os.kill(child, 0)
        except ProcessLookupError:
            pass
        else:
            raise AssertionError("Detached repository child survived command cleanup")
    finally:
        if child is not None:
            try:
                os.kill(child, 9)
            except ProcessLookupError:
                pass
        workspace.close()


asyncio.run(detached_cleanup())
print("Detached command descendants are terminated and reaped.")
