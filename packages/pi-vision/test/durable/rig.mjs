// The adapter's integration rig: a real pi-durable Harness on SQLite with pi-ai's faux models, pi's own coding tools
// and Node environment, and the extension under test. The adapter's calls into the core (`readMedia`, `guardResult`,
// `pdfText`) reach the test's own functions on `globalThis.visionCore` (see core-stub.mjs): `loadDurable()` registers
// the redirect before the adapter is first imported. Helpers, not tests.
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const STUB = new URL("./core-stub.mjs", import.meta.url).href;
const CORE = new Set(["./core/read.js", "./core/guard.js", "./core/pdf.js"]);
let redirected = false;

/** The adapter, with its core calls redirected to the test's functions. */
export async function loadDurable() {
  if (!redirected) {
    registerHooks({ resolve: (specifier, context, next) => (CORE.has(specifier) && context.parentURL?.endsWith("/dist/durable.js") ? { url: STUB, shortCircuit: true } : next(specifier, context)) });
    redirected = true;
  }
  return import("@parcha/pi-vision/durable");
}

/** The version of pi-durable this run resolved. */
export const piDurableVersion = () => {
  for (let dir = path.dirname(new URL(import.meta.resolve("@earendil-works/pi-durable")).pathname); dir !== "/"; dir = path.dirname(dir)) {
    const file = path.join(dir, "package.json");
    if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).name === "@earendil-works/pi-durable") return JSON.parse(fs.readFileSync(file, "utf8")).version;
  }
  throw new Error("pi-durable not found");
};

export const tmp = (prefix = "vision-durable-") => fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), prefix));

/** The lead model, which takes images and declares an image limit; a second catalog entry that sees, for the eyes; and
 *  a lead that takes text only, whose images the eyes look at. */
export const MODELS = [
  { id: "lead-1", input: ["text", "image"], inputLimits: { images: { resize: { maxWidth: 1000, maxHeight: 1000, maxBytes: 1_000_000 } } } },
  { id: "eyes-1", input: ["text", "image"], reasoning: true, cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } },
  { id: "blind-1", input: ["text"] },
];

/** A Harness whose lead makes `rounds` of tool calls (each an array of [tool, args]) and then answers. The policy reads
 *  the transcript, never a counter, so a process that resumes the same file continues where it was cut. `eyes` answers
 *  every request to the eyes model and sees its context. `env` builds each call's environment (pi's own over `cwd`
 *  when absent); `lead` names the lead's model. */
export async function open({ extensions, rounds, cwd, db = path.join(tmp(), "run.sqlite"), eyes = () => "seen", onReport, env = () => new NodeExecutionEnv({ cwd }), lead: leadModel = "lead-1" }) {
  const faux = fauxProvider({ models: MODELS });
  const lead = (context) => {
    const round = rounds[context.messages.filter((m) => m.role === "assistant").length];
    return round ? fauxAssistantMessage(round.map(([tool, args]) => fauxToolCall(tool, args)), { stopReason: "toolUse" }) : fauxAssistantMessage([fauxText("done")], { stopReason: "stop" });
  };
  const reply = (context, options, state, model) => (model.id === "eyes-1" ? fauxAssistantMessage([fauxText(eyes(context, options))]) : lead(context));
  faux.setResponses(Array.from({ length: 64 }, () => reply));
  const models = createModels(); models.setProvider(faux.provider);
  const registry = createRegistry();
  for (const extension of [CodingTools, ...extensions]) registry.install(extension);
  const harness = await Harness.open(await openNodeSqliteStorage(db), { models, registry, env, ...(onReport ? { onReport } : {}) }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: leadModel } } });
  return { harness, root, db, models };
}

/** What the conversation's tool results hold, in the order the model made the calls. */
export async function transcript(root) {
  const entries = [...(await root.entries({}, 200, undefined, ctx)).items].reverse();
  const order = new Map();
  for (const e of entries) for (const block of e.kind === "pi.assistant" ? e.model?.[0]?.content ?? [] : []) if (block.type === "toolCall") order.set(block.id, order.size);
  return entries.flatMap((e) => {
    const m = e.model?.[0];
    return e.kind === "pi.tool-result" ? [{ order: order.get(m.toolCallId) ?? Infinity, tool: m.toolName, isError: m.isError, content: m.content, details: m.details ?? null, usage: m.usage ?? null }] : [];
  }).sort((a, b) => a.order - b.order).map(({ order: _order, ...result }) => result);
}

/** Run one conversation to its answer: every tool result, the session's usage and the settled status. */
export async function drive(options) {
  const { harness, root } = await open(options);
  try {
    const settled = await (await root.submit({ type: "input", content: "go", requestId: "go-1" }, ctx)).wait(ctx);
    return { results: await transcript(root), usage: await harness.usage(ctx), settled: settled.status };
  } finally { await harness.close(ctx); }
}

export const textOf = (result) => result.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
export { ctx };
