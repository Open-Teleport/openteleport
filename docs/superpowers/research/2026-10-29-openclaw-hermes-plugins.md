# OpenClaw and Hermes plugin research for v0.4

Date: 2026-10-29. Scope: command registration, packaging, activation, host context, and the boundary with OpenTeleport. This is research for future implementation; no plugin has been shipped.

## Recommendation

Start with explicit shell commands, `openclaw teleport export|import` and `hermes teleport export|import`. Use a native JavaScript plugin calling the public OpenTeleport library for OpenClaw, and a Python plugin invoking a fixed local OpenTeleport CLI installation for Hermes. Keep discovery and registration free of application writes, subprocesses, and network activity; perform operations only inside command handlers.

Two findings change the implementation plan:

- OpenClaw exposes a generic `parentPath` API, but the normal `agents` bootstrap in the checked release does not load nested plugin commands. Prefer a plugin-owned root instead of the `openclaw agents export|import` surface in the [earlier proposal](../../openclaw-plugin.md).
- Hermes changes `HERMES_HOME` to the selected profile. OpenTeleport's Hermes adapter expects a base directory containing `profiles/`. Passing the active profile as that base would target the wrong directory.

Slash commands and model-callable tools are separate integrations. Defer them until session identity, working directory, and authorization are tested for the supported host versions.

## Evidence and limits

| Component | Checked baseline | Verification |
| --- | --- | --- |
| OpenClaw | Release `2026.10.8`, commit `dc2523e5a5c7a309517fd7fa834add938231d526` | Official source and documentation. No installed OpenClaw runtime or executable plugin smoke test. |
| Hermes Agent | Installed `0.13.0`, commit `942adf617910f50a39f41bd200d8083bf4cb2bed` | Local source, real plugin loader, synthetic Python package metadata, and parser/handler probe in a temporary home. |
| OpenTeleport main | `f1ad906e6001157497a46c907a59bc999011e65d` | Read-only inspection of public API, CLI, and OpenClaw adapter. |
| OpenTeleport v0.2 work | Local snapshot `4a433e7bda8dc5c6170b2f460d01a31d6377ba59` | Read-only inspection of public API, CLI, and Hermes adapter. This is a source snapshot, not a published package version. |

Both checked OpenTeleport manifests still declare version `0.1.0` and Node `>=24`; only the v0.2 snapshot contains Hermes. Do not describe an npm `0.2.x` release as available on this evidence. All package names, plugin versions, and commands proposed below describe future artifacts.

Online documentation was read on the date above and can be newer than the installed source. In particular, current Hermes slash-command documentation does not describe the checked 0.13.0 implementation.

## OpenClaw

### Command registration and loading

`api.registerCli(registrar, options)` supplies a Commander `program`, `parentPath`, `config`, optional `workspaceDir`, and `logger`. Descriptor metadata advertises command groups; the registrar must still create their real commands. `hasSubcommands: true` does not create `export` or `import`. See the [registration types][oc-types].

The generic [nested registrar][oc-nested] resolves `parentPath`, including an existing `agents` parent. However, [CLI bootstrap][oc-bootstrap] registers built-in commands first, and the [registration policy][oc-policy] skips global plugin CLI registration for a recognized built-in root. [Nodes explicitly loads nested plugins][oc-nodes]; the [agents registrar][oc-agents] has no equivalent. Therefore, **source-derived conclusion, not a runtime result:** setting `parentPath: ["agents"]` alone does not make the proposed commands reachable through the normal executable route in this release.

Use root `teleport`, which is absent from the checked [core][oc-core] and [subCLI][oc-subcli] root declarations. Other installed plugins may still use that name; test collisions. Manifest `cliCommands` describes plugin-owned roots, not nested commands; adding `agents` there does not fix bootstrap. See the [manifest surface contract][oc-manifest].

A proposed manifest, not an installed plugin:

```json
{
  "id": "openteleport",
  "name": "OpenTeleport",
  "cliCommands": [
    {
      "name": "teleport",
      "description": "Import and export agents with OpenTeleport",
      "hasSubcommands": true
    }
  ],
  "configSchema": {
    "type": "object",
    "additionalProperties": false
  }
}
```

Registration outline; `registerTeleportCommands` is a proposed implementation function, not an SDK function:

```ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "openteleport",
  name: "OpenTeleport",
  description: "Import and export agents with OpenTeleport",
  register(api) {
    api.registerCli(
      ({ program }) => registerTeleportCommands(program),
      {
        descriptors: [{
          name: "teleport",
          description: "Import and export agents with OpenTeleport",
          hasSubcommands: true,
        }],
      },
    );
  },
});
```

