// Git-style external commands: `agentrun NAME [args]` runs agentrun-NAME from PATH when NAME is no command of the CLI's
// own, with the rest of the arguments, no shell, stdio inherited and its exit code passed on. A built-in is never
// shadowed, and a name that is no plain word, or one found only on a relative PATH entry, is today's unknown command.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { removeAtEnd } from "./support.mjs";

const BIN = new URL("../bin/agentrun.mjs", import.meta.url).pathname;
const SERVE = new URL("../../serve/dist/cli.js", import.meta.url).pathname;
const CLI = new URL("../lib/cli.mjs", import.meta.url).pathname;
const DROPPED = ["AGENTRUN_BASE_URL", "AGENTRUN_API_KEY", "AGENTRUN_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL", "AGENTRUN_BOXES"];

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-subcommands-"));
  removeAtEnd(dir);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !DROPPED.includes(name)));
  return { dir, env: { ...env, HOME: dir, XDG_CONFIG_HOME: join(dir, ".config"), AGENTRUN_BOXES: "none" } };
}

/** The CLI in a child process, killed after `timeout` ms, its code then null. */
const cli = (env, args, { input = "", timeout = 30_000, cwd } = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [BIN, ...args], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  child.once("close", (code, signal) => (clearTimeout(timer), resolve({ code, signal, out, err })));
  child.stdin.end(input);
});

/** A folder of executables, each `name` with the shell `script`. */
function bin(dir, scripts, mode = 0o755) {
  mkdirSync(dir, { recursive: true });
  for (const [name, script] of Object.entries(scripts)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, name), mode);
  }
  return dir;
}

test("agentrun NAME runs agentrun-NAME from PATH with the rest of the arguments, no shell, stdio inherited, its exit code passed on", async () => {
  const { dir, env } = scratch();
  const first = bin(join(dir, "first"), {
    "agentrun-hello": 'printf "%s\\n" "$@"; exit 7',
    "agentrun-cat": "cat",
    "agentrun-killed": "kill -TERM $$",
  });
  const path = { ...env, PATH: `${first}${delimiter}${env.PATH}` };
  const hello = await cli(path, ["hello", "a", "b c", "$(touch pwned)", "--base-url", "x"], { cwd: dir });
  assert.equal(hello.code, 7, hello.err);
  assert.equal(hello.out, "a\nb c\n$(touch pwned)\n--base-url\nx\n");
  assert.equal(existsSync(join(dir, "pwned")), false, "no shell read the arguments");
  const cat = await cli(path, ["cat"], { input: "piped in\n" });
  assert.deepEqual([cat.code, cat.out], [0, "piped in\n"]);
  const killed = await cli(path, ["killed"]);
  assert.equal(killed.code, 128 + 15, "a command a signal ended exits 128 + the signal's number");

  // The first executable one on PATH; a file that is not executable is passed over.
  const notRunnable = bin(join(dir, "plain"), { "agentrun-hello": "echo plain; exit 0" }, 0o644);
  const over = await cli({ ...env, PATH: [notRunnable, first, env.PATH].join(delimiter) }, ["hello", "x"]);
  assert.deepEqual([over.code, over.out], [7, "x\n"]);
});

