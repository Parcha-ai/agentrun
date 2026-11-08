// pi's read, write and edit on a Workspace (serve/src/workspace/pi-env.ts) answer a model exactly as today's file tools
// in a box do (pi's tools on the box's bound folder, coding-tools.ts and bound-files.ts): the same text, the same
// error, the same files after, case by case. And bash on the Workspace: its output streams, a long one is spilled whole
// to .agentrun/output/ in the run's folder (read can open it), a signal is 128 + n, the environment is only what it is
// given, and a timeout, an abort and a cwd outside are said as pi's own environment says them.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { codingSource } from "../dist/coding-tools.js";
import { hostTools } from "../dist/host-tools.js";
import { localWorkspace } from "../dist/workspace/index.js";
import { bashTool, fileTools, OUTPUT_DIR, piEnv } from "../dist/workspace/pi-env.js";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-pi-env-")));
  dirs.push(dir);
  const root = join(dir, "work");
  mkdirSync(root);
  return root;
}
/** A PNG of one pixel. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
function seed(root) {
  writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(root, "big.txt"), Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n"));
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "b.md"), "# b\nfoo foo\n");
  writeFileSync(join(root, "img.png"), PNG);
}
/** Every file under `root`, path to text. */
function files(root, at = "") {
  const out = {};
  for (const name of readdirSync(join(root, at)).sort()) {
    const rel = at ? `${at}/${name}` : name;
    try { Object.assign(out, files(root, rel)); } catch { out[rel] = readFileSync(join(root, rel), "utf8"); }
  }
  return out;
}

const NAMES = ["read", "write", "edit"];
/** Today's file tools in a Docker box: pi's, on this machine's bind source, the box naming it /workspace. */
function today(root) {
  const source = codingSource({ mode: "sandbox", box: "docker" }, { hostWork: root, bound: async () => true, leftEnded: async () => undefined, env: async () => { throw new Error("no box: the file tools run here"); } });
  // The run's environment is the box's, which names its folder /workspace: answers name a path relative to it.
  return hostTools({ env: async () => ({ cwd: "/workspace" }) }, NAMES, ctx, new Map(), source.tools.filter((tool) => NAMES.includes(tool.name)));
}
/** The same tools on the Workspace. */
function onWorkspace(root, cwd = "/workspace") {
  const env = piEnv(localWorkspace(root), { cwd, env: {}, defaultTimeoutS: 120 });
  return hostTools({ env: async () => env }, NAMES, ctx, new Map(), fileTools());
}
const call = (tools, name, args) => tools.find((tool) => tool.name === name).call(args, { callId: `c-${Math.random()}`, signal: new AbortController().signal });

const CASES = [
  ["read", { path: "a.txt" }],
  ["read", { path: "/workspace/a.txt" }],
  ["read", { path: "@a.txt" }],
  ["read", { path: "a.txt", offset: 2, limit: 1 }],
  ["read", { path: "big.txt" }],
  ["read", { path: "big.txt", offset: 2990 }],
  ["read", { path: "sub/b.md" }],
  ["read", { path: "img.png" }],
  ["read", { path: "nope.txt" }],
  ["read", { path: "../x" }],
  ["read", { path: "/etc/passwd" }],
  ["read", { path: "~/.bashrc" }],
  ["read", { path: "file:///etc/passwd" }],
  ["write", { path: "new/deep.txt", content: "made\n" }],
  ["write", { path: "a.txt", content: "replaced\n" }],
  ["write", { path: "/workspace/abs.txt", content: "abs\n" }],
  ["write", { path: "../escape.txt", content: "no" }],
  ["write", { path: "/tmp/escape.txt", content: "no" }],
  ["edit", { path: "sub/b.md", edits: [{ oldText: "# b", newText: "# B" }] }],
  ["edit", { path: "sub/b.md", edits: [{ oldText: "missing text", newText: "x" }] }],
  ["edit", { path: "sub/b.md", edits: [{ oldText: "foo", newText: "bar" }] }],
  ["edit", { path: "nope.md", edits: [{ oldText: "a", newText: "b" }] }],
  ["edit", { path: "../../x", edits: [{ oldText: "a", newText: "b" }] }],
];

test("pi's read, write and edit on the Workspace answer as today's box file tools do: the same text, the same error, the same files after", async () => {
  const [left, right] = [scratch(), scratch()];
  seed(left);
  seed(right);
  const [was, now] = [today(left), onWorkspace(right)];
  for (const [name, args] of CASES) {
    const [expected, actual] = [await call(was, name, args), await call(now, name, args)];
    assert.deepEqual(actual, expected, `${name} ${JSON.stringify(args)}`);
  }
  assert.deepEqual(files(right), files(left), "the same files after");
  assert.ok(!readdirSync(join(right, "..")).includes("escape.txt"));
});

