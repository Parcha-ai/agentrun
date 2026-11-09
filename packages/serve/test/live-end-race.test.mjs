// A run's live view never ends before the commit that ended the run reached it. A CLI run (here the reference loop,
// which writes a CLI run's entries) has no input submission, so its stream ends on the run's row reading final; its answer
// and its "ended" are one commit. When a poll's drain of commits read the journal before that commit landed and the
// row is read after it, the row says ended while the drain never saw the answer: the stream must still give the answer
// before it ends. Made certain here, not left to timing: the stream's first read of commits after it starts returns
// only once the run's row is final, with what the journal held when it was asked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { referenceSubject } from "./conformance-reference.mjs";
import { collect, liveWorld, RUN, shape, until } from "./live-support.mjs";

const { watchRun } = await import("../dist/live/stream.js");
const FINAL = ["ended", "failed", "stopped"];

/** `server` with its journals' first commitsAfter after `arm()` held, its page read at once, until the run is final. */
function heldFirstRead(server) {
  let armed = false;
  let held = false;
  const journal = (claim) => {
    const inner = server.journal(claim);
    return new Proxy(inner, {
      get(target, key) {
        if (key === "commitsAfter") {
          return async (...args) => {
            const page = await target.commitsAfter(...args);
            if (armed && !held) {
              held = true;
              await until(async () => FINAL.includes((await server.runs.get(RUN)).state), "the run final while the read is held");
            }
            return page;
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return { store: { runs: server.runs, live: server.live, journal }, arm: () => (armed = true), held: () => held };
}

test("a CLI run's live view gives its answer before it ends, though the row read final after a drain that missed the end commit", async (t) => {
  const w = await liveWorld(t);
  const view = heldFirstRead(w.server);
  const stream = await watchRun(view.store, RUN, { pollMs: 20 });
  t.after(() => stream.stop());
  view.arm();
  const got = collect(stream);
  await w.run([{ call: "read" }, { say: "done" }], { subject: referenceSubject });
  await w.ended("ended");
  const end = await Promise.race([stream.closed, new Promise((resolve) => setTimeout(() => resolve({ reason: "still open" }), 10_000))]);
  assert.equal(view.held(), true, "the first read was held until the run was final");
  assert.equal(end.reason, "ended", `the stream ended on the run's end: ${JSON.stringify(shape(got.events()))}`);
  const answered = got.events().some((event) => event.type === "message_end" && JSON.stringify(event.entry?.model ?? event.message ?? "").includes("done"));
  assert.ok(answered, `the answer streamed before the end: ${JSON.stringify(shape(got.events()))}`);
});
