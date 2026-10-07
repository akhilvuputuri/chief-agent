"""Offline coding fixtures and isolated candidate grading. No model/publisher client."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import uuid
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
IMAGE = "ghcr.io/akhilvuputuri/chief-agent-coding@sha256:d4be34f01a98a82acf03635d3d44061c2488ed9ed0fbd9cda7b0c46b96f151c8"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_pack() -> dict:
    pack = json.loads((ROOT / "cases.json").read_text())
    for case in pack["cases"]:
        raw = (ROOT / "sources" / case["source_file"]).read_bytes()
        if digest(raw) != case["source_sha256"]:
            raise ValueError(f"Frozen source hash mismatch: {case['id']}")
        if raw.decode().count(case["mutation"]["before"]) != 1:
            raise ValueError("Mutation must match exactly once")
    return pack


def source(case: dict, variant: str = "broken") -> str:
    text = (ROOT / "sources" / case["source_file"]).read_text()
    return (
        text
        if variant == "reference"
        else text.replace(case["mutation"]["before"], case["mutation"]["after"], 1)
    )


def materialize(case: dict, destination: Path, content: str) -> Path:
    destination.mkdir(parents=True, exist_ok=False)
    destination.chmod(0o755)
    target = destination / case["source_path"]
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)
    target.chmod(0o644)
    return target


def prepare(case: dict, destination: Path) -> None:
    materialize(case, destination, source(case))
    # No .git objects, remotes, mutation, gold source or evaluator tests are exported.
    (destination / "TASK.json").write_text(
        json.dumps(
            {
                "instance_id": case["id"],
                "problem_statement": case["problem"],
                "editable_paths": [case["source_path"]],
                "kind": case["kind"],
                "split": case["split"],
            },
            indent=2,
        )
        + "\n"
    )


def command(case: dict, target: str, grader: str, group: str, python: str) -> list[str]:
    if case["language"] == "python":
        return [python, "-I", "-B", grader, target, case["id"], group]
    return ["node", "--experimental-strip-types", grader, target, case["id"], group]


def trusted_check(case: dict, variant: str, group: str) -> int:
    # ONLY bundled, reviewed source and deterministic seeded mutations execute locally.
    # There is deliberately no CLI option for a local candidate path.
    with tempfile.TemporaryDirectory(prefix="chief-oracle-") as tmp:
        target = materialize(case, Path(tmp) / "work", source(case, variant))
        return subprocess.run(
            command(
                case,
                str(target),
                str(ROOT / "graders" / case["grader"]),
                group,
                sys.executable,
            ),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=15,
            check=False,
        ).returncode


def validate() -> dict:
    cases = load_pack()["cases"]
    results = []
    for case in cases:
        codes = {
            f"{v}_{g}": trusted_check(case, v, g)
            for v in ("broken", "reference")
            for g in ("target", "regression")
        }
        valid = codes == {
            "broken_target": 1,
            "broken_regression": 42,
            "reference_target": 42,
            "reference_regression": 42,
        }
        results.append({"instance_id": case["id"], "valid": valid, "exit_codes": codes})
    return {
        "kind": "fixture_validation",
        "model_calls": 0,
        "valid": all(r["valid"] for r in results),
        "cases": results,
    }


def docker_command(
    case: dict, directory: Path, group: str, image: str, name: str
) -> list[str]:
    return [
        "docker",
        "run",
        "--pull=never",
        "--platform=linux/amd64",
        "--name",
        name,
        "--network=none",
        "--read-only",
        "--user=1000:1000",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=64",
        "--memory=512m",
        "--cpus=1",
        "--tmpfs=/tmp:rw,noexec,nosuid,size=64m",
        "--workdir=/work",
        "--mount",
        f"type=bind,source={directory},target=/work,readonly",
        "--mount",
        f"type=bind,source={ROOT / 'graders'},target=/grader,readonly",
        "--entrypoint",
        "python" if case["language"] == "python" else "node",
        image,
        *command(
            case,
            "/work/" + case["source_path"],
            "/grader/" + case["grader"],
            group,
            "python",
        )[1:],
    ]


def container_check(case: dict, directory: Path, group: str, image: str) -> str:
    name = "chief-eval-" + uuid.uuid4().hex
    status = "infrastructure_error"
    try:
        result = subprocess.run(
            docker_command(case, directory, group, image, name),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
            check=False,
        )
        # A normal early exit(0) in candidate code must not masquerade as a test pass.
        status = (
            "passed"
            if result.returncode == 42
            else "infrastructure_error"
            if result.returncode in (125, 126, 127)
            else "failed"
        )
    except subprocess.TimeoutExpired:
        status = "timeout"
    except OSError:
        pass
    finally:
        # Kill/remove even after CLI timeout. Failed cleanup is infrastructure failure.
        try:
            cleanup = subprocess.run(
                ["docker", "rm", "-f", name],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
                check=False,
            )
            if cleanup.returncode != 0:
                status = "infrastructure_error"
        except (OSError, subprocess.TimeoutExpired):
            status = "infrastructure_error"
    return status


def grade_one(case: dict, prediction: dict | None, image: str) -> dict:
    if prediction is None:
        return {"instance_id": case["id"], "status": "missing"}
    files = prediction.get("files")
    if (
        not isinstance(files, dict)
        or set(files) != {case["source_path"]}
        or not isinstance(files[case["source_path"]], str)
    ):
        return {"instance_id": case["id"], "status": "invalid_candidate"}
    content = files[case["source_path"]]
    try:
        if len(content.encode("utf-8")) > 512000:
            raise ValueError("Oversized candidate")
    except (ValueError, UnicodeError):
        return {"instance_id": case["id"], "status": "invalid_candidate"}
    with tempfile.TemporaryDirectory(prefix="chief-grade-") as tmp:
        directory = Path(tmp) / "work"
        materialize(case, directory, content)
        checks = {
            group: container_check(case, directory, group, image)
            for group in ("target", "regression")
        }
    status = (
        "infrastructure_error"
        if "infrastructure_error" in checks.values()
        else "timeout"
        if "timeout" in checks.values()
        else "resolved"
        if all(v == "passed" for v in checks.values())
        else "unresolved"
    )
    return {
        "instance_id": case["id"],
        "status": status,
        "checks": checks,
        "candidate_sha256": digest(content.encode()),
    }


def read_predictions(path: Path, cases: list[dict]) -> dict:
    if path.stat().st_size > 4000000:
        raise ValueError("Prediction file too large")
    predictions = {}
    allowed = {c["id"] for c in cases}
    for line in path.read_text().splitlines():
        row = json.loads(line)
        if (
            not isinstance(row, dict)
            or not isinstance(row.get("instance_id"), str)
            or row["instance_id"] not in allowed
            or row["instance_id"] in predictions
        ):
            raise ValueError("Unknown or duplicate prediction instance")
        predictions[row["instance_id"]] = row
    return predictions


def summarize(results: list[dict]) -> dict:
    counts = Counter(r["status"] for r in results)
    return {
        "total": len(results),
        "counts": dict(counts),
        "resolved_fraction": counts["resolved"] / len(results) if results else 0,
    }


def grade(predictions_path: Path, config_path: Path) -> dict:
    pack = load_pack()
    config = json.loads(config_path.read_text())
    # One trial/configuration per report. Full role configuration is retained for comparison.
    required = {"harness_sha", "models", "effort", "limits", "trial"}
    if not isinstance(config, dict) or not required <= config.keys():
        raise ValueError(
            "Run configuration must record harness_sha, models, effort, limits and trial"
        )
    if not isinstance(config["harness_sha"], str) or not re.fullmatch(
        r"[0-9a-f]{40}", config["harness_sha"]
    ):
        raise ValueError("Expected full harness commit SHA")
    models = config["models"]
    limits = config["limits"]
    if (
        not isinstance(models, dict)
        or set(models) != {"leader", "coder", "reviewer"}
        or not all(isinstance(v, str) and v.strip() for v in models.values())
        or not isinstance(limits, dict)
        or set(limits) != {"ms", "models", "tools"}
        or not all(type(v) is int and v > 0 for v in limits.values())
        or config["effort"] not in ("low", "medium", "high")
        or type(config["trial"]) is not int
        or config["trial"] < 1
    ):
        raise ValueError("Invalid model assignments, effort, allocations or trial")
    predictions = read_predictions(predictions_path, pack["cases"])
    results = [grade_one(c, predictions.get(c["id"]), IMAGE) for c in pack["cases"]]
    tracked = [ROOT / name for name in ("cases.json", "public-slice.json", "run.py")]
    tracked += list((ROOT / "sources").glob("*")) + list((ROOT / "graders").glob("*"))
    fingerprint = b"".join(
        p.relative_to(ROOT).as_posix().encode() + b"\0" + p.read_bytes()
        for p in sorted(tracked)
        if p.is_file()
    )
    return {
        "schema_version": 1,
        "suite": pack["suite"],
        "run_id": uuid.uuid4().hex,
        "pack_sha256": digest(fingerprint),
        "grader_image": IMAGE,
        "config": config,
        "predictions_sha256": digest(predictions_path.read_bytes()),
        "results": results,
        "summary": summarize(results),
        "model_usage": "not collected by offline grader",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("validate")
    sub.add_parser("list")
    prep = sub.add_parser("prepare")
    prep.add_argument("instance_id")
    prep.add_argument("destination", type=Path)
    grading = sub.add_parser("grade")
    grading.add_argument("predictions", type=Path)
    grading.add_argument("config", type=Path)
    grading.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.action == "validate":
        result = validate()
        print(json.dumps(result, indent=2))
        return 0 if result["valid"] else 1
    if args.action == "list":
        print(
            json.dumps(
                [
                    {k: c[k] for k in ("id", "language", "kind", "split", "problem")}
                    for c in load_pack()["cases"]
                ],
                indent=2,
            )
        )
    elif args.action == "prepare":
        case = next(
            (c for c in load_pack()["cases"] if c["id"] == args.instance_id), None
        )
        if case is None:
            raise ValueError("Unknown instance")
        prepare(case, args.destination)
    else:
        if args.output.exists():
            raise ValueError("Refusing to overwrite a prior report")
        result = grade(args.predictions, args.config)
        with args.output.open("x") as handle:
            json.dump(result, handle, indent=2)
            handle.write("\n")
        print(json.dumps(result["summary"], indent=2))
        return (
            2
            if any(r["status"] == "infrastructure_error" for r in result["results"])
            else 0
        )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        print(f"Benchmark failed: {error}", file=sys.stderr)
        sys.exit(1)
