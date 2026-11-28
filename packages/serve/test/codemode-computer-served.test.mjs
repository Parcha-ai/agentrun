// A code-mode agent's computer calls on a served run, through the composition a live run takes: the server, the runner
// beside it, and each run a process of its own (run-child-host.ts childLoops), as the CLI's start runs them, its
// computer made by the runner at the claim (--faux's faux-desktop) and handed to the run's process across the channel.
// The Timeline is read over GET /runs/{id}/timeline. The model is the faux one (fixtures/faux-desktop-codemode.mjs): one
// codemode script that takes a screenshot and sends input through `computer`. Each call the script makes is a nested
// call with its own rows under the script's call, and each nested call's tool_result row carries the computer protocol
// calls it made (computer_calls), as a direct call's row does: the bench's step counter (computer-bench) reads them
// there. No key, no network, nothing rented.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DIRECT } from "./fixtures/faux-desktop-codemode.mjs";
import { agent, follow, serve } from "./support.mjs";

const FAUX = new URL("./fixtures/faux-desktop-codemode.mjs", import.meta.url).pathname;

for (const [hold, exec] of [[false, true], [true, true], [true, false]]) {
  test(`a code-mode run in its own process on a desktop${hold ? ", held as the bench holds it," : ""}${exec ? "" : " with exec off,"} keeps each nested computer call's protocol calls on its own row`, { timeout: 120_000 }, async (t) => {
    const server = await serve(t, { faux: FAUX, childRuns: {} });
    const made = await server.api("POST", "/agents", agent("desk", { tools: ["read", "write"], computer: { kind: "desktop", provider: "faux-desktop", surface: "code", ...(exec ? {} : { exec: false }) } }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const started = await server.api("POST", "/agents/desk/runs", { input: { content: "Look at the desktop, then move the pointer." }, ...(hold ? { hold: true } : {}) });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const runId = started.body.run_id;
    if (hold) {
      for (const deadline = Date.now() + 30_000; (await server.api("GET", `/runs/${runId}`)).body.computer?.held?.state !== "waiting";) {
        assert.ok(Date.now() < deadline, "the held computer came up waiting");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // The owner's calls before the start, as the bench makes them: on no tool call's row.
      for (const method of ["hello", "screen.shot"]) {
        const said = await server.api("POST", `/runs/${runId}/computer/call`, { method, params: {} });
        assert.equal(said.status, 200, JSON.stringify(said.body));
      }
      const go = await server.api("POST", `/runs/${runId}/start`, {});
      assert.equal(go.status, 200, JSON.stringify(go.body));
    }
    const { rows } = await follow(server.api, runId, hold ? ["working", "completed"] : ["completed"], {
      deadlineMs: 60_000,
      done: (now) => now.some((row) => row.kind === "final_answer"),
    });
    if (hold) await server.api("POST", `/runs/${runId}/computer/release`, {});
    const script = rows.find((row) => row.kind === "tool_use" && row.tool_name === "codemode");
    assert.ok(script, `the script has its own row: ${JSON.stringify(rows.map((row) => [row.kind, row.tool_name]))}`);
    const nested = rows.filter((row) => row.kind === "tool_result" && row.parent_tool_use_id === script.tool_use_id);
    assert.deepEqual(nested.map((row) => [row.tool_name, row.tool_status]), [["computer_screenshot", "success"], ["computer_op", "success"]], JSON.stringify(rows.map((row) => [row.kind, row.tool_name, row.tool_status, row.tool_result_preview])));
    assert.deepEqual(
      nested.map((row) => (row.computer_calls ?? []).map((call) => [call.method, call.ok])),
      [[["screen.shot", true]], [["input.actions", true]]],
      `each nested call's row carries its computer calls: ${JSON.stringify(nested)}`,
    );
  });
}

test("a run in its own process on a desktop whose surface is tools keeps its computer tool call's protocol calls on its row", { timeout: 120_000 }, async (t) => {
  const server = await serve(t, { faux: FAUX, childRuns: {} });
  const made = await server.api("POST", "/agents", agent("desk", { tools: ["read", "write"], computer: { kind: "desktop", provider: "faux-desktop", surface: "tools" } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const started = await server.api("POST", "/agents/desk/runs", { input: { content: DIRECT } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { rows } = await follow(server.api, started.body.run_id, ["completed"], { deadlineMs: 60_000, done: (now) => now.some((row) => row.kind === "final_answer") });
  const results = rows.filter((row) => row.kind === "tool_result");
  assert.deepEqual(results.map((row) => [row.tool_name, row.tool_status, row.parent_tool_use_id ?? null]), [["computer_screenshot", "success", null]], JSON.stringify(rows.map((row) => [row.kind, row.tool_name, row.tool_status])));
  assert.deepEqual((results[0].computer_calls ?? []).map((call) => [call.method, call.ok]), [["screen.shot", true]], `the call's row carries its computer calls: ${JSON.stringify(results[0])}`);
});
