"""Hermes directory plugin. Import and register are deliberately side-effect free."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def setup(parser):
    commands = parser.add_subparsers(dest="teleport_action", required=True)
    commands.add_parser("list", help="List profiles in the selected Hermes base")
    exporting = commands.add_parser("export", help="Export the selected profile")
    exporting.add_argument("--agent", help="Profile ID (defaults to the active profile)")
    exporting.add_argument("--out", required=True, help="Output .jetpack file")
    exporting.add_argument("--include-files", action="store_true")
    importing = commands.add_parser("import", help="Import a bundle into a named Hermes profile")
    importing.add_argument("bundle")
    importing.add_argument("--copy", action="store_true")
    importing.add_argument("--include-files", action="store_true")
    importing.add_argument("--enable-routines", action="store_true")


def profile_context():
    from hermes_constants import get_default_hermes_root, get_hermes_home
    base = get_default_hermes_root().expanduser().resolve()
    active = get_hermes_home().expanduser().resolve()
    if active == base:
        return base, "default"
    if active.parent == base / "profiles":
        return base, active.name
    raise ValueError("Cannot map the selected Hermes profile to its base directory.")


def command(args, node, cli, base, active_id):
    argv = [str(node), str(cli), args.teleport_action]
    if args.teleport_action == "list":
        argv += ["--from", "hermes", "--source-dir", str(base)]
    elif args.teleport_action == "export":
        argv += ["--from", "hermes", "--agent", args.agent or active_id,
                 "--out", str(Path(args.out).resolve()), "--source-dir", str(base)]
        if args.include_files:
            argv.append("--include-files")
    else:
        argv += [str(Path(args.bundle).resolve()), "--to", "hermes", "--target-dir", str(base)]
        if args.copy:
            argv.append("--copy")
        if args.include_files:
            argv.append("--include-files")
        if args.enable_routines:
            argv.append("--enable-routines")
    return argv + ["--json", "--quiet"]


def run(args):
    try:
        cli_value = os.environ.get("OPENTELEPORT_CLI", "")
        if not cli_value or not Path(cli_value).is_absolute() or not Path(cli_value).is_file():
            raise ValueError("Set OPENTELEPORT_CLI to an existing absolute dist/cli.js path.")
        node_value = os.environ.get("OPENTELEPORT_NODE") or shutil.which("node")
        if not node_value or not Path(node_value).is_absolute() or not Path(node_value).is_file():
            raise ValueError("Set OPENTELEPORT_NODE to an absolute Node >=24 executable path.")
        version = subprocess.run([node_value, "--version"], capture_output=True, text=True,
                                 encoding="utf-8", timeout=10, shell=False, check=True)
        if int(version.stdout.strip().lstrip("v").split(".")[0]) < 24:
            raise ValueError("OpenTeleport requires Node >=24.")
        base, active_id = profile_context()
        child_env = os.environ.copy()
        # Active profile is addressed by ID; the adapter must receive its base, not a nested profile.
        child_env["HERMES_HOME"] = str(base)
        result = subprocess.run(command(args, node_value, cli_value, base, active_id),
                                cwd=str(Path.cwd()), env=child_env, capture_output=True,
                                text=True, encoding="utf-8", timeout=120, shell=False)
        if result.stderr:
            sys.stderr.write(result.stderr)
        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError:
            raise ValueError("OpenTeleport returned invalid JSON; inspect the destination before retrying.")
        if not isinstance(payload, (dict, list)):
            raise ValueError("OpenTeleport returned an unexpected result.")
        if result.returncode == 0 and isinstance(payload, dict) and "error" in payload:
            raise ValueError("OpenTeleport reported an error despite a zero exit status.")
        if result.returncode == 0 and args.teleport_action != "list":
            if not isinstance(payload, dict) or payload.get("outcome") not in ("done", "handoff", "exported"):
                raise ValueError("OpenTeleport did not return a transfer report.")
        print(json.dumps(payload, ensure_ascii=False))
        raise SystemExit(result.returncode)
    except subprocess.TimeoutExpired:
        print("OpenTeleport timed out; inspect the destination before retrying.", file=sys.stderr)
        raise SystemExit(1)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print("OpenTeleport: " + str(error), file=sys.stderr)
        raise SystemExit(1)


def register(ctx):
    ctx.register_cli_command(
        name="teleport", help="Import and export portable agent profiles",
        setup_fn=setup, handler_fn=run,
        description="Use a configured local OpenTeleport CLI; no runtime downloads.",
    )
