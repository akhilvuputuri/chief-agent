#!/usr/bin/env python3
"""Append one sanitized host-health JSON line. Metadata only: no environment
values, database rows, container output or file contents."""
import datetime, json, os, pathlib, shutil, subprocess

BASE = pathlib.Path("/opt/hermes-companion")


def run(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=20)
    return result.stdout.strip() if result.returncode == 0 else None


def main():
    disk = shutil.disk_usage("/")
    mem = {}
    for line in pathlib.Path("/proc/meminfo").read_text().splitlines():
        key, value = line.split(":", 1)
        if key in ("MemAvailable", "SwapTotal", "SwapFree"):
            mem[key] = int(value.split()[0]) // 1024
    services = {}
    raw = run("docker", "compose", "--project-directory", str(BASE), "-p",
              "hermes-companion", "ps", "--all", "--format", "json")
    for line in (raw or "").splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        name = row.get("Service")
        if name in ("gateway", "postgres"):
            services[name] = {"state": row.get("State"), "health": row.get("Health") or None}
    release = (BASE / "RELEASE").read_text().strip() if (BASE / "RELEASE").is_file() else None
    entry = {
        "schema": "chief.host/1",
        "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "event": "host.health",
        "release": release if release and len(release) == 40 else None,
        "diskUsedPct": round(100 * disk.used / disk.total, 1),
        "memAvailableMb": mem.get("MemAvailable"),
        "swapUsedMb": (mem.get("SwapTotal", 0) - mem.get("SwapFree", 0)),
        "load1": round(os.getloadavg()[0], 2),
        "services": services,
        "backupTimer": run("systemctl", "is-active", "hermes-backup.timer"),
        "backupResult": (run("systemctl", "show", "hermes-backup.service", "-p", "Result", "--value")),
        "exporter": run("systemctl", "is-active", "chief-log-export.service"),
        "caddy": run("systemctl", "is-active", "caddy"),
    }
    out = pathlib.Path("/var/log/chief/host-health.jsonl")
    out.parent.mkdir(mode=0o750, exist_ok=True)
    with out.open("a") as handle:
        handle.write(json.dumps(entry, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
