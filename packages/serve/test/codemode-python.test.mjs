// codemode's Python (`language: "python"`, runner/codemode-python.ts): the script runs in Monty by the JavaScript
// script's rules. Each tool call is a nested call, answered in the order the script made them, its value read by the
// script; a refused call ends the script in the gate's words; a script a person's answer parked runs again with its
// recorded calls answered from their records and ends at the call that ran now; a Python exception and a limit end the
// script as the JavaScript path's failures do. The model is a scripted origin and every tool local: nothing leaves
// this process.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { HOST_RESULT_MAX_CHARS } from "@parcha/agentrun-kernel";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { queue, release, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { CODEMODE, metaTools } = await import("../dist/runner/meta-tools.js");
const { runPython } = await import("../dist/runner/codemode-python.js");
/** The most tool calls one Python script may make (codemode-python.ts CODEMODE_PY_CALLS). */
const CODEMODE_PY_CALLS = 1_000;
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { suiteTools } = await import("../dist/runner/conformance/harness.js");
const { deniedText } = await import("../dist/refusal-words.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { KINDS } = await import("../dist/runner/journal-kinds.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(() => closeOpenSessions());

const tool = (name, description) => ({ name, description, inputSchema: { type: "object", properties: {} }, replay: "never", call: async () => ({ text: `${name} ran` }) });
const TOOLS = [tool("read_file", "Read a file of the workspace."), tool("write_file", "Write text to a file."), tool("send_email", "Send an email.")];
const codemodeOf = () => metaTools({ tools: () => TOOLS, granted: async () => true, codemode: true, discovery: { search: false, call: false } })[0];
const python = (codemode, script, nested) => codemode.call({ script, language: "python" }, { signal: new AbortController().signal, nested });

/** Nested calls answered by `answer(name, args)` (fresh: run now), each kept as [name, args, key]. */
function nestedCalls(answer = (name) => ({ text: `${name} ran` })) {
  const calls = [];
  return { calls, nested: { call: async (name, args, key) => (calls.push([name, args, key]), { fresh: true, ...answer(name, args) }), memo: async (_key, value) => value } };
}

test("a Python script's two tool calls run in order as nested calls, each its own key; the script reads their values, and its print() and return are the answer", async () => {
  const { calls, nested } = nestedCalls((name, args) => (name === "read_file" ? { text: JSON.stringify({ body: "hello" }) } : { text: `wrote ${args.path}`, structured: { wrote: args.path, size: args.text.length } }));
  const script = [
    'a = await tools.read_file({"path": "a.md"})',
    'b = await tools.write_file(path="b.md", text=a["body"].upper())',
    'print("wrote", b["wrote"])',
    'return {"first": a["body"], "second": b["wrote"], "size": b["size"]}',
  ].join("\n");
  const answer = await python(codemodeOf(), script, nested);
  assert.equal(answer.isError, undefined, answer.text);
  assert.deepEqual(calls.map(([name, args]) => [name, args]), [["read_file", { path: "a.md" }], ["write_file", { path: "b.md", text: "HELLO" }]], "each call once, in order, with its arguments");
  const keys = calls.map(([, , key]) => key);
  assert.ok(keys.every((key) => /^s\d+$/.test(key)) && new Set(keys).size === 2, `each call under a key of its own: ${keys}`);
  assert.deepEqual(answer.structured, { first: "hello", second: "b.md", size: 5 }, answer.text);
  assert.equal(answer.text, 'wrote b.md\n{"first":"hello","second":"b.md","size":5}', "its printed output, then its value, as a JavaScript script's console output and value read");
});

test("a Python script that raises fails as a JavaScript script does: its output, then the exception with its traceback; a call that fails raises in the script", async () => {
  const { nested } = nestedCalls((name) => (name === "send_email" ? { text: "no such address", isError: true } : { text: "ran" }));
  const codemode = codemodeOf();
  const raised = await python(codemode, 'print("before")\nawait tools.read_file({})\nraise ValueError("out of paper")', nested);
  assert.equal(raised.isError, true, raised.text);
  assert.match(raised.text, /^before\nThe script failed: Traceback[\s\S]*line 3[\s\S]*ValueError: out of paper$/, raised.text);
  const caught = await python(codemode, 'try:\n    await tools.send_email({})\nexcept Exception as error:\n    return f"caught: {error}"', nested);
  assert.equal(caught.isError, undefined, caught.text);
  assert.equal(caught.structured, "caught: no such address", "the tool's words are the exception's");
  const syntax = await python(codemode, "def broken(:\n    pass", nested);
  assert.equal(syntax.isError, true);
  assert.match(syntax.text, /^The script failed: [\s\S]*SyntaxError/, syntax.text);
});

test(`a Python script that calls a tool more than ${CODEMODE_PY_CALLS} times ends at the next call, which never runs; one that takes more memory than its bound ends there`, async () => {
  const { calls, nested } = nestedCalls();
  const codemode = codemodeOf();
  const many = await python(codemode, `for i in range(${CODEMODE_PY_CALLS + 5}):\n    await tools.read_file({"i": i})\nreturn "all"`, nested);
  assert.equal(many.isError, true, many.text);
  assert.match(many.text, new RegExp(`^The script failed: it called a tool more than ${CODEMODE_PY_CALLS} times`), many.text);
  assert.equal(calls.length, CODEMODE_PY_CALLS, "the calls up to the bound ran, none past it");
  const big = await python(codemode, 'x = "a" * 1000\nwhile True:\n    x = x + x', nested);
  assert.equal(big.isError, true, big.text);
  assert.match(big.text, /^The script failed: [\s\S]*MemoryError/, big.text);
});

test("a Python script whose call is aborted mid-loop ends at once: its worker is killed, never left to run to the time bound", async () => {
  const { nested } = nestedCalls();
  const stop = new AbortController();
  setTimeout(() => stop.abort(new Error("the session stopped")), 300);
  const began = Date.now();
  await assert.rejects(codemodeOf().call({ script: "n = 0\nwhile True:\n    n += 1", language: "python" }, { signal: stop.signal, nested }), /the session stopped/);
  assert.ok(Date.now() - began < 10_000, `ended ${Date.now() - began} ms in`);
});

test("a Python script whose call is stopped while it starts runs no step of the script, and its worker is killed at once", async () => {
  const stop = new AbortController();
  const calls = [];
  // The stop lands while the script starts: its start read, before its worker is checked out.
  const nested = { call: async (name) => (calls.push(name), { text: "ran", fresh: true }), memo: async (_key, value) => (stop.abort(new Error("the session stopped")), value) };
  const killed = [];
  const kill = process.kill;
  process.kill = (pid, signal) => (signal === "SIGKILL" && killed.push(pid), kill.call(process, pid, signal));
  try {
    await assert.rejects(runPython('await tools.read_file({})\nprint("ran")', TOOLS, nested, stop.signal), /the session stopped/);
  } finally {
    process.kill = kill;
  }
  assert.deepEqual(calls, [], "no tool call: the script never ran");
  assert.equal(killed.length, 1, "its worker was killed");
  // A SIGKILL lands a moment after it is sent: the worker is gone (or dead, waiting to be reaped) soon after.
  await until(async () => !running(killed[0]), "the worker is gone", 5_000);
});

test("a Python script's worker process holds none of the server's environment", { skip: process.platform !== "linux" && "reads /proc" }, async () => {
  const sentinel = "AGENTRUN_TEST_SENTINEL";
  process.env[sentinel] = "not-a-secret";
  const seen = [];
  try {
    // While the script waits on its call, its worker is this process's `monty` child: what it was started with.
    const nested = {
      call: async () => {
        for (const pid of childrenOf(process.pid)) {
          if (readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0].split("/").pop() !== "monty") continue;
          seen.push(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((pair) => pair.slice(0, pair.indexOf("="))));
        }
        return { text: "ran", fresh: true };
      },
      memo: async (_key, value) => value,
    };
    const answer = await runPython('await tools.read_file({})\nreturn "done"', TOOLS, nested, new AbortController().signal);
    assert.equal(answer.structured, "done", answer.text);
  } finally {
    delete process.env[sentinel];
  }
  // The script's worker, and any the pool started beside it.
  assert.ok(seen.length >= 1, "its worker, found while the script ran");
  assert.ok(seen.every((names) => !names.includes(sentinel)), "the sentinel set in the server's environment is in no worker's");
  assert.deepEqual(seen, seen.map(() => []), `each worker starts with an empty environment (they held: ${JSON.stringify(seen)})`);
});