The command builder should attach handlers and load OpenTeleport inside their actions. It must not detect applications or perform imports during registration. This outline has not been compiled or run against OpenClaw.

`api.registerCommand` instead registers a chat/slash command, handled before the agent; it does not create a shell command. Its authentication and handler context require a separate design. See [command types][oc-chat].

### Packaging and installation

Ship `openclaw.plugin.json`, `package.json`, and compiled `dist/`. Point `package.json.openclaw.extensions` at `./dist/index.js`. Current documentation also supports paired source `extensions` and compiled `runtimeExtensions`; a published plugin needs its declared JavaScript artifact. Declare OpenTeleport as a production dependency at a version actually released with the required adapters, and require Node `>=24` for OpenTeleport. Additionally satisfy the selected OpenClaw release's own Node requirements. For a pre-release proof, use a locally built package. See [package entrypoints][oc-package-entries] and OpenTeleport's [package contract][ot-package].

Current docs distinguish `openclaw.install.minHostVersion`, `openclaw.compat.pluginApi`, and npm peer dependencies. Start testing with exactly OpenClaw `2026.10.8`; a minimum-version gate is not evidence of compatibility with every later release. The SDK is experimental. See [version metadata][oc-package-metadata] and [building plugins][oc-building].

Documented development/install routes include `openclaw plugins install --link ./openclaw-plugin`, explicit `npm-pack:<tarball>`, and `npm:<package>@<version>`. Explicit `npm:` matters because current docs use ClawHub as the default package source. Follow the host's source approval flow. Once an artifact exists, inspect it with `openclaw plugins inspect openteleport --runtime --json` and test `openclaw teleport --help`. None of these installs was performed in this research. See [plugin management][oc-install].

### Library use still calls the host CLI

The OpenTeleport OpenClaw adapter invokes host CLI commands for agents, configuration, Gateway state, and routines. Calling the library removes the extra OpenTeleport process, not those OpenClaw child processes. See [adapter CLI implementation][ot-oc-cli].

Keep entry-module imports and registration free of operations that start these processes. Loading a plugin again is not itself recursion; doing work during loading can cause it. OpenClaw's [registration modes][oc-modes] explicitly separate discovery from runtime work.

Before using the host's documented `runWithLocalStateOwner` around an entire operation, test ownership with the adapter's child CLI calls. A parent holding ownership while a child requests it is an architectural concern, not an observed failure here. Do not work around it by importing private host modules. See [stateful CLI guidance][oc-sdk-entrypoints].

## Hermes

### Registration and activation in installed 0.13.0

A directory plugin can contain only `plugin.yaml` and `__init__.py` under `<active HERMES_HOME>/plugins/openteleport/`. Proposed manifest:

```yaml
manifest_version: 1
name: openteleport
version: "0.4.0"
description: Import and export agents with OpenTeleport
kind: standalone
```

The version above is a proposed plugin version. The installer accepts an omitted `manifest_version` or version 1 and rejects versions above 1; discovery is more permissive and is not a strict schema validator. See [manifest parsing][h-manifest] and [installer][h-install].

The checked API is `register_cli_command(name, help, setup_fn, handler_fn=None, description="")`. A registration outline:

```python
def register(ctx):
    ctx.register_cli_command(
        name="teleport",
        help="Import and export agents with OpenTeleport",
        setup_fn=setup,
        handler_fn=run,
    )
```

Here `setup(parser)` and `run(args)` are functions the future plugin implements. The first receives an argparse subparser; the second receives its parsed Namespace. `teleport` is a root command, with no automatic prefix from the manifest name. The parser integration is in [main.py][h-cli]; the API is in [PluginContext][h-api]. Top-level `hermes --help` can skip discovery, so test `hermes teleport --help` instead ([discovery gate][h-help]).

