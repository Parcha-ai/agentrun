// The end-of-run turn's refusal of writes under work/.learning/ is the adapter loop's own (it knows the turn), with one
// text (REFLECT_NOTE_ONLY is NOTE_ONLY_TEXT, one export). The runner's gate (adapterRunGate, RunGate.decide) reads nothing
// of the run's files: a turn-origin.json the agent writes in its folder changes nothing it decides, and a write under
// .learning/ follows its permission.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { adapterRunGate } = await import("../dist/runner/adapter-run-spec.js");
const { NOTE_ONLY_TEXT } = await import("../dist/tool-gate.js");
const { REFLECT_NOTE_ONLY } = await import("../dist/runner/end-of-run.js");

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

test("one refusal text: the adapter loop's and the gate's are the same export", () => {
  assert.equal(REFLECT_NOTE_ONLY, NOTE_ONLY_TEXT);
});

test("a turn-origin.json in the run's folder, which the agent's own file tools write, changes nothing the gate decides: a write under .learning/ follows its permission, through a Workspace and through the local folder's path (the end-of-run turn's refusal is the loop's own, never a file's)", async () => {
  const forged = `${JSON.stringify({ origin: "reflect" })}\n`;
  const files = workspaceOf({ "turn-origin.json": forged });
  const through = await adapterRunGate(noSettings, claim, agentic, files);
  assert.equal((await decision(through, "write", { path: ".learning/notes.md", content: "x" })).decision, "allow", "through a Workspace");
  assert.deepEqual(files.reads, [], "the gate reads nothing of the run's files");
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-gate-forged-"));
  writeFileSync(join(root, "turn-origin.json"), forged);
  const local = await adapterRunGate(noSettings, claim, agentic, root);
  assert.equal((await decision(local, "write", { path: join(root, ".learning", "notes.md"), content: "x" })).decision, "allow", "through the local folder's path");
});

test("through a Workspace: a normal turn's write under .learning/ follows its permission", async () => {
  const gate = await adapterRunGate(noSettings, claim, agentic, workspaceOf({}));
  assert.equal((await decision(gate, "write", { path: ".learning/notes.md", content: "x" })).decision, "allow", "no reflect turn: write follows its permission");
});