test("Python is opt-in: the server installs without @pydantic/monty, and where it is missing a Python script answers the npm line that adds it, while JavaScript runs", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const version = pkg.peerDependencies?.["@pydantic/monty"];
  assert.equal(pkg.optionalDependencies?.["@pydantic/monty"], undefined, "not an optional dependency: npm would install it with the server");
  assert.deepEqual([version, pkg.peerDependenciesMeta?.["@pydantic/monty"]?.optional], ["1.6.0", true], "an optional peer, pinned: npm leaves it out unless asked");
  assert.equal(pkg.devDependencies?.["@pydantic/monty"], version, "this repository's tests have it");
  // A server process where the package does not resolve, as an install without it.
  const hook = `export async function resolve(specifier, context, next) { if (specifier === "@pydantic/monty") { const error = new Error("Cannot find package '@pydantic/monty'"); error.code = "ERR_MODULE_NOT_FOUND"; throw error; } return next(specifier, context); }`;
  const register = `import { register } from "node:module"; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hook)}`)});`;
  const child = `
    const { metaTools } = await import(${JSON.stringify(new URL("../dist/runner/meta-tools.js", import.meta.url).href)});
    const tool = { name: "read_file", description: "Read.", inputSchema: { type: "object", properties: {} }, replay: "never", call: async () => ({ text: "read" }) };
    const [codemode] = metaTools({ tools: () => [tool], granted: async () => true, codemode: true, discovery: { search: false, call: false } });
    const nested = { call: async (name) => ({ text: name + " ran", fresh: true }), memo: async (_key, value) => value };
    const signal = new AbortController().signal;
    const python = await codemode.call({ script: "await tools.read_file({})", language: "python" }, { signal, nested });
    const javascript = await codemode.call({ script: "return await tools.read_file({})" }, { signal, nested });
    process.stdout.write(JSON.stringify({ python, javascript }));
  `;
  const dir = mkdtempSync(join(tmpdir(), "codemode-py-missing-"));
  const server = join(dir, "server.mjs");
  writeFileSync(server, child);
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(register)}`, server], { env: { ...process.env, AGENTRUN_TELEMETRY: "0" } }).finally(() => rmSync(dir, { recursive: true, force: true }));
  const { python: answer, javascript } = JSON.parse(stdout);
  assert.equal(answer.isError, true, answer.text);
  assert.ok(answer.text.includes(`\`npm i @pydantic/monty@${version}\``), answer.text);
  assert.match(answer.text, /Nothing was run\.$/, answer.text);
  assert.equal(javascript.isError, undefined, javascript.text);
});