| Area | Observed contract / implication |
| --- | --- |
| Directory discovery | Bundled, active-home, opted-in project plugins, then pip entrypoints are scanned. Standalone plugins require `plugins.enabled`; `plugins.disabled` wins. Use a user/profile plugin for the first integration. [Loader][h-discovery] |
| Git installation | `hermes plugins install owner/repository --enable` clones a repository. Without an explicit activation flag, installation asks interactively; without a terminal it stays disabled. This does not install Node/OpenTeleport. [Installer][h-install] |
| Pip packaging | Entry-point group is `hermes_agent.plugins`. A value such as `openteleport = "hermes_openteleport"` must resolve to a module exposing `register(ctx)`, not directly to `module:register`. [Entry-point loader][h-entrypoints] |
| Pip activation gap | The real loader accepts enabled pip entrypoints, but `hermes plugins enable <name>` checks only user/bundled directories in this version. Probe confirmed exit 1 for a pip-only plugin. Manual `plugins.enabled` configuration is required for that route. [Management check][h-exists] |
| Active profile | Both plugin discovery and its enabled configuration follow the active profile home. Installing/enabling in the default home is not evidence that the plugin is available in another profile. [Loader][h-discovery] |

Prefer a directory/Git plugin initially to avoid the pip management mismatch. Install its Node dependency once; do not download or install dependencies during registration or each invocation.

### Profile mapping and subprocess contract

Native `hermes --profile <name>` changes `HERMES_HOME` to `<base>/profiles/<name>`. In the checked runtime, `hermes_constants.get_default_hermes_root()` recovers the base, including a custom base. The OpenTeleport v0.2 Hermes adapter treats `--source-dir` and `--target-dir` as that base and addresses named profiles below `profiles/<id>`. Import creates a named profile, not an overwrite of the default profile. See [profile override][h-profile], [base helper][h-root], and local snapshot `src/adapters/hermes/{paths,write}.ts`.

Resolve base and source agent ID separately. Do not pass a selected profile directory as the import base: that would nest imported profiles inside it. Keep OpenTeleport's user home distinct from the application's base.

Proposed child-process argument arrays, after validating absolute paths and the selected agent:

```python
[node_exe, cli_js, "export", "--from", "hermes", "--agent", agent_id,
 "--out", absolute_bundle, "--source-dir", base_home, "--json", "--quiet"]

[node_exe, cli_js, "import", absolute_bundle, "--to", "hermes",
 "--target-dir", base_home, "--json", "--quiet"]
```

Resolve `node_exe` and the installed package's `dist/cli.js` once during setup. Use Node >=24, `subprocess.run` with an argv array, `shell=False`, a configured timeout, explicit cwd, and a copied child environment. This also avoids Windows `.cmd` quoting. Parse stdout as JSON, retain stderr diagnostics and the exit code, and add `--copy` or `--enable-routines` only when explicitly requested. Do not invoke bare `npx` per operation.

### Probe results and documentation drift

The probe used a temporary home, a synthetic directory plugin and pip `.dist-info` entrypoint, and the installed loader with bytecode writes disabled. It reproduced the parser-assembly loop from the installed `main.py`, parsed a synthetic export command, and called its handler. It did **not** launch the full Hermes executable, Gateway, model, or an OpenTeleport import/export.

```json
{
  "directory_plugin_loaded": true,
  "pip_entrypoint_loaded": true,
  "root_cli_command": "teleport",
  "slash_handler_arguments": 1,
  "pip_management_recognizes_plugin": false,
  "pip_enable_exit": 1,
  "profile_home_and_base_root_distinguished": true
}
```

Both synthetic plugins were loaded through `plugins.enabled`. The probe also checked a normalized slash command and the base/profile helper distinction in a standard profile layout; custom-base handling was inspected in source. No personal content or configuration values are included here.

Installed 0.13.0 uses `register_command(name, handler, description="", args_hint="")` and dispatches a single raw argument string to its handler in both classic CLI and Gateway code. Current online docs describe Gateway-only dispatch, optional session kwargs, and `agent.runtime_cwd.resolve_agent_cwd()`; that module is absent from this installed commit. Current docs also differ on project-plugin discovery for sessions. Treat these as separate version contracts, not interchangeable examples. See [installed slash registration][h-slash], [CLI dispatch][h-slash-cli], [Gateway dispatch][h-slash-gateway], and [current documentation][h-current].

`register_tool` is available, but adds a model-callable tool rather than a shell command. The initial CLI wrapper does not need it. See [tool registration][h-tool].

## Shared OpenTeleport integration contract