test("agentrun NAME: a SIGINT, SIGQUIT, SIGTERM or SIGHUP sent to the CLI alone reaches the command, a terminal's Ctrl-C reaches it too, and the CLI waits for it to exit and passes on its code", async () => {
  const { dir, env } = scratch();
  const mark = join(dir, "mark");
  const tools = bin(join(dir, "tools"), {
    "agentrun-wait": [
      'trap \'echo INT >> "$MARK"; sleep 0.3; exit 42\' INT',
      'trap \'echo QUIT >> "$MARK"; sleep 0.3; exit 43\' QUIT',
      'trap \'echo TERM >> "$MARK"; sleep 0.3; exit 44\' TERM',
      'trap \'echo HUP >> "$MARK"; sleep 0.3; exit 45\' HUP',
      "echo ready",
      "while :; do sleep 0.1; done",
    ].join("\n"),
  });
  // The CLI in its own process group, as a terminal starts it: `group` sends the signal to the group (Ctrl-C), else to
  // the CLI alone (kill PID).
  const signalled = (signal, group) => new Promise((resolve) => {
    rmSync(mark, { force: true });
    const child = spawn(process.execPath, [BIN, "wait"], { env: { ...env, PATH: `${tools}${delimiter}${env.PATH}`, MARK: mark }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const timer = setTimeout(() => process.kill(-child.pid, "SIGKILL"), 8_000);
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out === "ready\n") group ? process.kill(-child.pid, signal) : child.kill(signal);
    });
    child.once("close", (code, killed) => (clearTimeout(timer), resolve({ code, killed, mark: existsSync(mark) ? readFileSync(mark, "utf8") : "" })));
  });
  for (const [signal, code] of [["SIGINT", 42], ["SIGQUIT", 43], ["SIGTERM", 44], ["SIGHUP", 45]]) {
    assert.deepEqual(await signalled(signal, false), { code, killed: null, mark: `${signal.slice(3)}\n` }, `${signal} sent to the CLI alone`);
  }
  // Ctrl-C reaches every process of the group, and the CLI passes it on too, so the command may get it twice; the CLI
  // does not exit before it, and exits with its code.
  const group = await signalled("SIGINT", true);
  assert.deepEqual([group.code, group.killed], [42, null], group.mark);
  assert.match(group.mark, /^(?:INT\n){1,2}$/);
});

test("externalOf on Windows: agentrun-NAME with .com, .exe, .bat or .cmd, in that order, in each absolute PATH folder, with no execute bit, whatever PATHEXT says; elsewhere no extension is added", async () => {
  const { externalOf } = await import(CLI);
  const { dir } = scratch();
  const folder = (name, files) => {
    mkdirSync(join(dir, name));
    for (const file of files) writeFileSync(join(dir, name, file), "");
    return join(dir, name);
  };
  // Files of mode 0644: Windows has no execute bit, a file is a program by its extension.
  const both = folder("both", ["agentrun-hello.cmd", "agentrun-hello.exe", "agentrun-hello.js", "agentrun-hello"]);
  const batch = folder("batch", ["agentrun-hello.cmd", "agentrun-hello.bat"]);
  const later = folder("later", ["agentrun-hello.com"]);
  const windows = (env) => externalOf("hello", env, "win32");
  // .exe before .cmd, .bat before .cmd.
  assert.equal(windows({ PATH: both }), join(both, "agentrun-hello.exe"));
  assert.equal(windows({ PATH: batch }), join(batch, "agentrun-hello.bat"));
  // PATHEXT is never read: neither an extension it adds nor its order.
  assert.equal(windows({ PATH: both, PATHEXT: ".JS;.CMD;.EXE" }), join(both, "agentrun-hello.exe"));
  // Folders in PATH's order, each folder's extensions in turn.
  assert.equal(windows({ PATH: [later, both].join(delimiter) }), join(later, "agentrun-hello.com"));
  assert.equal(windows({ PATH: [both, later].join(delimiter) }), join(both, "agentrun-hello.exe"));
  // Not another extension, not the bare name, not a folder of the name, not a relative PATH entry.
  assert.equal(windows({ PATH: folder("other", ["agentrun-hello.js", "agentrun-hello"]), PATHEXT: ".JS" }), undefined);
  mkdirSync(join(dir, "dirs", "agentrun-hello.exe"), { recursive: true });
  assert.equal(windows({ PATH: [join(dir, "dirs"), later].join(delimiter) }), join(later, "agentrun-hello.com"));
  assert.equal(windows({ PATH: "both" }), undefined);

  // Off Windows nothing changes: agentrun-hello.exe, executable, is not agentrun-hello, and the execute bit counts.
  const linux = bin(join(dir, "linux"), { "agentrun-hello.exe": "exit 0" });
  assert.equal(externalOf("hello", { PATH: linux }, "linux"), undefined);
  assert.equal(externalOf("hello", { PATH: both }, "linux"), undefined, "agentrun-hello there is not executable");
  chmodSync(join(both, "agentrun-hello"), 0o755);
  assert.equal(externalOf("hello", { PATH: both }, "linux"), join(both, "agentrun-hello"));
});