/** The pids of process `pid`'s children (Linux). */
const childrenOf = (pid) => readdirSync(`/proc/${pid}/task`).flatMap((task) => readFileSync(`/proc/${pid}/task/${task}/children`, "utf8").trim().split(/\s+/).filter(Boolean));

/** Whether process `pid` runs: on Linux not a zombie (dead, waiting to be reaped), elsewhere any process at all. */
function running(pid) {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[0] !== "Z";
  } catch (error) {
    if (error.code !== "ENOENT" || existsSync("/proc/self")) return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a Python script past its deadline ends there, and the tool call it waits on is cut with it", async () => {
  let seen = "not called";
  const nested = {
    call: (_name, _args, _key, signal) => new Promise((resolve, reject) => {
      seen = "waiting";
      const late = setTimeout(() => ((seen = "never cut"), resolve({ text: "slow done", fresh: true })), 5_000);
      signal?.addEventListener("abort", () => (clearTimeout(late), (seen = "cut"), reject(signal.reason)), { once: true });
    }),
    memo: async (_key, value) => value,
  };
  const began = Date.now();
  const answer = await runPython('await tools.read_file({})\nreturn "done"', TOOLS, nested, new AbortController().signal, 500);
  assert.equal(seen, "cut", "the tool saw the deadline's abort");
  assert.equal(answer.isError, true, answer.text);
  assert.equal(answer.text, "The script failed: the script ran past 500 ms.");
  assert.ok(Date.now() - began < 4_000, `ended ${Date.now() - began} ms in`);
});

test(`a Python script that prints more than ${HOST_RESULT_MAX_CHARS} characters ends there in the limit's words, its kept output within the bound`, async () => {
  const { calls, nested } = nestedCalls();
  const answer = await python(codemodeOf(), 'for i in range(30000):\n    print("x" * 99)\nawait tools.read_file({})\nreturn "all"', nested);
  assert.equal(answer.isError, true, answer.text.slice(-300));
  assert.match(answer.text, new RegExp(`The script failed: it printed more than ${HOST_RESULT_MAX_CHARS} characters`), answer.text.slice(-300));
  assert.ok(answer.text.length <= HOST_RESULT_MAX_CHARS + 500, `the answer is ${answer.text.length} characters`);
  assert.deepEqual(calls, [], "nothing after the bound ran");
});