test("on the runner the folder is named by its own path: an absolute path under it is the same file, and answers name it relative", async () => {
  const root = scratch();
  seed(root);
  const tools = onWorkspace(root, root);
  assert.equal((await call(tools, "read", { path: join(root, "a.txt") })).text.split("\n")[0].trim().endsWith("one"), true);
  assert.deepEqual(await call(tools, "write", { path: join(root, "w.txt"), content: "w" }), { text: "Successfully wrote to w.txt", isError: false });
  assert.deepEqual(await call(tools, "read", { path: "/workspace/a.txt" }), { text: "/workspace/a.txt: outside the workspace", isError: true }, "/workspace is no name of a folder on the runner");
});

test("a link in the run's folder is refused by read, write and edit, in words, and never followed", async () => {
  const root = scratch();
  const outside = join(root, "..", "outside.txt");
  writeFileSync(outside, "secret");
  symlinkSync(outside, join(root, "link.txt"));
  const tools = onWorkspace(root);
  for (const [name, args] of [["read", { path: "link.txt" }], ["write", { path: "link.txt", content: "x" }], ["edit", { path: "link.txt", edits: [{ oldText: "secret", newText: "x" }] }]]) {
    const answer = await call(tools, name, args);
    assert.equal(answer.isError, true, name);
    assert.match(answer.text, /link\.txt: refused: a link is on the way to it, or it is one/, name);
    assert.doesNotMatch(answer.text, /secret/);
  }
  assert.equal(readFileSync(outside, "utf8"), "secret");
});

/** pi's bash on the Workspace, through a host tool: the answer a model reads. */
function bashOn(root, options = {}) {
  const env = piEnv(localWorkspace(root), { cwd: options.cwd ?? "/workspace", env: options.env ?? { PATH: "/usr/local/bin:/usr/bin:/bin" }, defaultTimeoutS: 120 });
  return { env, tool: hostTools({ env: async () => env }, ["bash"], ctx, new Map(), [bashTool()])[0] };
}

test("bash on the Workspace: runs in the run's folder, with only the environment it is given; an exit and a signal are said as pi says them", async () => {
  const root = scratch();
  writeFileSync(join(root, "here.txt"), "found\n");
  const { tool } = bashOn(root, { env: { PATH: "/usr/bin:/bin", ONLY: "this" } });
  assert.deepEqual(await call([tool], "bash", { command: "cat here.txt; env | sort" }), { text: "found\nONLY=this\nPATH=/usr/bin:/bin\nPWD=" + root + "\nSHLVL=1\n_=/usr/bin/env\n", isError: false });
  const failed = await call([tool], "bash", { command: "echo out; exit 3" });
  assert.deepEqual(failed, { text: "out\n\n\nCommand exited with code 3", isError: true });
  const killed = await call([tool], "bash", { command: "kill -TERM $$" });
  assert.deepEqual(killed, { text: "Command exited with code 143", isError: true });
});

test("bash on the Workspace: a long output keeps its tail, and is spilled whole to .agentrun/output/ in the run's folder, which read opens", async () => {
  const root = scratch();
  const { env, tool } = bashOn(root);
  const answer = await call([tool], "bash", { command: "seq 1 5000" });
  assert.match(answer.text, /^\[earlier output omitted\]\n/);
  assert.match(answer.text, /\n5000\n/);
  const full = answer.text.match(/Full output: (\S+)$/)?.[1];
  assert.ok(full?.startsWith(`/workspace/${OUTPUT_DIR}/`), answer.text.slice(-200));
  const rel = full.slice("/workspace/".length);
  assert.equal(readFileSync(join(root, rel), "utf8"), Array.from({ length: 5000 }, (_, i) => `${i + 1}\n`).join(""), "the whole output");
  const [read] = hostTools({ env: async () => env }, ["read"], ctx, new Map(), fileTools());
  assert.match((await call([read], "read", { path: full, offset: 5000 })).text, /^5000\n/);
});

test("bash on the Workspace: a timeout is said as pi says it, its output kept; a cwd outside is refused", async () => {
  const root = scratch();
  const { tool } = bashOn(root);
  const started = Date.now();
  const timed = await call([tool], "bash", { command: "echo before; sleep 30", timeout: 1 });
  assert.ok(Date.now() - started < 10_000);
  assert.deepEqual(timed, { text: "before\n\n\nCommand timed out after 1 seconds", isError: true });
});

test("bash on the Workspace streams: pi's api.output gets the first line before the command ends", async () => {
  const root = scratch();
  const { env } = bashOn(root);
  const seen = [];
  const started = Date.now();
  const ran = await env.exec("echo first; sleep 1; echo second", { onOutput: (text) => seen.push([text, Date.now() - started]) }, ctx);
  assert.equal(ran.ok, true);
  assert.equal(seen[0][0], "first\n");
  assert.ok(seen[0][1] < 900, `streamed at ${seen[0][1]} ms`);
  const outside = await env.exec("pwd", { cwd: "/etc" }, ctx);
  assert.equal(outside.ok, false);
  assert.equal(outside.error.code, "spawn_error");
});
