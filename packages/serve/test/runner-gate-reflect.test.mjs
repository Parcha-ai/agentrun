// The runner's gate (adapterRunGate, RunGate.decide) refuses the end-of-run turn's writes under work/.learning/ first, in
// RunGate.enter's order, with the one refusal text the adapter loop also gives (REFLECT_NOTE_ONLY is NOTE_ONLY_TEXT, one
// export). The turn's origin is read through the run's files as given: a Workspace (Mode 2: the run's folder on its
// disk, never a folder of this machine) or the local folder's path. A normal turn's write there follows its permission.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { adapterRunGate } = await import("../dist/runner/adapter-run-spec.js");
const { NOTE_ONLY_TEXT, TURN_ORIGIN_FILE } = await import("../dist/tool-gate.js");
const { REFLECT_NOTE_ONLY } = await import("../dist/runner/end-of-run.js");
const { readFileSync, mkdirSync } = await import("node:fs");
const { runFolder } = await import("../dist/workspace/paths.js");
const { specFor } = await import("./runner-spec-support.mjs");

/** A store whose server tool settings are none (every default). */
const noSettings = { settings: { get: async () => undefined } };
const claim = { runId: "run-1" };
const agentic = { kind: "agentic", body: { approvals: "ask" } };
/** A Workspace stub holding only `files` (by path in the run's folder): what the gate reads, recorded. */
const workspaceOf = (files) => {
  const reads = [];
  return {
    reads,
    read: async (path) => {
      reads.push(path);
      if (!(path in files)) throw Object.assign(new Error(`no such file: ${path}`), { code: "ENOENT" });
      return new TextEncoder().encode(files[path]);
    },
    stat: async (path) => (path in files ? { kind: "file", size: files[path].length } : undefined),
  };
};
const decision = async (gate, tool, args) => {
  const given = await gate({ callId: "c", tool, args });
  return typeof given === "string" ? { decision: given } : { decision: "deny", text: given.deny };
};
const reflect = `${JSON.stringify({ origin: "reflect" })}\n`;

test("one refusal text: the adapter loop's and the gate's are the same export", () => {
  assert.equal(REFLECT_NOTE_ONLY, NOTE_ONLY_TEXT);
});

test("through a Workspace (no local file): the end-of-run turn's write under .learning/ is refused first with the one text; its origin is read from the run's files", async () => {
  const files = workspaceOf({ [TURN_ORIGIN_FILE]: reflect });
  const gate = await adapterRunGate(noSettings, claim, agentic, files);
  for (const [tool, args] of [["write", { path: ".learning/notes.md", content: "x" }], ["edit", { path: "/workspace/.learning/notes.md", oldText: "a", newText: "b" }]]) {
    const got = await decision(gate, tool, args);
    assert.deepEqual(got, { decision: "deny", text: NOTE_ONLY_TEXT }, `${tool} ${args.path}: refused with the one text`);
  }
  assert.ok(files.reads.includes(TURN_ORIGIN_FILE), `the turn's origin was read through the Workspace: ${JSON.stringify(files.reads)}`);
  assert.equal((await decision(gate, "write", { path: "report.md", content: "x" })).decision, "allow", "a write outside .learning/ follows its permission");
});

test("through a Workspace: a normal turn's write under .learning/ follows its permission", async () => {
  const gate = await adapterRunGate(noSettings, claim, agentic, workspaceOf({}));
  assert.equal((await decision(gate, "write", { path: ".learning/notes.md", content: "x" })).decision, "allow", "no reflect turn: write follows its permission");
});

test("through the local folder's path: the end-of-run turn's write under .learning/ is refused with the one text; a normal turn's follows its permission", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-gate-reflect-"));
  const gate = await adapterRunGate(noSettings, claim, agentic, root);
  assert.equal((await decision(gate, "write", { path: join(root, ".learning", "notes.md"), content: "x" })).decision, "allow", "no turn origin yet: follows its permission");
  writeFileSync(join(root, TURN_ORIGIN_FILE), reflect);
  assert.deepEqual(await decision(gate, "write", { path: join(root, ".learning", "notes.md"), content: "x" }), { decision: "deny", text: NOTE_ONLY_TEXT }, "a reflect turn: refused first");
  assert.equal(readFileSync(join(root, TURN_ORIGIN_FILE), "utf8"), reflect, "the gate only reads the run's files");
});

// Mirrors the assertions of the Mode 2 acceptance red (runner-mode2-root-reads.test.mjs on the CLI-spec branch) on this
// base, where the spec builder is Mode 1 only and cliRunSpecFromLaunch is not yet merged: pi's spec, built for a claimed
// run as the dispatch builds it, gives its gate the run's Workspace, and a reflect turn's write under .learning/ is
// refused with the one text. (The acceptance red asserts the bare string "deny"; this gate refuses with its words, which
// the loop passes to the model: { deny: NOTE_ONLY_TEXT }.)
const reflectWrite = { callId: "c1", tool: "write", args: { path: ".learning/notes.md", content: "kept" } };
test("pi's spec (adapterRunSpecFromLaunch): the gate reads the turn's origin from the run's Workspace: a reflect turn's write under .learning/ is refused with the one text", async (t) => {
  const { spec, dir } = await specFor(t, { body: { tools: ["read", "write"] } });
  const folder = runFolder(dir, "agent-1", "run-1");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, TURN_ORIGIN_FILE), reflect);
  const given = await spec.gate(reflectWrite);
  assert.deepEqual(given, { deny: NOTE_ONLY_TEXT }, `refused with the one text: ${JSON.stringify(given)}`);
  writeFileSync(join(folder, TURN_ORIGIN_FILE), `${JSON.stringify({ origin: "person" })}\n`);
  assert.equal(await spec.gate(reflectWrite), "allow", "a person's turn: the write follows its permission");
});