test("a Python script run again after a park answers its recorded calls from their records, runs the parked call once, and ends there: nothing after it runs", async () => {
  // The call's first run memoized its start; this is the run after the person's answer: read_file is recorded, send_email
  // runs now.
  const first = { startedAt: 1, seed: 2, nonce: "the-first-run", tools: TOOLS.map((one) => [one.name, one.name]) };
  const calls = [];
  const nested = { call: async (name, args, key) => (calls.push([name, key]), name === "send_email" ? { text: "mailed", fresh: true } : { text: JSON.stringify({ body: "hello" }), fresh: false }), memo: async () => first };
  const answer = await python(codemodeOf(), 'a = await tools.read_file({})\nawait tools.send_email(body=f"{a[\'body\']}!")\nawait tools.write_file({})\nreturn "all done"', nested);
  assert.deepEqual(calls.map(([name]) => name), ["read_file", "send_email"], "the write after the parked call never ran");
  assert.deepEqual(calls.map(([, key]) => key), ["s0", "s1"], "each call under the key the first run gave it");
  assert.match(answer.text, /^The script was stopped/, answer.text);
  assert.deepEqual(answer.text.split("\n").filter((line) => /^\d+\. /.test(line)), [
    `1. read_file completed: {"body":"hello"}. Its effect is done; it was not run again.`,
    `2. send_email completed: "mailed". Its effect is done; it was not run again.`,
  ], answer.text);
  assert.doesNotMatch(answer.text, /all done/);
});

test("a Python script reaches the host's files, network, processes and environment only through its tools: each attempt raises in the script, touches nothing and makes no call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codemode-python-host-"));
  const secret = join(dir, "secret.txt");
  writeFileSync(secret, "host-file-contents");
  const canary = "CODEMODE_PY_CANARY";
  process.env[canary] = "canary-not-a-secret";
  try {
    const codemode = codemodeOf();
    const attempts = [
      'return open("/etc/passwd").read()',
      `return open(${JSON.stringify(secret)}).read()`,
      `open(${JSON.stringify(join(dir, "written.txt"))}, "w").write("x")`,
      `from pathlib import Path\nreturn Path(${JSON.stringify(secret)}).read_text()`,
      `from pathlib import Path\nPath(${JSON.stringify(join(dir, "path-written.txt"))}).write_text("x")`,
      `import json\nreturn json.load(open(${JSON.stringify(secret)}))`,
      `import os\nreturn os.listdir(${JSON.stringify(dir)})`,
      `import os\nreturn dict(os.environ)`,
      `import os\nreturn os.getenv(${JSON.stringify(canary)})`,
      `import os\nos.system("touch ${join(dir, "system-ran")}")`,
      `__import__("os")`,
      "import sys\nreturn sys.modules",
      "import socket",
      "import subprocess",
      "import urllib.request",
      "import http.client",
      "import io",
      "import ctypes",
      "import importlib",
    ];
    for (const script of attempts) {
      const { calls, nested } = nestedCalls();
      const answer = await python(codemode, script, nested);
      assert.equal(answer.isError, true, `${script}: ${answer.text}`);
      assert.match(answer.text, /^The script failed: [\s\S]*(PermissionError|RuntimeError|ModuleNotFoundError|NameError|AttributeError)/, `${script}: ${answer.text}`);
      assert.doesNotMatch(answer.text, /host-file-contents|canary-not-a-secret|root:/, `${script}: ${answer.text}`);
      assert.deepEqual(calls, [], `${script}: no tool call`);
    }
    assert.deepEqual(readdirSync(dir), ["secret.txt"], "nothing was written on the host");
  } finally {
    delete process.env[canary];
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Python script finds no way to the host through what the host hands it: a tool's value, the tools module, its functions or the builtins", async () => {
  const canary = "CODEMODE_PY_CANARY";
  process.env[canary] = "canary-not-a-secret";
  try {
    const codemode = codemodeOf();
    const attempts = [
      'a = await tools.read_file({})\nreturn getattr(a, "open")',
      "a = await tools.read_file({})\nreturn a.__class__",
      "a = await tools.read_file({})\nreturn type(a).__subclasses__()",
      'a = await tools.read_file({})\nreturn getattr(a["items"], "__class__")',
      'return getattr(tools, "open")("/etc/passwd")',
      'return tools.open("/etc/passwd")',
      "return tools.__dict__",
      "return tools.read_file.__globals__",
      'return getattr(print, "__self__")',
      'return getattr(__builtins__, "open")("/etc/passwd")',
      "return globals()",
      "return ().__class__.__base__.__subclasses__()",
      `return eval("open('/etc/passwd').read()")`,
      'exec("import os\\nx = os.environ")',
    ];
    for (const script of attempts) {
      const { calls, nested } = nestedCalls(() => ({ text: JSON.stringify({ body: "hello", items: [1, 2] }) }));
      const answer = await python(codemode, script, nested);
      assert.equal(answer.isError, true, `${script}: ${answer.text}`);
      assert.match(answer.text, /^The script failed: [\s\S]*(PermissionError|RuntimeError|NameError|AttributeError)/, `${script}: ${answer.text}`);
      assert.doesNotMatch(answer.text, /root:|canary-not-a-secret/, `${script}: ${answer.text}`);
      assert.deepEqual(calls.map(([name]) => name), script.includes("tools.read_file({})") ? ["read_file"] : [], `${script}: no call beyond the script's own`);
    }
  } finally {
    delete process.env[canary];
  }
});

