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
