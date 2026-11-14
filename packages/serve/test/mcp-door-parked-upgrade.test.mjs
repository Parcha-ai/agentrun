// A run parked on an MCP call at the proxy door of a version before the door was deleted (#2722), resumed by this one. The
// door answered the CLI's own MCP client the waiting words, so the CLI's history holds the call answered and its resume
// never asks about it again; its start is on the record parked and not the bridge's (CallStartData.bridge). The claim that
// resumes the run answers it as that version did (door-parked.ts): an allow runs the call once through the host-tool path,
// a deny is told in its words, then one `[tool approval]` message the session goes on with.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sendCommand } from "../dist/runner/commands.js";
import { raw } from "./store-target.mjs";
import { CATALOG, parkedMcpRun, WIRE } from "./fixtures/parking-cli.mjs";

/** The stand-in: its first session parks its one call at the gate (the door asked the same gate); a later one is the
 *  CLI an earlier version left, whose call was answered the waiting words: its resume asks nothing, and a message it is
 *  sent is what the model reads. */
function doorCli(said) {
  return {
    id: "stand-in-cli",
    check: () => [],
    async open(_spec, io) {
      const later = (await io.writer.read()).some((record) => record.kind === "stand-in.sent");
      let state = later ? "open_turn" : "new";
      let turn;
      const closing = new AbortController();
      const done = (text) => {
        io.onEvent({ type: "text", delta: text });
        io.onEvent({ type: "turn_end", status: "completed" });
        return { status: "completed" };
      };
      return {
        get state() { return state; },
        async send(text) {
          state = "idle";
          if (!later) {
            await io.writer.append([{ kind: "stand-in.sent", data: null }]);
            turn = (async () => {
              const answer = await io.gate({ callId: "call-1", tool: WIRE, args: { path: "notes.md" } });
              if (answer === "allow" || "deny" in answer) throw new Error("the first pass parks");
              await new Promise((resolve) => closing.signal.addEventListener("abort", resolve, { once: true }));
              return { status: "aborted" };
            })();
            return;
          }
          said.push(text);
          turn = Promise.resolve(done("Done."));
        },
        async recover() {
          state = "idle";
          turn = Promise.resolve(done("It still waits for a person's approval."));
        },
        async settleOpenTurn() { state = "idle"; },
        turnEnd: () => turn,
        async interrupt() {},
        async close() { closing.abort(); },
      };
    },
  };
}

/** As the earlier version left it: the call's start parked, not the bridge's. */
async function asTheDoorLeftIt(file) {
  const db = await raw(file);
  try {
    const rows = await db.all("SELECT run_id, id, record FROM pi_entries WHERE run_id = ?", "run-1");
    let found = 0;
    for (const row of rows) {
      const record = typeof row.record === "string" ? JSON.parse(row.record) : row.record;
      if (record.kind !== "agentrun.call.start" || record.data?.callId !== "call-1") continue;
      assert.equal(record.data.parked, true);
      delete record.data.bridge;
      await db.run("UPDATE pi_entries SET record = ? WHERE run_id = ? AND id = ?", JSON.stringify(record), row.run_id, row.id);
      found += 1;
    }
    assert.equal(found, 1, "one parked start");
  } finally {
    await db.close();
  }
}

const ask = async () => "ask";

test("a run parked at an earlier version's MCP door runs the call once on the person's allow, and the session reads its result", async (t) => {
  const { ran, said, row } = await parkedMcpRun(t, {
    gate: ask,
    cli: doorCli,
    // The earlier version's runner stops; the record is as it left it; this version's runner starts.
    offline: asTheDoorLeftIt,
    meanwhile: (server) => sendCommand(server, "run-1", { kind: "approve", body: { approval: "call-1" } }),
  });
  assert.deepEqual(ran, [{ path: "notes.md" }], "the allowed call ran once");
  assert.equal(said.length, 1, "one message");
  assert.match(said[0], new RegExp(`^\\[tool approval\\] This answers your ${CATALOG} call call-1 \\(arguments \\{"path":"notes.md"\\}\\)`));
  assert.match(said[0], /They allowed it, and it ran\. Its result:\nthe call ran/);
  assert.equal(row.outcome ?? "completed", "completed", JSON.stringify(row));
});

test("a run parked at an earlier version's MCP door never runs the call on the person's deny: the message carries the refusal", async (t) => {
  const { ran, said } = await parkedMcpRun(t, {
    gate: ask,
    cli: doorCli,
    // The earlier version's runner stops; the record is as it left it; this version's runner starts.
    offline: asTheDoorLeftIt,
    meanwhile: (server) => sendCommand(server, "run-1", { kind: "deny", body: { approval: "call-1", note: "not now" } }),
  });
  assert.deepEqual(ran, [], "never run");
  assert.equal(said.length, 1, "one message");
  assert.match(said[0], /^\[tool approval\] This answers your mcp:srv\/write call call-1/);
  assert.match(said[0], /not now/);
});
