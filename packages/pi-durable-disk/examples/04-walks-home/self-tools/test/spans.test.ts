import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { TOOLS, renderTranscript, trainingRow, type Msg } from "../../../03-tab-to-cloud/tab/tool-format.ts";

// The trainer (train_tools.py) slices a row's text by its spans in Python; with emoji before a model turn, Python must
// get exactly the model turns.
test("python slices a written row's spans to exactly the model turns, emoji or not", (t) => {
  if (spawnSync("python3", ["--version"]).status !== 0) return t.skip("no python3");
  const msgs = [
    { role: "user", content: "Paint 🌉 into a.txt." },
    { role: "assistant", content: [{ type: "thinking", thinking: "Write 🌉🌕." }, { type: "toolCall", id: "c", name: "write", arguments: { path: "a.txt", content: "🌉\n" } }] },
    { role: "toolResult", toolCallId: "c", toolName: "write", content: [{ type: "text", text: "Successfully wrote to a.txt" }], isError: false },
    { role: "assistant", content: [{ type: "thinking", thinking: "Done." }, { type: "text", text: "a.txt has 🌉." }] },
  ] as Msg[];
  const { text, train } = renderTranscript(TOOLS, msgs);
  const want = train.map(([a, b]) => text.slice(a, b));
  const py = spawnSync("python3", ["-c", "import json,sys; r=json.load(sys.stdin); print(json.dumps([r['text'][a:b] for a,b in r['train']]))"], { input: JSON.stringify(trainingRow(text, train)), encoding: "utf8" });
  assert.equal(py.status, 0, py.stderr);
  assert.deepEqual(JSON.parse(py.stdout), want);
});
