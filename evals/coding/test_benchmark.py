"""Fixture validity, leakage boundaries and grading/report failures; no model calls."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import run as bench


class BenchmarkTests(unittest.TestCase):
    def setUp(self):
        self.cases = bench.load_pack()["cases"]
        self.case = self.cases[0]

    def test_all_seeded_bugs_fail_and_reference_repairs_pass(self):
        result = bench.validate()
        self.assertTrue(result["valid"], result)
        self.assertEqual(len(result["cases"]), 6)

    def test_export_contains_only_task_and_broken_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "agent"
            bench.prepare(self.case, dest)
            self.assertEqual(
                {
                    p.relative_to(dest).as_posix()
                    for p in dest.rglob("*")
                    if p.is_file()
                },
                {"TASK.json", self.case["source_path"]},
            )
            self.assertEqual(
                (dest / self.case["source_path"]).read_text(), bench.source(self.case)
            )
            self.assertNotIn("mutation", (dest / "TASK.json").read_text())
            with self.assertRaises(FileExistsError):
                bench.prepare(self.case, dest)

    def test_denominator_retains_infrastructure_and_missing(self):
        summary = bench.summarize(
            [
                {"status": s}
                for s in ["resolved", "unresolved", "infrastructure_error", "missing"]
            ]
        )
        self.assertEqual(summary["resolved_fraction"], 0.25)
        self.assertEqual(summary["total"], 4)

    def test_unknown_and_duplicate_predictions_rejected(self):
        row = {"instance_id": self.case["id"], "files": {}}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "predictions.jsonl"
            for rows in [[row, row], [{"instance_id": "other"}]]:
                path.write_text("\n".join(json.dumps(r) for r in rows))
                with self.assertRaises(ValueError):
                    bench.read_predictions(path, self.cases)

    def test_candidates_cannot_write_grader_or_other_paths(self):
        for files in [
            {},
            {"../grader/format.mjs": "x"},
            {self.case["source_path"]: False},
            {self.case["source_path"]: "x", "TASK.json": "x"},
        ]:
            with patch.object(bench, "container_check") as execute:
                result = bench.grade_one(self.case, {"files": files}, bench.IMAGE)
                self.assertEqual(result["status"], "invalid_candidate")
                execute.assert_not_called()

    def test_target_pass_does_not_override_regression_failure(self):
        prediction = {
            "files": {self.case["source_path"]: bench.source(self.case, "reference")}
        }
        with patch.object(bench, "container_check", side_effect=["passed", "failed"]):
            self.assertEqual(
                bench.grade_one(self.case, prediction, bench.IMAGE)["status"],
                "unresolved",
            )
        with patch.object(
            bench, "container_check", side_effect=["passed", "infrastructure_error"]
        ):
            self.assertEqual(
                bench.grade_one(self.case, prediction, bench.IMAGE)["status"],
                "infrastructure_error",
            )

    def test_container_timeout_attempts_cleanup(self):
        import subprocess

        with patch.object(
            bench.subprocess,
            "run",
            side_effect=[
                subprocess.TimeoutExpired("docker", 30),
                subprocess.CompletedProcess([], 0),
            ],
        ) as run:
            self.assertEqual(
                bench.container_check(
                    self.case, Path("/tmp/work"), "target", bench.IMAGE
                ),
                "timeout",
            )
            self.assertEqual(run.call_args_list[-1].args[0][:3], ["docker", "rm", "-f"])

    def test_container_has_no_network_secrets_or_writable_host_mounts(self):
        argv = bench.docker_command(
            self.case, Path("/tmp/work"), "target", bench.IMAGE, "test"
        )
        for flag in [
            "--network=none",
            "--read-only",
            "--user=1000:1000",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--pull=never",
        ]:
            self.assertIn(flag, argv)
        mounts = [argv[i + 1] for i, x in enumerate(argv) if x == "--mount"]
        self.assertEqual(len(mounts), 2)
        self.assertTrue(all(x.endswith(",readonly") for x in mounts))
        self.assertFalse(any("docker.sock" in x or x == "--env" for x in argv))

    def test_early_exit_and_cleanup_failure_cannot_pass(self):
        import subprocess

        for code, cleanup, expected in [
            (0, 0, "failed"),
            (42, 1, "infrastructure_error"),
            (42, 0, "passed"),
        ]:
            with patch.object(
                bench.subprocess,
                "run",
                side_effect=[
                    subprocess.CompletedProcess([], code),
                    subprocess.CompletedProcess([], cleanup),
                ],
            ):
                self.assertEqual(
                    bench.container_check(
                        self.case, Path("/tmp/work"), "target", bench.IMAGE
                    ),
                    expected,
                )

    def test_invalid_unicode_is_a_candidate_failure(self):
        result = bench.grade_one(
            self.case, {"files": {self.case["source_path"]: "\ud800"}}, bench.IMAGE
        )
        self.assertEqual(result["status"], "invalid_candidate")

    def test_report_keeps_all_cases_and_rejects_incomplete_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            predictions = Path(tmp) / "predictions.jsonl"
            config = Path(tmp) / "config.json"
            predictions.write_text("")
            config.write_text(
                json.dumps(
                    {
                        "harness_sha": "a" * 40,
                        "models": {},
                        "effort": "high",
                        "limits": {},
                        "trial": 1,
                    }
                )
            )
            with self.assertRaises(ValueError):
                bench.grade(predictions, config)
            config.write_text(
                json.dumps(
                    {
                        "harness_sha": "a" * 40,
                        "models": {
                            r: "fixture" for r in ("leader", "coder", "reviewer")
                        },
                        "effort": "high",
                        "limits": {"ms": 900000, "models": 40, "tools": 100},
                        "trial": 1,
                    }
                )
            )
            with patch.object(bench, "container_check") as execute:
                report = bench.grade(predictions, config)
                execute.assert_not_called()
            self.assertEqual(
                report["summary"],
                {"total": 6, "counts": {"missing": 6}, "resolved_fraction": 0},
            )
            self.assertRegex(report["pack_sha256"], r"^[a-f0-9]{64}$")

    def test_public_slice_is_pinned_to_four_unique_instances(self):
        value = json.loads((bench.ROOT / "public-slice.json").read_text())
        ids = []
        for dataset in value["datasets"]:
            self.assertRegex(dataset["revision"], r"^[a-f0-9]{40}$")
            self.assertRegex(dataset["parquet_sha256"], r"^[a-f0-9]{64}$")
            for row in dataset["instances"]:
                self.assertRegex(row["base_commit"], r"^[a-f0-9]{40}$")
                self.assertNotIn("patch", row)
                self.assertNotIn("test_patch", row)
                ids.append(row["instance_id"])
        self.assertEqual(len(set(ids)), 4)


if __name__ == "__main__":
    unittest.main()