test("codemode's language is javascript or python: any other is refused before anything runs", async () => {
  const { calls, nested } = nestedCalls();
  const answer = await codemodeOf().call({ script: "await tools.read_file({})", language: "ruby" }, { signal: new AbortController().signal, nested });
  assert.equal(answer.isError, true);
  assert.match(answer.text, /language is javascript \(the default\) or python\. Nothing was run\./);
  assert.deepEqual(calls, []);
  assert.deepEqual(codemodeOf().inputSchema.properties.language.enum, ["javascript", "python"]);
});

/** A pi run of a Python codemode `script` over the suite's tools on a runner (its gate `gate(call)`, else the suite's: ask
 *  for `asked`), until the run is `settled`: what each suite tool ran, the server's store, and the provider's requests. */
async function pythonRun(t, script, { gate, settled = "ended" } = {}) {
  const opened = await stores({ runners: 1 });
  const { server, runners: [store] } = opened;
  await queue(server, "run-1");
  const { tools, ran } = suiteTools();
  const requests = [];
  const spec = piAdapterSpec({ script: [{ call: CODEMODE, args: { script, language: "python" } }, { say: "done" }], tools, hooks: quiet }, { requests });
  const loop = createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), ...(gate ? { gate } : {}) }));
  const runner = startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING });
  t.after(async () => {
    try { await runner.close(); } finally { await release(opened); }
  });
  await ended(server, settled);
  return { ran, server, requests };
}

const ended = (server, state) => until(async () => {
  const now = await server.runs.get("run-1");
  return now.state === state && now.runner === null && now;
}, `the run ${state}`, 30_000);

/** The text of the newest tool result the provider got. */
function lastResult(requests) {
  const results = requests.flatMap((body) => (body.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : []))).filter((part) => part.type === "tool_result");
  const content = results.at(-1)?.content;
  return { text: typeof content === "string" ? content : (content ?? []).map((part) => (part.type === "text" ? part.text : "")).join(""), isError: results.at(-1)?.is_error === true };
}

test("on a runner, a Python script's call of a tool set to deny ends the script in the gate's words: the call before it ran, none after it", async (t) => {
  const script = 'await tools.read({})\nawait tools.effect({})\nawait tools.read({})\nreturn "all done"';
  const { ran, requests } = await pythonRun(t, script, { gate: (call) => (call.tool === "effect" ? "deny" : "allow") });
  assert.deepEqual([ran.read, ran.effect], [1, 0], `read ran once, effect never: ${JSON.stringify(ran)}`);
  const said = lastResult(requests);
  assert.equal(said.isError, true);
  assert.ok(said.text.startsWith(deniedText("effect", undefined, "server", "no")), said.text);
  assert.match(said.text, /The script stopped at this refused call, and nothing after it ran\./);
  assert.match(said.text, /1\. read completed/);
  assert.doesNotMatch(said.text, /all done/);
});

test("on a runner, a Python script's ask parks the run; approved, the script runs again with its read answered from its record, the asked call runs once, and the effect after it never runs", async (t) => {
  const script = 'a = await tools.read({})\nb = await tools.asked({})\nawait tools.effect({})\nreturn [a, b]';
  const { ran, server, requests } = await pythonRun(t, script, { settled: "parked" });
  assert.deepEqual([ran.read, ran.asked, ran.effect], [1, 0, 0], "the read ran, and the asked call waits");
  const row = await server.runs.get("run-1");
  const { entries } = await journalRecords(server.journal({ runId: "run-1", runner: "test-reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
  const ask = entries.find((entry) => entry.kind === KINDS.ask);
  assert.ok(ask, "the run wrote its ask");
  await sendCommand(server, "run-1", { kind: "approve", body: { approval: String(ask.data.callId) } });
  await ended(server, "ended");
  assert.deepEqual([ran.read, ran.asked, ran.effect], [1, 1, 0], "the read answered from its record, the asked call ran once, the effect never");
  const said = lastResult(requests).text;
  assert.match(said, /asked done/, said);
  assert.match(said, /The rest of the script did not run/, said);
});
