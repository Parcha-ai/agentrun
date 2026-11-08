// What the live view's tests share: a store in a data directory of its own with one queued run, a runner running pi
// loops (runner/loop.ts) whose faux model plays a script, and the run's stream from the store (live/stream.ts, watchRun),
// collected batch by batch.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTool, Harness, hook, MemoryStorage, ToolTask } from "@earendil-works/pi-durable";
import { watchEvents } from "@parcha/pi-durable-disk/internals";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { suiteTools } from "../dist/runner/conformance/harness.js";
import { piSpec, scriptedModel } from "./conformance-pi.mjs";

/** The input a B run's loop sends (conformance-pi's piSpec) and its request id (runner/loop.ts). */
export const INPUT = "Follow the script.";

/** The door's stream for `script` (what serve reads today): pi-durable-disk's watchEvents on a Harness that runs the
 *  script with the suite's read tool, attached before the input is sent, until the run ended and the input settled. */
export async function doorStream(script, options = {}) {
  const { models, model } = scriptedModel(script);
  const read = defineTool({
    name: "read", description: "The suite's read tool.", parameters: { type: "object", properties: {} }, replay: "safe",
    execute: async () => ({ output: [{ type: "text", text: "read" }] }),
  });
  // `options.deny`: the gate refuses every call before its intent (pi's beforeTool block), so none runs.
  const hooks = options.deny ? [hook(ToolTask, { beforeTool: async (call) => ({ block: `Permission denied: ${call.name} is set to deny.` }) })] : [];
  const kernel = defineExtension({ name: "agentrun-kernel", tools: [read], hooks });
  const registry = createRegistry();
  registry.install(kernel);
  const harness = await Harness.open(new MemoryStorage(), { models, registry, onReport: () => {} }, ctx);
  try {
    const root = await harness.root(ctx, { agent: { model, extensions: [kernel] } });
    const stream = await watchEvents(harness, root.id, ctx);
    const got = collect(stream);
    const input = await root.submit({ type: "input", content: INPUT, requestId: "agentrun:input" }, ctx);
    await input.wait(ctx);
    await harness.waitForIdle(ctx);
    await until(() => settled(got.types()), "the door's run_end and the input's settlement");
    await stream.stop();
    return { snapshot: stream.snapshot, events: got.events() };
  } finally {
    await harness.close(ctx);
  }
}

/** A stream's run is over: run_end, and the input's settlement (its second submission event). */
export const settled = (types) => types.includes("run_end") && types.filter((type) => type === "submission").length >= 2;

export const RUN = "run-1";
const TIMING = { leaseMs: 600, renewEveryMs: 150, stopMarginMs: 200, pollMs: 20, commandPollMs: 30 };
export const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(check, what, ms = 15_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`not within ${ms} ms: ${what}`);
    await sleep(10);
  }
}

/** A store with one queued run; `run(script)` starts a runner whose pi loops play `script`. */
export async function liveWorld(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-live-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Live" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" });
  const tools = suiteTools();
  const run = async (script, options = {}) => {
    const store = await openSqliteStore({ dataDir: dir, role: "runner" });
    const { createPiLoop } = await import("../dist/runner/loop.js");
    // `options.subject`: a conformance subject's loops instead of pi's (the reference loop writes a CLI run's entries).
    const setup = { script, tools: tools.tools, hooks: options.hooks ?? quiet };
    // `options.deny`: the loop's gate refuses every call (none runs).
    const spec = options.deny ? (claim) => ({ ...piSpec(setup)(claim), gate: () => "deny" }) : piSpec(setup);
    const inner = options.subject ? options.subject.createLoop(setup) : createPiLoop(spec);
    // `options.journal` wraps the run's journal as the loop sees it (a slow store that makes pi group its commits).
    const wrapped = (deps) => inner(options.journal ? { ...deps, journal: (claim) => options.journal(deps.journal(claim)) } : deps);
    // `options.live`: the runner's held states go to run_live, one store write per tick for all its loops.
    let createLoop = wrapped;
    if (options.live) {
      const { withLiveTicker } = await import("../dist/runner/live-ticker.js");
      const ticker = withLiveTicker(store, wrapped, options.live);
      createLoop = ticker.createLoop;
      closers.push(() => ticker.close());
    }
    const runner = startRunner({ store, createLoop, name: "runner-a", ...TIMING });
    closers.push(async () => {
      await runner.close();
      await store.close().catch(() => {});
    });
    return runner;
  };
  const row = async () => (await server.runs.get(RUN));
  const ended = (state = "ended") => until(async () => {
    const now = await row();
    return now.state === state && now.runner === null && now;
  }, `the run ${state} and released`);
  return { dir, server, run, row, ended, tools };
}

/** Starts `stream` and collects its batches until it closes or `until(events)` holds. */
export function collect(stream) {
  const batches = [];
  stream.start(async (batch) => void batches.push(batch));
  return {
    batches,
    events: () => batches.flat(),
    types: () => batches.flat().map((event) => event.type),
  };
}

/** The events' types with the role of each message event, as `type:role` (message_start:assistant). */
export function shape(events) {
  return events.map((event) => {
    const role = event.message?.role ?? event.entry?.model?.[0]?.role;
    return role ? `${event.type}:${role}` : event.type;
  });
}
