// A child of otel-genai.test.mjs: one whole run on the adapter loop with no OTEL_* in its env, every module it resolves
// watched (module.registerHooks). It prints, as its last line, how the run ended and every @opentelemetry module the run
// resolved (none, as tracing is off), then the ones tracing resolves once it is on (the probe's own check).
import { registerHooks } from "node:module";

const loaded = [];
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@opentelemetry/")) loaded.push(specifier);
    return next(specifier, context);
  },
});

const { queue, stores, until } = await import("../runner-support.mjs");
const { startRunner } = await import("../../dist/runner/runner.js");
const { createAdapterLoop } = await import("../../dist/runner/adapter-loop.js");
const { genAiTracing } = await import("../../dist/otel/tracer.js");

/** A CLI stand-in whose one turn makes one model request and ends. */
const oneRequest = {
  id: "stand-in-cli",
  check: () => [],
  async open(_spec, io) {
    let turn;
    return {
      state: "new",
      async send() {
        this.state = "idle";
        turn = (async () => {
          const ticket = await io.models.beforeRequest({ model: "m" });
          await io.models.afterRequest({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, usd: 0 }, ticket || undefined, { end: "answered", usd: 0 });
          io.onEvent({ type: "turn_end", status: "completed" });
          return { status: "completed" };
        })();
      },
      async recover() {},
      async settleOpenTurn() {},
      turnEnd: () => turn,
      async interrupt() {},
      async close() {},
    };
  },
};

const opened = await stores({ runners: 1 });
await queue(opened.server, "run-1");
const createLoop = createAdapterLoop(() => ({
  adapter: oneRequest,
  session: { key: "root", label: "root", system: [], tools: [], context: "fresh" },
  input: "Answer.",
  runCap: { capUsd: () => undefined, modelOf: () => undefined },
  record: "loop",
  hooks: { beforeIntent: async () => {}, beforeResult: async () => {} },
  gate: () => "allow",
  trace: { provider: "anthropic", model: "m" },
}));
const runner = startRunner({ store: opened.runners[0], createLoop, name: "runner-a", leaseMs: 60_000, renewEveryMs: 10_000, stopMarginMs: 200, pollMs: 20, commandPollMs: 30 });
const row = await until(async () => {
  const now = await opened.server.runs.get("run-1");
  return (now.state === "ended" || now.state === "failed") && now.runner === null && now;
}, "the run ended and released", 30_000);
await runner.close();
const off = [...loaded];
const { InMemorySpanExporter } = await import("@opentelemetry/sdk-trace");
await genAiTracing({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://otlp.invalid:4318" }, { exporter: new InMemorySpanExporter() });
console.log(JSON.stringify({ state: row.state, loaded: off, loadedOn: [...new Set(loaded.slice(off.length))] }));
process.exit(0);
