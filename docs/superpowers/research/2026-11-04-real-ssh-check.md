# Real SSH verification — OpenTeleport 0.4.7

Public npm 0.4.7 was checked on 2026-11-04 using Windows OpenSSH 9.5p2 and an actual Debian OpenSSH 9.2p1 server in a disposable Node 24.22.0 Docker container. The published package was installed into a fresh local directory; the remote started with no npx cache and downloaded its pinned 0.4.7 on the first transfer.

## Setup

The server listened only on host loopback. It had no host mounts, personal files or provider credentials. Authentication used a generated test key; the server host key was pinned from the owned container. A small `ssh.cmd` launcher on the test PATH added only `-F <temporary config>` before invoking the real Windows `ssh.exe`. It did not simulate the connection, remote command or output. Personal SSH configuration and known-host files were untouched.

The synthetic Ada fixture supplied instructions, facts and a skill. Local HOME and OpenTeleport state were temporary. Both local temporary directories and the container (including keys and remote state) were removed.

## Passed

- Move from local folder to the remote folder, including cold remote npx download.
- List the remote agent, then export it using the ID returned by list.
- Import the returned archive locally; facts and skill contents match the source.
- Import a copy remotely, with a distinct target path.
- Rename the remote test directory to include a space and apostrophe, then move it back using its listed folder ID.
- Refuse `--replace` without confirmation before invoking SSH.

[Sanitized evidence](2026-11-04-real-ssh-evidence.json).

## Limits

Folder adapter transport only. This does not establish OpenClaw, Hermes or other application behavior on a remote host. Password/passphrase prompts, jump hosts and intermittent networks remain untested; Windows as the remote remains unsupported by design. Policy enforcement was not part of this run.

Initial harness attempts required restricting the temporary key ACL, retaining standard Windows process environment variables for OpenSSH, and selecting the folder ID instead of its absolute target path. These were test setup corrections; no transport source change was needed.
