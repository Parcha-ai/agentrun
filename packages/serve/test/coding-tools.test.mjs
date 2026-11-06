// A run's process registers no host shell: the coding tools serve installs are pi's without `bash`, and no tool the
// table binds brings it back. (confine.test.mjs drives a model that calls bash anyway: it is not available, and no
// command runs.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { ArchilCodingTools } from "@parcha/pi-durable-disk";
import { boxPath, CodingTools, codingSource } from "../dist/coding-tools.js";
import { BOUND_TOOLS, missingEnv, TOOLS } from "../dist/tools.js";

const names = (extension) => (extension.tools ?? []).map((tool) => tool.name);

test("the coding tools serve installs have no bash; read, write and edit are pi's own, only their refusals named by the path given, and the rest of pi's extension is kept", () => {
  assert.ok(names(ArchilCodingTools).includes("bash"), "pi's coding tools carry bash, which serve leaves out");
  assert.ok(!names(CodingTools).includes("bash"));
  for (const name of ["read", "write", "edit"]) assert.ok(names(CodingTools).includes(name), name);
  const pis = ArchilCodingTools.tools.filter((tool) => tool.name !== "bash");
  assert.equal(CodingTools.tools.length, pis.length);
  // pi's tool, not a copy: every field pi's, the schema and replay included, and only execute wrapped (asGivenRefusals).
  CodingTools.tools.forEach((tool, index) => {
    const { execute: _ours, ...fields } = tool;
    const { execute: _pis, ...theirs } = pis[index];
    assert.deepEqual(Object.keys(fields), Object.keys(theirs), tool.name);
    for (const key of Object.keys(theirs)) assert.equal(fields[key], theirs[key], `${tool.name}.${key} is pi's`);
    assert.notEqual(tool.execute, pis[index].execute, `${tool.name}'s refusals are named by the path given`);
  });
  const { tools: _ours, ...ours } = CodingTools;
  const { tools: _theirs, ...theirs } = ArchilCodingTools;
  assert.deepEqual(ours, theirs, "everything but the tools is pi's extension's, its name included");
});

test("no tool the table binds registers bash on the runner: what each installs and each selects, the file tools' extension being serve's, and bash binds none", async () => {
  const installed = [];
  const host = { where: { work: "/nonexistent", ref: { id: "run" } }, env: {}, coding: codingSource({ mode: "runner" }), install: (extension) => void installed.push(extension), onConversation() {}, beforeResume() {}, beforeRelease() {} };
  // Each that runs with no key: the browser needs a vendor's, which its plane says (tool-plane.ts), not its variables.
  const bound = BOUND_TOOLS.filter((name) => missingEnv(TOOLS[name], {}).length === 0 && name !== "browser");
  for (const name of ["read", "write", "edit", "ask_person", "web_fetch"]) assert.ok(bound.includes(name), `${name} binds with no key`);
  assert.ok(bound.includes("bash"), "bash is in the table, for a box");
  // bash and the background tools (background.ts) are sandbox-only: on the runner they bind nothing.
  const shells = bound.filter((name) => TOOLS[name].sandboxOnly);
  assert.deepEqual(shells, ["bash", "bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"]);
  for (const name of shells) assert.deepEqual(await TOOLS[name].bind(host), { tools: [], extensions: [] }, `on the runner ${name} binds nothing`);
  for (const name of bound.filter((name) => !TOOLS[name].sandboxOnly)) {
    const binding = await TOOLS[name].bind(host);
    assert.deepEqual(binding.tools.map((tool) => tool.name), [name]);
    if (["read", "write", "edit"].includes(name)) assert.deepEqual(binding.extensions, [CodingTools], name);
    for (const extension of [...installed, ...binding.extensions]) assert.ok(!names(extension).some((tool) => shells.includes(tool)), `${name}: ${extension.name}`);
  }
});

