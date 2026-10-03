"""CI executes the real Linux launcher using synthetic credentials only."""

import os
import subprocess
import sys

from .worker import lockdown

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
