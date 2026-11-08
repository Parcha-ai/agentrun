// Reds 5 and 6, the held path (the lead's ruling (c)): what pi shows before it stores it (a running tool, a partial)
// reaches the stream from the run's run_live row (store.live), which the runner writes per tick (runner/live-ticker.ts)
// and never into the journal. The stream merges it BESIDE the stored commits' events, in the existing vocabulary (a
// running tool is tool_execution_start/update), never inside a stored group: a held start and the stored end that follows
// it read start then end, with the start once. Once the run ends, its row is gone and nothing held follows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { collect, liveWorld, RUN, settled, until } from "./live-support.mjs";

const { watchRun } = await import("../dist/live/stream.js");

test("a running tool reaches the stream from run_live while it runs, then its stored end: start once, then end", async (t) => {
  const w = await liveWorld(t);
  const stream = await watchRun(w.server, RUN, { pollMs: 20 });
  t.after(() => stream.stop());
  const got = collect(stream);
  await w.run([{ call: "slow" }, { say: "done" }], { live: { tickMs: 100 } });
  await w.tools.slowStarted;
  // While the tool runs, before pi stores its running status: the start is on the stream from the held row.
  await until(() => got.events().some((event) => event.type === "tool_execution_start" && event.toolName === "slow"), "the slow tool's start, held");
  const held = await w.server.live.read([RUN]);
  assert.equal(held.length, 1, "the run's run_live row holds its running tool");
  w.tools.letSlowGo();
  await w.ended("ended");
  await until(() => settled(got.types()), "the run's end on the stream");
  const slow = got.events().filter((event) => event.toolName === "slow").map((event) => event.type);
  assert.equal(slow.filter((type) => type === "tool_execution_start").length, 1, `one start for the slow tool: ${JSON.stringify(slow)}`);
  assert.ok(slow.indexOf("tool_execution_start") < slow.indexOf("tool_execution_end"), `its start, then its end: ${JSON.stringify(slow)}`);
});

test("a run's run_live row is gone once it ends, and the stream shows nothing held after its run_end", async (t) => {
  const w = await liveWorld(t);
  const stream = await watchRun(w.server, RUN, { pollMs: 20 });
  t.after(() => stream.stop());
  const got = collect(stream);
  await w.run([{ call: "slow" }, { say: "done" }], { live: { tickMs: 100 } });
  await w.tools.slowStarted;
  await until(async () => (await w.server.live.read([RUN])).length === 1, "the held row while the tool runs");
  w.tools.letSlowGo();
  await w.ended("ended");
  await until(() => settled(got.types()), "the run's end on the stream");
  assert.deepEqual(await w.server.live.read([RUN]), [], "no run_live row after the run's end");
  const types = got.types();
  const end = types.lastIndexOf("run_end");
  assert.deepEqual(types.slice(end + 1).filter((type) => type.startsWith("tool_execution") || type === "message_update"), [], `nothing held after run_end: ${JSON.stringify(types)}`);
});
