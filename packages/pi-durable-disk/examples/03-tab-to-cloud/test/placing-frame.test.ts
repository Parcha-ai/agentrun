// A page that sent a line is told where it is: the server says it is asking Jev (`placing`) before the question goes out, and its decision names the line it was for. A page that only
// watches learns the run's model from the server, so the header can name it.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PLACEMENT_QUESTIONS, type Placer, type PlacementDecision } from "../placement.ts";
import type { CloudHost } from "../pipe/server.ts";
import { PipeClient } from "../tab/pipe-client.ts";
import type { PipeFrame } from "../wire.ts";
import { localServer } from "./_local.ts";

describe("a sent line is told where it is", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  const placer: Placer = {
    describe: (env) => `criterion of ${env}`,
    async decide(query) {
      await new Promise((r) => setTimeout(r, 100));
      const decision: PlacementDecision = { id: "d-1", phase: query.phase, question: PLACEMENT_QUESTIONS[query.phase], options: query.environments.map((id) => ({ id, label: id, probability: id === "vm" ? 0.9 : 0.1 })), choice: "vm", latency_ms: 100, model: "jev", decidedBy: "jev" } as PlacementDecision;
      return decision;
    },
  };
  const moves: { by?: string; phase?: string }[] = [];
  const cloud: CloudHost = { environments: [{ id: "vm", label: "A VM", phrase: "a VM", kind: "cloud" }], start: async (_ref, run) => { moves.push(run.move); return { host: "vm-1" }; }, stop: async () => undefined, attachViewer: async () => () => undefined, submit: async () => undefined };
  before(async () => { local = await localServer({ cloud, placer, drainMs: 5_000, superviseMs: 60_000 }); });
  after(async () => { await local.remove(); });

  it("says it is deciding, then names the line in the decision; a viewer is told the model", async () => {
    const { id, secret } = await local.server.createRun("placing");
    const tab: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", onFrame: (f) => f.t === "drain" && tab.send({ t: "drained", switchId: f.switchId }) });
    await tab.ready;
    const seen: PipeFrame[] = [];
    const page: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "operator", canRun: true, onFrame: (f) => seen.push(f) });
    const first = await page.ready;
    assert.equal(first.t, "viewing");
    assert.equal(first.t === "viewing" ? first.model : undefined, "stub", "the run's model, for a page that only watches");
    page.send({ t: "submit", text: "open a browser", requestId: "r1" });
    for (const end = Date.now() + 10_000; !seen.some((f) => f.t === "decision"); await new Promise((r) => setTimeout(r, 25))) if (Date.now() > end) throw new Error("no decision");
    const kinds = seen.map((f) => f.t);
    assert.ok(kinds.indexOf("placing") >= 0 && kinds.indexOf("placing") < kinds.indexOf("decision"), `placing before decision: ${kinds.join(",")}`);
    assert.deepEqual(seen.find((f) => f.t === "placing"), { t: "placing", requestId: "r1" });
    const decision = seen.find((f) => f.t === "decision") as Extract<PipeFrame, { t: "decision" }>;
    assert.equal(decision.requestId, "r1");
    for (const end = Date.now() + 10_000; moves.length === 0; await new Promise((r) => setTimeout(r, 25))) if (Date.now() > end) throw new Error("no move");
    assert.deepEqual([moves[0]!.by, moves[0]!.phase], ["placement", "start"], "the move says it was placed for a message (the chat reads its notice after that message)");
    tab.close();
    page.close();
  });
});
