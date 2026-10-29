import argparse
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
import zipfile
from unittest.mock import patch

PLUGIN = Path(__file__).resolve().parents[2] / "plugins" / "hermes" / "__init__.py"
spec = importlib.util.spec_from_file_location("teleport_plugin", PLUGIN)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


def args(*words):
    parser = argparse.ArgumentParser()
    plugin.setup(parser)
    return parser.parse_args(words)


class HermesPluginTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="openteleport-hermes-plugin-")
        self.root = Path(self.temp.name)
        self.cli = self.root / "cli.js"
        self.cli.write_text("// stub", encoding="utf-8")
        self.env = patch.dict(os.environ, {"OPENTELEPORT_CLI": str(self.cli), "OPENTELEPORT_NODE": sys.executable})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def test_registration_does_no_work(self):
        class Context:
            def register_cli_command(self, **kwargs):
                self.registration = kwargs
        ctx = Context()
        with patch.object(plugin.subprocess, "run", side_effect=AssertionError("registration executed")):
            plugin.register(ctx)
            self.assertEqual(ctx.registration["name"], "teleport")
            args("list")

    def test_profile_mapping_uses_base_and_active_id(self):
        constants = types.ModuleType("hermes_constants")
        constants.get_default_hermes_root = lambda: self.root
        constants.get_hermes_home = lambda: self.root / "profiles" / "reviewer"
        with patch.dict(sys.modules, {"hermes_constants": constants}):
            self.assertEqual(plugin.profile_context(), (self.root.resolve(), "reviewer"))
        invocation = plugin.command(args("export", "--out", "a file.jetpack"), sys.executable,
                                    self.cli, self.root, "reviewer")
        self.assertIn("reviewer", invocation)
        self.assertEqual(invocation[invocation.index("--source-dir") + 1], str(self.root))
        imported = plugin.command(args("import", "a file.jetpack", "--copy"), sys.executable,
                                  self.cli, self.root, "reviewer")
        self.assertEqual(imported[imported.index("--target-dir") + 1], str(self.root))
        self.assertIn("--copy", imported)
        self.assertNotIn("--enable-routines", imported)
        self.assertNotIn("--include-files", imported)

    def execute(self, result, *, version="v24.1.0"):
        version_result = subprocess.CompletedProcess([], 0, version, "")
        output = io.StringIO()
        error = io.StringIO()
        with patch.object(plugin, "profile_context", return_value=(self.root, "reviewer")), \
             patch.object(plugin.subprocess, "run", side_effect=[version_result, result]) as child, \
             patch("sys.stdout", output), patch("sys.stderr", error):
            with self.assertRaises(SystemExit) as status:
                plugin.run(args("import", "bundle.jetpack"))
        return status.exception.code, output.getvalue(), error.getvalue(), child

    def test_handoff_and_exit_status_survive(self):
        payload = {"outcome": "handoff", "nextStep": "Review settings", "moved": [], "warnings": []}
        status, output, _, child = self.execute(subprocess.CompletedProcess([], 0, json.dumps(payload), ""))
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(output), payload)
        kwargs = child.call_args.kwargs
        self.assertFalse(kwargs["shell"])
        self.assertEqual(kwargs["env"]["HERMES_HOME"], str(self.root))
        self.assertEqual(kwargs["timeout"], 120)
        status, _, error, _ = self.execute(subprocess.CompletedProcess([], 3, '{"error":{"code":3}}', "missing app"))
        self.assertEqual(status, 3)
        self.assertIn("missing app", error)

    def test_invalid_json_and_timeout_fail(self):
        status, _, error, _ = self.execute(subprocess.CompletedProcess([], 0, "not json", ""))
        self.assertEqual(status, 1)
        self.assertIn("invalid JSON", error)
        status, _, error, _ = self.execute(subprocess.TimeoutExpired("node", 120))
        self.assertEqual(status, 1)
        self.assertIn("timed out", error)

    def test_old_node_and_false_success_fail(self):
        status, _, error, child = self.execute(subprocess.CompletedProcess([], 0, "{}", ""), version="v22.0.0")
        self.assertEqual(status, 1)
        self.assertEqual(child.call_count, 1)
        self.assertIn("Node >=24", error)
        status, _, _, _ = self.execute(subprocess.CompletedProcess([], 0, '{"error": {}}', ""))
        self.assertEqual(status, 1)
        status, _, _, _ = self.execute(subprocess.CompletedProcess([], 0, "{}", ""))
        self.assertEqual(status, 1)

    def export_fixture(self, *, during=None, returncode=0, stdout=None):
        destination = self.root / "output.jetpack"
        output, error = io.StringIO(), io.StringIO()
        def child(argv, **kwargs):
            if argv[-1] == "--version":
                return subprocess.CompletedProcess(argv, 0, "v24.1.0", "")
            staged = Path(argv[argv.index("--out") + 1])
            self.assertNotEqual(staged, destination)
            staged.write_bytes(b"archive fixture")
            (staged.parent / "move-report.md").write_text("report fixture", encoding="utf-8")
            if during:
                during(destination)
            return subprocess.CompletedProcess(argv, returncode,
                stdout if stdout is not None else json.dumps({"outcome": "exported", "warnings": []}), "")
        with patch.object(plugin, "profile_context", return_value=(self.root, "reviewer")), \
             patch.object(plugin.subprocess, "run", side_effect=child) as process, \
             patch("sys.stdout", output), patch("sys.stderr", error):
            with self.assertRaises(SystemExit) as status:
                plugin.run(args("export", "--out", str(destination)))
        return status.exception.code, output.getvalue(), error.getvalue(), process

    def test_export_refuses_existing_and_racing_destinations(self):
        destination = self.root / "output.jetpack"
        destination.write_bytes(b"original")
        status, _, error, child = self.export_fixture()
        self.assertEqual(status, 1)
        self.assertIn("already exists", error)
        self.assertEqual(child.call_count, 1)  # Only Node version, no source export.
        self.assertEqual(destination.read_bytes(), b"original")
        destination.unlink()
        status, _, _, _ = self.export_fixture(during=lambda path: path.write_bytes(b"racing writer"))
        self.assertEqual(status, 1)
        self.assertEqual(destination.read_bytes(), b"racing writer")

    def test_export_publishes_archive_and_report_without_overwriting_report(self):
        status, output, _, _ = self.export_fixture()
        self.assertEqual(status, 0)
        payload = json.loads(output)
        self.assertEqual(Path(payload["artifactPath"]).read_bytes(), b"archive fixture")
        report = Path(payload["reportPath"])
        self.assertEqual(report.read_text(), "report fixture")
        Path(payload["artifactPath"]).unlink()
        report.write_text("keep this report")
        status, output, _, _ = self.export_fixture()
        self.assertEqual(status, 0)
        self.assertEqual(report.read_text(), "keep this report")
        self.assertNotIn("reportPath", json.loads(output))
        self.assertIn("retain this JSON", json.loads(output)["warnings"][0])

    def test_failed_or_invalid_export_is_never_published(self):
        for status_code, text in [(3, '{"error": {}}'), (0, 'invalid'), (0, '{"outcome": "done"}')]:
            status, _, _, _ = self.export_fixture(returncode=status_code, stdout=text)
            self.assertNotEqual(status, 0)
            self.assertFalse((self.root / "output.jetpack").exists())

    def test_real_cli_export_roundtrip_and_collision(self):
        node = os.environ["OPENTELEPORT_TEST_NODE"]
        cli = PLUGIN.parents[2] / "dist" / "cli.js"
        (self.root / "config.yaml").write_text("model: {}\n", encoding="utf-8")
        (self.root / "SOUL.md").write_text("Synthetic reviewer persona\n", encoding="utf-8")
        destination = self.root / "real export.jetpack"
        output, error = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, {"OPENTELEPORT_CLI": str(cli), "OPENTELEPORT_NODE": node,
                                    "OPENTELEPORT_HOME": str(self.root)}), \
             patch.object(plugin, "profile_context", return_value=(self.root, "default")), \
             patch("sys.stdout", output), patch("sys.stderr", error):
            with self.assertRaises(SystemExit) as status:
                plugin.run(args("export", "--out", str(destination)))
            self.assertEqual(status.exception.code, 0, error.getvalue())
            original = destination.read_bytes()
            with self.assertRaises(SystemExit) as status:
                plugin.run(args("export", "--out", str(destination)))
            self.assertEqual(status.exception.code, 1)
            self.assertEqual(destination.read_bytes(), original)
        with zipfile.ZipFile(destination) as archive:
            self.assertIn("Synthetic reviewer persona", archive.read("SOUL.md").decode("utf-8"))
        payload = json.loads(output.getvalue())
        self.assertTrue(Path(payload["reportPath"]).is_file())

    def test_replace_is_unavailable(self):
        with patch("sys.stderr", io.StringIO()), self.assertRaises(SystemExit):
            args("import", "a.jetpack", "--replace")

    def test_shell_metacharacters_are_single_arguments(self):
        value = 'reviewer; echo unsafe & $(whoami)'
        invocation = plugin.command(args("export", "--agent", value, "--out", "test.jetpack"),
                                    sys.executable, self.cli, self.root, "default")
        self.assertEqual(invocation[invocation.index("--agent") + 1], value)


if __name__ == "__main__":
    unittest.main()