| Concern | Requirement for implementation |
| --- | --- |
| Public library boundary | Import from `openteleport`. Call `registerBuiltinAdapters()` before `getAdapter()`. Use `exportBundle`, or `readBundle` then `importBundle`; do not bypass the engine with adapter writes. Internal CLI helpers are not package exports. [Public API][ot-api] |
| Context | Supply `Ctx.home`, `cwd`, `env`, `exec`, and `logger` explicitly. Do not substitute a host workspace/profile for the user's home. The OpenClaw registrar does not supply a ready-made OpenTeleport Ctx. [Types][ot-types] |
| OpenClaw state | Explicit `sourceDir`/`targetDir` forces `<dir>/openclaw.json` and bypasses `OPENCLAW_CONFIG_PATH`. Preserve a host using a separate config file through consistent state/config environment values rather than a conflicting explicit directory. [Path resolution][ot-oc-paths] |
| Reports | Engine functions return reports; they do not save CLI report files. A native wrapper must display/save the result deliberately. Preserve `moved`, `approximated`, `skipped`, `warnings`, `outcome`, and `nextStep`. CLI export saves `move-report.md` beside the bundle; import saves under the OpenTeleport user home. [Export command][ot-export], [import command][ot-import] |
| Exit status | For the Python bridge, `--json --quiet` retains structured results. Exit 0 can include a handoff; inspect `outcome`. CLI codes distinguish operation/secret errors (1), usage (2), and missing applications (3). [CLI result handling][ot-shared] |
| Writes and secrets | For library calls start with `{ enableRoutines: false, includeFiles: false, onConflict: "update" }`. Keep copy/replace explicit; library calls do not perform the CLI's replace confirmation. Surface `SecretsFoundError` locations/types without logging bundle contents. Do not promise that a heuristic scanner detects every secret. [Engine][ot-engine], [CLI policy][ot-shared] |
| Release dependency | Require Node >=24 and a known OpenTeleport build with the selected adapter. Main currently lacks Hermes; a v0.2 branch label is not an npm version or availability guarantee. [Package][ot-package], [main adapters][ot-adapters] |

## Implementation sequence and release checks

1. After the v0.2 changes settle, pick the exact OpenTeleport artifact and host versions for a proof of concept. Keep the wrappers thin; leave serialization, scanning, conflict handling, and paused routines in OpenTeleport.
2. Build the OpenClaw root command and Hermes directory plugin. First exercise registration/help and explicit list/export; then add import with complete reports.
3. Run the following checks in disposable host homes before declaring compatibility.

| Check | Required evidence |
| --- | --- |
| Discovery and packaging | Actual packaged install, plugin enable/disable, `teleport --help`, name-collision behavior, and no operations during help/discovery. Check OpenClaw metadata/runtime loading separately. |
| State and profiles | Default and custom roots; named Hermes profile; OpenClaw separate config path; paths with spaces and Unicode. Confirm the destination before writes and ensure unrelated profile state is preserved. |
| Data round trip | Export, import, update, and copy through the plugin entrypoints; report every unsupported field and verify imported routines stay paused by default. |
| Failure paths | Missing/old Node, missing OpenTeleport, malformed bundle, secret finding, nonzero child status, malformed JSON, timeout, and unavailable Gateway. Preserve diagnostics without reporting false success. |
| Host interaction | Real OpenClaw child CLI calls and ownership behavior; no repeated command execution caused by plugin loading. Hermes smoke test through the actual executable, beyond the parser probe. |

This research changes one documentation file. OpenClaw runtime integration, full Hermes executable dispatch, and the proposed wrappers remain implementation work; the Hermes loader/parser observations above are already verified.