test("external on Windows: a batch file is refused before anything runs, exit 126, saying why; a spawn that throws is said, never a crash", async () => {
  const { external } = await import(CLI);
  let err = "";
  const io = { stderr: { write: (chunk) => (err += chunk) } };
  for (const file of ["C:\\tools\\agentrun-hello.cmd", "C:\\tools\\agentrun-hello.BAT"]) {
    err = "";
    assert.equal(await external(file, ["a & calc", "%PATH%"], {}, io, "win32"), 126);
    assert.match(err, /is a batch file/);
    assert.match(err, /cmd\.exe/);
    assert.match(err, /install agentrun-hello\.exe\.$/m, "the refusal names the command's own .exe");
  }
  err = "";
  assert.equal(await external("/nowhere/agentrun-\0hello", [], {}, io, "linux"), 126);
  assert.match(err, /^Cannot run /);
});

test("agentrun NAME: a built-in is never shadowed, and a name that is no plain word, one found only on a relative PATH entry, or none at all is today's unknown command", async () => {
  const { dir, env } = scratch();
  const shadows = bin(join(dir, "shadows"), Object.fromEntries(["login", "logout", "agents", "help", "api", "runs", "doctor"].map((name) => [`agentrun-${name}`, "echo shadowed; exit 9"])));
  const path = { ...env, PATH: `${shadows}${delimiter}${env.PATH}` };
  for (const args of [["help"], ["agents", "--help"], ["login", "--help"], ["api", "--help"], ["runs"], ["logout"]]) {
    const result = await cli(path, args);
    assert.notEqual(result.code, 9, `${args.join(" ")}: ${result.out}`);
    assert.doesNotMatch(result.out + result.err, /shadowed/, args.join(" "));
  }

  // agentrun a/b would be PATH's agentrun-a/b: a name is one plain word.
  bin(join(dir, "nested", "agentrun-a"), { b: "echo escaped; exit 9" });
  const nested = await cli({ ...env, PATH: `${join(dir, "nested")}${delimiter}${env.PATH}` }, ["a/b"]);
  assert.equal(nested.code, 2, nested.out);
  assert.match(nested.err, /agentrun has no command a\/b\./);
  // A relative PATH entry, or an empty one, is the working directory's, which anyone's checkout can fill: never searched.
  bin(join(dir, "rel"), { "agentrun-hello": "echo relative; exit 9" });
  bin(dir, { "agentrun-hello": "echo empty; exit 9" });
  const relative = await cli({ ...env, PATH: `rel${delimiter}${delimiter}${env.PATH}` }, ["hello"], { cwd: dir });
  assert.equal(relative.code, 2, relative.out);
  assert.match(relative.err, /agentrun has no command hello\./);
  const none = await cli(env, ["no-such-command-here"]);
  assert.equal(none.code, 2);
  assert.match(none.err, /^agentrun has no command no-such-command-here\./);
});

test("demo: an external command gets this environment, so it reaches the same server through the API", async (t) => {
  const { dir, env } = scratch();
  const faux = join(dir, "faux.mjs");
  writeFileSync(faux, 'export default (context, faux) => faux.message("The answer is 42.");\n');
  const data = join(dir, "data");
  const server = spawn(process.execPath, [SERVE, "--data", data, "--port", "0", "--faux", faux], { stdio: ["ignore", "pipe", "pipe"], env: { ...env, AGENTRUN_ACCOUNTS: "0" } });
  t.after(() => server.exitCode === null && server.kill("SIGKILL"));
  let err = "";
  server.stdout.resume();
  server.stderr.on("data", (chunk) => (err += chunk));
  for (let i = 0; !existsSync(join(data, ".server.json")); i++) {
    assert.ok(i < 600 && server.exitCode === null, `the server started: ${err}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const tools = bin(join(dir, "tools"), { "agentrun-count": '"$NODE" "$AGENTRUN_CLI" agents list --data "$AGENTRUN_DATA" | "$NODE" -e \'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>console.log("agents:",JSON.parse(s).agents.length))\'' });
  const count = await cli({ ...env, PATH: `${tools}${delimiter}${env.PATH}`, NODE: process.execPath, AGENTRUN_CLI: BIN, AGENTRUN_DATA: data }, ["count"]);
  assert.equal(count.code, 0, count.err);
  assert.match(count.out, /^agents: \d+\n$/);
});

test("help names external commands", async () => {
  const { env } = scratch();
  const help = await cli(env, ["help"]);
  assert.equal(help.code, 0, help.err);
  assert.match(help.out, /agentrun-NAME/);
});
