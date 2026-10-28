#!/usr/bin/env bash
# The OpenTeleport demo: five Claude Code agents move into OpenClaw, and one of them comes back
# as a plain agent folder that any AGENTS.md-aware tool can use. Every command is printed before
# it runs. From the repository root, after `npm run build`:
#
#   bash scripts/demo.sh
#
# Needs Node.js 24+ and `openclaw` on PATH. Everything happens in a new temporary folder: a copy
# of the Claude Code fixture project (with four more agents made from its `reviewer`), a home for
# OpenTeleport and Claude Code, and a throwaway OpenClaw state directory set up with
# `openclaw onboard --non-interactive`. To use a state directory you onboarded yourself, set
# OPENTELEPORT_DEMO_OPENCLAW_STATE_DIR; the five agents are added to it. The 60-second recording
# script is docs/demo.md.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO/dist/cli.js"
FIXTURES="$REPO/test/fixtures/claude-code"
AGENTS=(reviewer planner tester docs-writer release-manager)

fail() {
  echo "demo: $*" >&2
  exit 1
}
[ -f "$CLI" ] || fail "dist/cli.js is missing: run npm run build first"
command -v node >/dev/null 2>&1 || fail "node is not on PATH"
command -v openclaw >/dev/null 2>&1 || fail "openclaw is not on PATH: install OpenClaw first"

# A path Node.js reads the same way: Git Bash on Windows hands out /tmp/... paths.
native() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi
}

# Prints a command the way you would type it, then runs it.
run() {
  local line="$" word
  for word in "$@"; do
    case "$word" in
      *[[:space:]]*) line+=" \"$word\"" ;;
      *) line+=" $word" ;;
    esac
  done
  printf '\n%s\n' "$line"
  "$@"
}

openteleport() { node "$CLI" "$@"; }

DEMO="$(native "$(mktemp -d "${TMPDIR:-/tmp}/openteleport-demo.XXXXXX")")"
if [ -n "${OPENTELEPORT_DEMO_OPENCLAW_STATE_DIR:-}" ]; then
  [ -f "$OPENTELEPORT_DEMO_OPENCLAW_STATE_DIR/openclaw.json" ] ||
    fail "OPENTELEPORT_DEMO_OPENCLAW_STATE_DIR has no openclaw.json"
  OPENCLAW_DIR="$(native "$(cd "$OPENTELEPORT_DEMO_OPENCLAW_STATE_DIR" && pwd)")"
else
  OPENCLAW_DIR=openclaw
fi
cd "$DEMO"

# OpenTeleport, Claude Code and OpenClaw keep their state in the demo folder, not in your home.
export OPENTELEPORT_HOME="$DEMO/home"
export CLAUDE_CONFIG_DIR="$DEMO/home/.claude"
mkdir -p "$OPENCLAW_DIR"
OPENCLAW_STATE_DIR="$(native "$(cd "$OPENCLAW_DIR" && pwd)")"
export OPENCLAW_STATE_DIR
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"

echo "Setting up the demo in $DEMO"

# A Claude Code project with five agents: the fixture's reviewer and four copies of it.
cp -R "$FIXTURES/project" project
rm -f project/.claude/agents/plain.md
make_agent() {
  sed -e "s/^name: reviewer/name: $1/" -e "s/^description: .*/description: $2/" \
    project/.claude/agents/reviewer.md >"project/.claude/agents/$1.md"
}
make_agent planner "Breaks a feature request into small steps that can each be reviewed."
make_agent tester "Writes the missing tests for a change and runs the whole suite."
make_agent docs-writer "Keeps the README and the docs in step with the code."
make_agent release-manager "Prepares the release notes and walks the release checklist."

# Claude Code keeps a project's memory under its config directory, keyed by the project path.
memory_key="$(node -e 'process.stdout.write(require("path").resolve("project").replace(/[^A-Za-z0-9]/g, "-"))')"
mkdir -p "$CLAUDE_CONFIG_DIR/projects/$memory_key"
cp -R "$FIXTURES/home/.claude/projects/__project__/memory" "$CLAUDE_CONFIG_DIR/projects/$memory_key/"

# A throwaway OpenClaw, onboarded without prompts, providers, services or channels. Its Gateway
# gets a free port, so nothing here reaches a Gateway you already run.
if [ -z "${OPENTELEPORT_DEMO_OPENCLAW_STATE_DIR:-}" ]; then
  port="$(node -e 'const s = require("net").createServer(); s.listen(0, "127.0.0.1", () => { process.stdout.write(String(s.address().port)); s.close(); })')"
  echo "Onboarding a throwaway OpenClaw in $OPENCLAW_STATE_DIR (log: $DEMO/onboard.log)"
  openclaw onboard --non-interactive --accept-risk --mode local --auth-choice skip \
    --workspace "$OPENCLAW_STATE_DIR/workspace" --gateway-port "$port" --gateway-bind loopback \
    --tailscale off --skip-daemon --skip-channels --skip-skills --skip-search --skip-hooks \
    --skip-ui --skip-health --suppress-gateway-token-output >onboard.log 2>&1 ||
    fail "openclaw onboard failed; see $DEMO/onboard.log"
  [ -f "$OPENCLAW_CONFIG_PATH" ] || fail "openclaw onboard wrote no openclaw.json; see onboard.log"
fi

# -- The demo -----------------------------------------------------------------------------------

run openteleport list --from claude-code --source-dir project

for agent in "${AGENTS[@]}"; do
  run openteleport move --from claude-code --source-dir project \
    --to openclaw --target-dir "$OPENCLAW_DIR" --agent "$agent"
done

run openclaw agents list

run openteleport move --from openclaw --source-dir "$OPENCLAW_DIR" \
  --to folder --target-dir agents/reviewer --agent reviewer

run ls agents/reviewer

# Report files are named <timestamp>-<agent>.md, so the last in name order is the newest.
reports=("$OPENTELEPORT_HOME/.openteleport/reports"/*.md)
report="${reports[${#reports[@]} - 1]}"
[ -f "$report" ] || fail "the move wrote no report"
echo
echo "Move report: $report"
run cat "$report"

echo
echo "Done. Everything is in $DEMO; delete it when you no longer need it."