[oc-types]: https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/src/plugins/plugin-registration.types.ts#L136
[oc-nested]: https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/src/plugins/register-plugin-cli-command-groups.ts#L64
[oc-bootstrap]: https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/src/cli/run-main.ts#L1282
[oc-policy]: https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/src/cli/command-registration-policy.ts#L19
[oc-nodes]: https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/src/cli/nodes-cli/register.ts#L59
[oc-agents]: https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/src/cli/program/register.agent.ts#L19
[oc-core]: https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/src/cli/program/core-command-descriptors.ts
[oc-subcli]: https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/src/cli/program/subcli-descriptors.ts
[oc-manifest]: https://docs.openclaw.ai/plugins/manifest/surfaces#clicommands-reference
[oc-chat]: https://github.com/openclaw/openclaw/blob/dc2523e5a5c7a309517fd7fa834add938231d526/src/plugins/plugin-command.types.ts#L134
[oc-package-entries]: https://docs.openclaw.ai/plugins/sdk-entrypoints/package-entries
[oc-package-metadata]: https://docs.openclaw.ai/plugins/manifest/package-json
[oc-building]: https://docs.openclaw.ai/plugins/building-plugins
[oc-install]: https://docs.openclaw.ai/plugins/manage-plugins
[oc-modes]: https://docs.openclaw.ai/plugins/sdk-entrypoints/registration-mode
[oc-sdk-entrypoints]: https://docs.openclaw.ai/plugins/sdk-entrypoints#stateful-cli-commands
[h-manifest]: https://github.com/NousResearch/hermes-agent/blob/942adf617910f50a39f41bd200d8083bf4cb2bed/hermes_cli/plugins.py#L943
[h-install]: https://github.com/NousResearch/hermes-agent/blob/942adf617910f50a39f41bd200d8083bf4cb2bed/hermes_cli/plugins_cmd.py#L345
[h-cli]: https://github.com/NousResearch/hermes-agent/blob/942adf617910f50a39f41bd200d8083bf4cb2bed/hermes_cli/main.py#L10603
[h-api]: https://github.com/NousResearch/hermes-agent/blob/942adf617910f50a39f41bd200d8083bf4cb2bed/hermes_cli/plugins.py#L376
[h-help]: https://github.com/NousResearch/hermes-agent/blob/942adf617910f50a39f41bd200d8083bf4cb2bed/hermes_cli/main.py#L9263
[h-discovery]: https://github.com/NousResearch/hermes-agent/blob/942adf617910f50a39f41bd200d8083bf4cb2bed/hermes_cli/plugins.py#L693
[h-entrypoints]: https://github.com/NousResearch/hermes-agent/blob/942adf617910f50a39f41bd200d8083bf4cb2bed/hermes_cli/plugins.py#L1039
[h-exists]: https://github.com/NousResearch/hermes-agent/blob/942adf617910f50a39f41bd200d8083bf4cb2bed/hermes_cli/plugins_cmd.py#L684
[h-profile]: https://github.com/NousResearch/hermes-agent/blob/942adf617910f50a39f41bd200d8083bf4cb2bed/hermes_cli/main.py#L119
[h-root]: https://github.com/NousResearch/hermes-agent/blob/942adf617910f50a39f41bd200d8083bf4cb2bed/hermes_constants.py#L71
[h-slash]: https://github.com/NousResearch/hermes-agent/blob/942adf617910f50a39f41bd200d8083bf4cb2bed/hermes_cli/plugins.py#L401
[h-slash-cli]: https://github.com/NousResearch/hermes-agent/blob/942adf617910f50a39f41bd200d8083bf4cb2bed/cli.py#L7630
[h-slash-gateway]: https://github.com/NousResearch/hermes-agent/blob/942adf617910f50a39f41bd200d8083bf4cb2bed/gateway/run.py#L6577
[h-current]: https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins
[h-tool]: https://github.com/NousResearch/hermes-agent/blob/942adf617910f50a39f41bd200d8083bf4cb2bed/hermes_cli/plugins.py#L317
[ot-package]: https://github.com/Open-Teleport/openteleport/blob/f1ad906e6001157497a46c907a59bc999011e65d/package.json
[ot-api]: https://github.com/Open-Teleport/openteleport/blob/f1ad906e6001157497a46c907a59bc999011e65d/src/index.ts
[ot-types]: https://github.com/Open-Teleport/openteleport/blob/f1ad906e6001157497a46c907a59bc999011e65d/src/adapters/types.ts
[ot-oc-cli]: https://github.com/Open-Teleport/openteleport/blob/f1ad906e6001157497a46c907a59bc999011e65d/src/adapters/openclaw/cli.ts
[ot-oc-paths]: https://github.com/Open-Teleport/openteleport/blob/f1ad906e6001157497a46c907a59bc999011e65d/src/adapters/openclaw/paths.ts#L63
[ot-export]: https://github.com/Open-Teleport/openteleport/blob/f1ad906e6001157497a46c907a59bc999011e65d/src/commands/export.ts
[ot-import]: https://github.com/Open-Teleport/openteleport/blob/f1ad906e6001157497a46c907a59bc999011e65d/src/commands/import.ts
[ot-shared]: https://github.com/Open-Teleport/openteleport/blob/f1ad906e6001157497a46c907a59bc999011e65d/src/commands/shared.ts
[ot-engine]: https://github.com/Open-Teleport/openteleport/blob/f1ad906e6001157497a46c907a59bc999011e65d/src/core/engine.ts
[ot-adapters]: https://github.com/Open-Teleport/openteleport/blob/f1ad906e6001157497a46c907a59bc999011e65d/src/adapters/index.ts