test("in a box the source is pi's read, write, edit and bash, and the background tools, each call made on the box's environment, nothing else of a call changed", async () => {
  const calls = [];
  const boxEnv = { cwd: "/workspace", marker: "the box's" };
  const source = codingSource({ mode: "sandbox", box: "docker" }, { env: async (context) => (calls.push(context), boxEnv) });
  assert.deepEqual(source.tools.map((tool) => tool.name).sort(), ["bash", "bash_background", "bash_input", "bash_list", "bash_output", "bash_signal", "edit", "read", "write"]);
  assert.deepEqual(source.extension.tools, source.tools);
  assert.equal(source.extension.name, ArchilCodingTools.name, "the extension keeps pi's name");
  const pis = Object.fromEntries(ArchilCodingTools.tools.map((tool) => [tool.name, tool]));
  for (const tool of source.tools.filter((tool) => !tool.name.startsWith("bash_"))) {
    assert.equal(tool.parameters, pis[tool.name].parameters, `${tool.name} keeps pi's schema`);
    assert.equal(tool.replay, pis[tool.name].replay, `${tool.name} keeps pi's replay`);
    assert.deepEqual(tool.outputLimits, pis[tool.name].outputLimits);
  }
  // A call's api reaches pi's tool with the box's env and every other field as given: pi's bash runs on it.
  const seen = [];
  const api = { env: { cwd: "/host" }, output: (chunk) => seen.push(chunk), outputWindow: undefined, retainedOutput: () => ({ text: "", truncated: false }), diagnostic() {}, callId: "c1" };
  boxEnv.exec = async (command, options) => (seen.push({ command, cwd: options.cwd, env: options.env, inherit: options.inheritEnv }), { ok: true, value: { exitCode: 0 } });
  const bash = source.tools.find((tool) => tool.name === "bash");
  const context = { marker: "ctx" };
  await bash.execute({ command: "printf hi > out.txt" }, api, context);
  assert.deepEqual(seen, [{ command: "printf hi > out.txt", cwd: "/workspace", env: {}, inherit: true }], "pi's bash, run in the box's cwd, on the box's own env alone");
  assert.deepEqual(calls, [context]);
  // A background tool's call is one command in the box, from the box's work dir (background.ts).
  seen.length = 0;
  boxEnv.exec = async (command) => (seen.push([...command.slice(0, 2), ...command.slice(4, 6)]), { ok: true, value: { exitCode: 0 } });
  const list = source.tools.find((tool) => tool.name === "bash_list");
  assert.match((await list.execute({}, api, context)).content[0].text, /^No background processes in this run's box/);
  assert.deepEqual(seen, [["sh", "-c", "/workspace", "list"]]);
  assert.deepEqual(calls, [context, context]);
  assert.throws(() => codingSource({ mode: "sandbox", box: "docker" }), /needs its box/);
});

test("in a box a file tool's path stays in the box's work dir: a host path, a way out, ~ or a file: URL is refused as the confined tools refuse, naming only the path given, before the box is asked", async () => {
  const asked = [];
  const source = codingSource({ mode: "sandbox", box: "docker" }, { env: async () => (asked.push("env"), { cwd: "/workspace" }) });
  const read = source.tools.find((tool) => tool.name === "read");
  for (const path of ["/var/lib/agentrun/runs/r1/work/x.md", "../x.md", "/workspacex/y", "~/x", "file:///etc/passwd", "/etc/passwd"]) {
    await assert.rejects(read.execute({ path }, {}, {}), { name: "PathOutsideWorkError", message: `${path}: outside the workspace` }, path);
  }
  assert.deepEqual(asked, [], "no box was asked for a refused path");
  for (const path of ["x.md", "sub/../x.md", "/workspace/x.md"]) {
    await read.execute({ path }, { output() {}, diagnostic() {} }, {}).catch(() => undefined);
  }
  assert.equal(asked.length, 3, "each path in the work dir reaches the box");
});

test("in a box a path under the run's own host work dir is the same file at the box's work dir, one for one; every other host path stays refused", async () => {
  const hostWork = "/var/lib/agentrun/runs/r1/work";
  assert.equal(boxPath(`${hostWork}/x.md`, hostWork), "/workspace/x.md");
  assert.equal(boxPath(`${hostWork}/sub/y.md`, hostWork), "/workspace/sub/y.md");
  assert.equal(boxPath(hostWork, hostWork), "/workspace");
  for (const path of ["/var/lib/agentrun/runs/r1/x.md", "/var/lib/agentrun/runs/r1/harness/work/x.md", "/var/lib/agentrun/.token", `${hostWork}/../x.md`, `${hostWork}x/y.md`, "/var/lib/agentrun/runs/r2/work/x.md"]) {
    assert.equal(boxPath(path, hostWork), undefined, path);
  }
  assert.equal(boxPath("x.md", hostWork), "x.md", "a relative path is the box's own");
  // Through the tools: the mapped call reaches the box under the box's path; a refused one never asks for the box.
  const asked = [];
  const source = codingSource({ mode: "sandbox", box: "docker" }, { hostWork, env: async () => (asked.push("env"), { cwd: "/workspace" }) });
  const read = source.tools.find((tool) => tool.name === "read");
  await assert.rejects(read.execute({ path: "/var/lib/agentrun/runs/r1/x.md" }, {}, {}), { name: "PathOutsideWorkError", message: "/var/lib/agentrun/runs/r1/x.md: outside the workspace" });
  assert.deepEqual(asked, []);
  await read.execute({ path: `${hostWork}/x.md` }, { output() {}, diagnostic() {} }, {}).catch(() => undefined);
  assert.deepEqual(asked, ["env"]);
});
