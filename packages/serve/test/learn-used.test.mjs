// Which notes a run used: the reads its job made of its copy of the folder, found in its normalized timeline rows the
// same way on every harness. Each harness's rows below are as tonight's QA runs and the faux harnesses wrote them: pi's
// call ids hold a `|`, claude-agent's CLI names the workspace in full and can put a result above its call, codex's host
// tools are app-server dynamic tools. Every one of them names the tool `read`, with the path as the model gave it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { notesRead } from "../dist/learning-run.js";

/** A call and its result, as the timeline writes them: the call at entry `entry`, its result at the next. */
function read(entry, id, path, status = "success", { harness = "pi", above = false } = {}) {
  const call = { id: `1:${entry}:0`, kind: "tool_use", tool_name: "read", tool_use_id: id, tool_status: null, tool_input_preview: path, summary: `Read ${path}`, agent_label: null };
  const result = { id: `1:${entry + 1}`, kind: "tool_result", tool_name: "read", tool_use_id: id, tool_status: status, tool_input_preview: null, summary: `Read ${path}: ${status === "success" ? "ok" : "failed"}`, agent_label: null, harness };
  return above ? [result, call] : [call, result];
}

test("a run's reads of its .learning/ copy, on pi, claude-agent and codex rows: relative, ./, absolute and dotted paths each name the file once, in the order first read; a failed or unended read, MEMORY.md, a file below the folder's top, another tool and a look-alike folder do not", () => {
  const work = "/var/lib/agentrun/runs/0193/work";
  const rows = [
    // pi: relative to the workspace, as pi's file tools take it.
    ...read(10, "call_A1|fc_1", ".learning/units.md"),
    ...read(12, "call_A2|fc_2", "./.learning/sources.md"),
    // claude-agent: the CLI's working directory joined, its result row above its call (QA F28).
    ...read(14, "toolu_01B", `${work}/.learning/tables.md`, "success", { harness: "claude-agent", above: true }),
    // codex: a dynamic tool's call; a box's workspace, named with a step back in it.
    ...read(16, "call_C1", "/workspace/sub/../.learning/refunds.md", "success", { harness: "codex" }),
    // Read again: counted once.
    ...read(18, "call_A3|fc_3", ".learning/units.md"),
    // Not a note used: a read that failed, the index, a file below the top, a look-alike folder.
    ...read(20, "call_A4|fc_4", ".learning/missing.md", "failed"),
    ...read(22, "call_A5|fc_5", ".learning/MEMORY.md"),
    ...read(24, "call_A6|fc_6", ".learning/old/units.md"),
    ...read(26, "call_A7|fc_7", "notes.learning/units.md"),
    // A read that never ended: its call alone.
    read(28, "call_A8|fc_8", ".learning/hung.md")[0],
    // Another tool that names the folder.
    { id: "1:30:0", kind: "tool_use", tool_name: "write", tool_use_id: "call_W|fc", tool_status: null, tool_input_preview: ".learning/new.md", agent_label: null },
    { id: "1:31", kind: "tool_result", tool_name: "write", tool_use_id: "call_W|fc", tool_status: "success", tool_input_preview: null, agent_label: null },
  ];
  assert.deepEqual(notesRead(undefined, rows), ["units.md", "sources.md", "tables.md", "refunds.md"]);
});

test("the end-of-run turn's reads are its own, not the job's: a read after the job's last entry is left out, and a follow-up's read after the turn ended counts", () => {
  const rows = [...read(10, "a", ".learning/job.md"), ...read(40, "b", ".learning/turn.md"), ...read(60, "c", ".learning/follow-up.md")];
  // The turn's rows are those after entry 30, through entry 50 once the run ended.
  assert.deepEqual(notesRead({ outcome: "completed", after: 30, until: 50, deadline: new Date().toISOString() }, rows), ["job.md", "follow-up.md"]);
  // While the turn runs, every later entry is its own.
  assert.deepEqual(notesRead({ outcome: "completed", after: 30, deadline: new Date().toISOString() }, rows), ["job.md"]);
});
