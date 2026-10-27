# OpenTeleport

Move your AI agent between apps in one command.

```bash
# move an agent from Claude Code to OpenClaw (export and import in one step)
npx openteleport move --from claude-code --to openclaw --agent reviewer

# save an agent from any project folder to a file, to send it or archive it
npx openteleport export --from folder --source-dir ./agents/ada --out ada.jetpack

# load an agent from a file into an app
npx openteleport import --to openclaw ada.jetpack
```

Not affiliated with Teleport by Gravitational.
