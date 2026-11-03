// A stand-in for `ssh`, started by the shim `fake-ssh.ts` puts on the sandbox PATH. It gets what
// the CLI gives ssh, `<host> <remote command>`, records it, checks that the remote command is
// `npx -y openteleport@<this version> ...`, and runs the built local CLI with the rest of the
// arguments as the "remote": in another home and working folder of the sandbox, stdin and
// stdout passed straight through. FAKE_SSH_MODE turns it into a host without npx (127), one
// that cannot be reached (255), or one whose shell prints a banner before the command.
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

const [host, command = ""] = process.argv.slice(2);
const env = process.env;

appendFileSync(env.FAKE_SSH_LOG, `${JSON.stringify({ host, command })}\n`);

const mode = env.FAKE_SSH_MODE ?? "ok";
if (mode === "unreachable") {
  process.stderr.write(`ssh: connect to host ${host} port 22: Connection refused\r\n`);
  process.exit(255);
}
if (mode === "no-npx") {
  process.stderr.write("bash: line 1: npx: command not found\n");
  process.exit(127);
}

/** The words of a command line quoted for a POSIX shell: single quotes and `'\''` only. */
function shellSplit(text) {
  const words = [];
  let word = "";
  let inWord = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'") {
      inWord = true;
      const end = text.indexOf("'", i + 1);
      if (end === -1) throw new Error(`unterminated quote in: ${text}`);
      word += text.slice(i + 1, end);
      i = end;
    } else if (ch === " ") {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      inWord = true;
      word += ch;
    }
  }
  if (inWord) words.push(word);
  return words;
}

const words = shellSplit(command);
const expected = `openteleport@${env.FAKE_SSH_VERSION}`;
if (words[0] !== "npx" || words[1] !== "-y" || words[2] !== expected) {
  process.stderr.write(`fake ssh: unexpected remote command: ${command}\n`);
  process.exit(1);
}
if (mode === "banner") process.stdout.write("Welcome to server\n");

const child = spawn(process.execPath, [env.FAKE_SSH_CLI, ...words.slice(3)], {
  cwd: env.FAKE_SSH_REMOTE_CWD,
  env: JSON.parse(env.FAKE_SSH_REMOTE_ENV),
  stdio: "inherit",
});
child.on("close", (code) => process.exit(code ?? 1));
