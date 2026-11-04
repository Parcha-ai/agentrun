// The turn-end marker a claude-agent or codex run's root gets (turn-end.ts) is inert everywhere but decide(): the same
// entries with it and without it give the same timeline rows, the same metrics and the same spend the cap reads.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { REQUEST_STARTED, runMetricsOf, timelineOf } from "@parcha/pi-durable-agent/timeline";
import { spentIn } from "../dist/cap.js";
import { ADAPTER_API, TURN_END } from "../dist/turn-end.js";

const ROOT = mkdtempSync(join(tmpdir(), "agentrun-turn-end-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const key = "run:r1";
const usage = (usd) => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usd } });
const assistant = (id, content, stopReason, usd) => ({ kind: "pi.assistant", id, conversationId: 1, model: [{ role: "assistant", content, api: ADAPTER_API, provider: "claude-agent", model: "m", usage: usage(usd), stopReason, timestamp: 1_000 + id }] });
const user = (id, text) => ({ kind: "pi.user", id, conversationId: 1, model: [{ role: "user", content: [{ type: "text", text }], timestamp: 1_000 + id }] });
const marker = (id, status) => ({ kind: TURN_END, id, conversationId: 1, data: { key, status } });
/** Two turns as the bridge writes them, with each turn's end or without it. */
function entries(withMarkers) {
  return [
    user(1, "Write it."),
    { kind: REQUEST_STARTED, id: 2, conversationId: 1, data: { key, request: 1 } },
    assistant(3, [{ type: "text", text: "On it." }, { type: "toolCall", id: "c1", name: "write", arguments: { path: "a.md", content: "a" } }], "toolUse", 0.001),
    { kind: "pi.tool-result", id: 4, conversationId: 1, model: [{ role: "toolResult", toolCallId: "c1", toolName: "write", content: [{ type: "text", text: "Successfully wrote to a.md" }], isError: false, timestamp: 1_004 }] },
    { kind: REQUEST_STARTED, id: 5, conversationId: 1, data: { key, request: 2 } },
    assistant(6, [{ type: "text", text: "Wrote a.md." }], "stop", 0.002),
    ...(withMarkers ? [marker(7, "completed")] : []),
    user(8, "/compact"),
    { kind: REQUEST_STARTED, id: 9, conversationId: 1, data: { key, request: 3 } },
    assistant(10, [], "stop", 0.0005),
    ...(withMarkers ? [marker(11, "completed")] : []),
  ];
}

/** A run store holding `list` as its entries, as spentIn reads one. */
function storeOf(name, list) {
  const file = join(ROOT, `${name}.sqlite`);
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE entries (record TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO entries (record) VALUES (?)");
  for (const entry of list) insert.run(JSON.stringify(entry));
  db.close();
  return file;
}

test("a store with the turn-end markers reads the same rows, the same metrics and the same spend as one without", () => {
  const [plain, marked] = [entries(false), entries(true)];
  const rows = (list) => timelineOf(list, { settled: true }).map((r) => [r.id, r.kind, r.summary, r.usage ?? null]);
  assert.deepEqual(rows(marked), rows(plain), "no row for a marker, and every other row the same");
  assert.ok(rows(plain).some(([, kind]) => kind === "usage"), "the timeline has its usage row");
  assert.deepEqual(runMetricsOf(marked), runMetricsOf(plain), "the metrics");
  assert.equal(spentIn(storeOf("marked", marked)), spentIn(storeOf("plain", plain)), "the spend the cap reads");
  assert.ok(Math.abs(spentIn(storeOf("marked-2", marked)) - 0.0035) < 1e-12, "and the spend is the requests' own");
});
