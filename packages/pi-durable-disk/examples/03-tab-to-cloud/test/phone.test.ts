// Pi on a phone (?phone=1): the parts that are not the browser. The native template rendered here is llama-server's own, byte for byte (fixtures from
// llama-server's /apply-template on D1's v3 fine-tune); the lock is D1's grammar, rule for rule (fixtures/robot-v3-lock.json, D1's build_gbnf); the robot's
// tools run on a workspace with no computer (files-env.ts); a turn can end on its tools' own words (decoding.closing); the warm-up stops exactly at the user's
// turn, and a saved state is restored only for the model and the prefix it was made for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { agentRegistry, rootAgent } from "../agent.ts";
import { BRAIN_PROVIDER, brainModel, brainProvider, DEFAULT_TOOL_DECODING, type BrainModel } from "../tab/brain-provider.ts";
import { FilesEnv, memoryFs } from "../tab/files-env.ts";
import { lockedToolChat, lockGrammar, parseNative, renderNative } from "../tab/native-tools.ts";
import { nativeExchanges, servingView, toNativeTools } from "../tab/native-turn.ts";
import { stateLine } from "../robot-state-line.ts";
import { applyRobotTool, initialRobot, type Design } from "../robot-model.ts";
import { buildOrder, PhoneModel } from "../tab/phone-model.ts";
import { ROBOT_FILE } from "../robot-tools.ts";
import { parseRobot } from "../robot-model.ts";
import type { Llm, RawRequest, ToolChatMessage, ToolChatRequest, ToolChatTool } from "../../04-walks-home/tab/src/modelhost.ts";

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const serving = JSON.parse(readFileSync(fixture("robot-v3-serving.json"), "utf8")) as { system: string; tools: ToolChatTool[] };
const template = (JSON.parse(readFileSync(fixture("qwen35-robot-v3.template.json"), "utf8")) as { template: string }).template;
const rendered = JSON.parse(readFileSync(fixture("robot-v3-rendered.json"), "utf8")) as { messages: ToolChatMessage[]; prompt: string }[];

test("the model's template renders the conversation exactly as llama-server does: a request, two calls and their results, a chat turn before a call", () => {
  for (const [i, c] of rendered.entries()) assert.equal(renderNative(template, c.messages, serving.tools, { enable_thinking: false }), c.prompt, `case ${i}`);
});

test("the lock is D1's whole-schema grammar for the v3 tools, rule for rule", () => {
  assert.equal(lockGrammar(serving.tools).trim(), (JSON.parse(readFileSync(fixture("robot-v3-lock.json"), "utf8")) as { grammar: string }).grammar.trim());
});

test("a reply in Qwen's call format comes back as calls with arguments typed by the schema; the text around them is the answer", () => {
  const two = "<tool_call>\n<function=morph>\n<parameter=preset>\nspider\n</parameter>\n</function>\n</tool_call>\n<tool_call>\n<function=scale>\n<parameter=factor>\n1.5\n</parameter>\n</function>\n</tool_call>";
  assert.deepEqual(parseNative(two, serving.tools), { calls: [{ name: "morph", arguments: { preset: "spider" } }, { name: "scale", arguments: { factor: 1.5 } }], text: "", unfinished: false });
  assert.deepEqual(parseNative("<tool_call>\n<function=set_legs>\n<parameter=pairs>\n3\n</parameter>\n</function>\n</tool_call>", serving.tools).calls, [{ name: "set_legs", arguments: { pairs: 3 } }], "an integer enum is a number");
  assert.deepEqual(parseNative("<tool_call>\n<function=rename>\n<parameter=name>\n42\n</parameter>\n</function>\n</tool_call>", serving.tools).calls, [{ name: "rename", arguments: { name: "42" } }], "a string that looks like a number stays a string");
  assert.deepEqual(parseNative("I am fine, thanks.", serving.tools), { calls: [], text: "I am fine, thanks.", unfinished: false });
});

test("a locked tool chat: the rendered prompt and the grammar go to the raw completion; with no tools there is no grammar", async () => {
  const seen: RawRequest[] = [];
  const chat = lockedToolChat({ template: () => template, complete: async (req) => { seen.push(req); return { text: "<tool_call>\n<function=reset>\n</function>\n</tool_call>", stoppedBy: "eog", promptTokens: 12, outputTokens: 9, ms: 1 }; } });
  const r = await chat({ messages: rendered[0]!.messages, tools: serving.tools, maxTokens: 300, templateKwargs: { enable_thinking: false } });
  assert.equal(seen[0]!.prompt, rendered[0]!.prompt);
  assert.equal(seen[0]!.grammar, lockGrammar(serving.tools));
  assert.equal(seen[0]!.maxTokens, 300);
  assert.deepEqual(r.toolCalls.map((c) => [c.name, JSON.parse(c.arguments)]), [["reset", {}]]);
  assert.equal(r.stoppedBy, "tool_calls");
  await chat({ messages: rendered[0]!.messages, tools: [], maxTokens: 50 });
  assert.equal(seen[1]!.grammar, undefined);
});

test("the model's view is the serving file's tools, verbatim, in its order, those the conversation offers; nothing else", () => {
  const registry = agentRegistry(async () => undefined, { switchTool: false, environments: [] });
  const offered = toNativeTools(registry.snapshot().tools().map((r) => r.tool)).reverse(); // the registry's own text, in another order, update_robot and the coding tools included
  const view = servingView(offered, serving.tools);
  assert.deepEqual(view, serving.tools, "D1's ten tools, D1's text, D1's order");
  assert.ok(!view.some((t) => t.function.name === "update_robot"), "a tool the model was never scored on is not shown");
  assert.deepEqual(servingView(offered.filter((t) => t.function.name !== "do"), serving.tools).map((t) => t.function.name), serving.tools.map((t) => t.function.name).filter((n) => n !== "do"), "a serving tool the conversation does not offer is not shown");
  assert.deepEqual(servingView(offered, undefined), offered, "no serving file: the conversation's own");
});

test("the files env: paths stay under the root, a write makes its directories, there is no shell", async () => {
  const env = new FilesEnv(memoryFs("/workspace"));
  assert.ok((await env.writeFile("creature/robot.json", "{}", ctx)).ok);
  assert.deepEqual(await env.readTextFile("/workspace/creature/robot.json", ctx), { ok: true, value: "{}" });
  const out = await env.readTextFile("../etc/passwd", ctx);
  assert.equal(out.ok ? "read" : out.error.code, "permission_denied");
  const missing = await env.readTextFile("home/skills.json", ctx);
  assert.equal(missing.ok ? "read" : missing.error.code, "not_found");
  const run = await env.exec("ls", undefined, ctx);
  assert.equal(run.ok ? "ran" : run.error.code, "shell_unavailable");
});

/** A Harness on a files env with the robot's tools, its conversation on a model whose tool chat is scripted; what the model was asked is kept. */
async function phoneConversation(closing: "model" | "tool-result") {
  const fs = memoryFs("/workspace");
  const env = new FilesEnv(fs);
  const registry = agentRegistry(async () => undefined, { switchTool: false, environments: [] });
  const models = createModels();
  const requests: ToolChatRequest[] = [];
  const brain: BrainModel = {
    generate: () => Promise.reject(new Error("not used")),
    withBackend: () => Promise.reject(new Error("not used")),
    historyMode: () => "none",
    state: () => ({ sampling: { max_tokens: 300 }, size_bytes: null }),
    async toolChat(req) {
      requests.push(req);
      if (req.messages.at(-1)!.role === "user") return { text: "", toolCalls: [{ id: "c1", name: "set_color", arguments: '{"color":"red","part":"all"}' }], stoppedBy: "tool_calls", promptTokens: 12, outputTokens: 37, ms: 1 };
      return { text: "It is red now, and spinning.", toolCalls: [], stoppedBy: "stop", promptTokens: 34, outputTokens: 8, ms: 1 };
    },
  };
  models.setProvider(brainProvider(brain, brainModel("robot-v3", "robot", 2048, 200), { ...DEFAULT_TOOL_DECODING, mode: "native", callTokens: 200, answerTokens: 100, system: serving.system, refine: (list) => servingView(list, serving.tools), closing }));
  const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => env }, ctx);
  const root = await harness.root(ctx, { agent: rootAgent("robot-v3") });
  const tools = serving.tools.map((s) => registry.snapshot().tools().find((r) => r.tool.name === s.function.name)!.tool);
  await root.configure({ model: { provider: BRAIN_PROVIDER, modelId: "robot-v3" }, thinkingLevel: "off", tools, instructions: serving.system }, ctx);
  await (await root.submit({ type: "input", content: "paint it red" }, ctx)).wait(ctx);
  const entries = [...(await root.entries({}, 100, undefined, ctx)).items].reverse() as unknown as { model?: { role: string; content?: { type: string; text?: string }[] }[] }[];
  const last = entries.map((e) => e.model?.[0]).filter((m) => m?.role === "assistant").at(-1)!;
  const robot = parseRobot(new TextDecoder().decode(await fs.readFile(`/workspace/${ROBOT_FILE}`)))!;
  await harness.close(ctx);
  return { requests, reply: (last.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join(""), robot };
}

test("closing on the tool's result: one model turn, the tool's own words are the reply, the robot's file changed on the files env", async () => {
  const { requests, reply, robot } = await phoneConversation("tool-result");
  assert.equal(requests.length, 1, "no second model turn after the call");
  assert.match(reply, /^The whole robot is now red\./, "the reply is set_color's own result");
  assert.doesNotMatch(reply, /spinning/);
  assert.equal(robot.look.torso, "red");
  assert.equal(requests[0]!.messages[0]!.content, serving.system, "the model's system message is the serving file's");
  assert.deepEqual(requests[0]!.tools, serving.tools, "the model sees the serving file's tools, in its order");
});

test("closing by the model (the default): the model speaks after its calls", async () => {
  const { requests, reply } = await phoneConversation("model");
  assert.equal(requests.length, 2);
  assert.equal(reply, "It is red now, and spinning.");
});

/** A model backend that records what the phone model asks of it. */
function fakeLlm(o: { restore?: (b: Blob) => Promise<{ tokens: number; bytes: number }> } = {}) {
  const calls: { complete: RawRequest[]; restored: number; loads: { parts?: unknown }[] } = { complete: [], restored: 0, loads: [] };
  const llm: Llm = {
    async load() {},
    async chat() { return { text: "", tokens: 0 }; },
    async loadUrl(_url, opts) { calls.loads.push({ parts: opts.parts }); opts.onProgress?.(501453056, 501453056); },
    chatTemplate: () => template,
    async complete(req) { calls.complete.push(req); return { text: "", stoppedBy: "length", promptTokens: 1255, outputTokens: 0, ms: 1 }; },
    ...(o.restore ? { restoreState: async (b: Blob) => { calls.restored++; return o.restore!(b); } } : {}),
    async exit() {},
  };
  return { llm, calls };
}

const PREFIX = rendered[0]!.prompt.slice(0, rendered[0]!.prompt.indexOf("<|im_start|>user\n")); // the system turn, through its <|im_end|>\n
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function withFetch<T>(files: Record<string, string | Uint8Array>, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL) => { const body = files[String(u)]; return body === undefined ? new Response("missing", { status: 404 }) : new Response(body as BodyInit); }) as typeof fetch;
  try { return await run(); } finally { globalThis.fetch = real; }
}

test("the warm-up reads the prefix every turn shares, the system turn, and generates nothing", async () => {
  const { llm, calls } = fakeLlm();
  const model = new PhoneModel(llm, { url: "https://p.example/m/robot-v3-00001-of-00007.gguf", threads: 2, nCtx: 2048, batch: 64, maxTokens: 300 });
  const warm = await model.warm(serving.system, serving.tools);
  assert.equal(calls.complete.length, 1);
  assert.equal(calls.complete[0]!.prompt, PREFIX, "llama-server's own rendering of the system turn");
  assert.ok(PREFIX.endsWith("<|im_end|>\n") && rendered.every((c) => c.prompt.startsWith(PREFIX)), "every turn's prompt starts with it, whatever follows");
  assert.equal(calls.complete[0]!.maxTokens, 0);
  assert.equal(warm.restored, undefined);
});

test("a saved state is restored only for the model and the prefix it was made for; anything else prefills", async () => {
  const url = "https://p.example/m/robot-v3-00001-of-00007.gguf", state = "https://p.example/m/robot-v3.state.bin";
  const shas = ["a".repeat(64), "b".repeat(64)];
  const manifest = JSON.stringify({ parts: shas.map((sha256, i) => ({ name: `robot-v3-0000${i + 1}-of-00007.gguf`, bytes: 1, sha256 })) });
  const side = async (over: object = {}) => JSON.stringify({ model: { first: "robot-v3-00001-of-00007.gguf", bytes: 501453056, parts: shas }, prefixSha256: await sha(PREFIX), ...over });
  const run = async (sidecar: string, parts: string | null = manifest) => {
    const { llm, calls } = fakeLlm({ restore: async (b) => ({ tokens: 1255, bytes: b.size }) });
    const model = new PhoneModel(llm, { url, threads: 2, nCtx: 2048, batch: 64, maxTokens: 300 });
    const skipped: string[] = [];
    const warm = await withFetch({ [`${state}.json`]: sidecar, [state]: new Uint8Array(64), ...(parts ? { "https://p.example/m/robot-v3.parts.json": parts } : {}) }, async () => { await model.load(); return model.warm(serving.system, serving.tools, { url: state, onSkip: (why) => skipped.push(why) }); });
    return { warm, calls, skipped };
  };
  const ok = await run(await side());
  assert.equal(ok.calls.restored, 1);
  assert.equal(ok.calls.complete.length, 0, "restored: nothing prefilled");
  assert.equal(ok.warm.restored?.tokens, 1255);
  const otherWeights = await run(await side({ model: { first: "robot-v3-00001-of-00007.gguf", bytes: 501453056, parts: [shas[0], "c".repeat(64)] } }));
  assert.equal(otherWeights.calls.restored, 0, "the same name and size, other weights (a fine-tune replaced in place)");
  assert.match(otherWeights.skipped[0]!, /other weights/);
  const unnamed = await run(await side({ model: { first: "robot-v3-00001-of-00007.gguf", bytes: 501453056 } }));
  assert.equal(unnamed.calls.restored, 0, "a sidecar that names no part hashes cannot be matched");
  assert.match(unnamed.skipped[0]!, /names no part hashes/);
  const unchecked = await run(await side(), null);
  assert.equal(unchecked.calls.restored, 0, "no manifest to match the weights with");
  assert.match(unchecked.skipped[0]!, /no parts manifest/);
  const otherModel = await run(await side({ model: { first: "robot-v1-00001-of-00007.gguf", bytes: 501453056, parts: shas } }));
  assert.equal(otherModel.calls.restored, 0);
  assert.match(otherModel.skipped[0]!, /another model/);
  assert.equal(otherModel.calls.complete[0]!.prompt, PREFIX, "prefilled instead");
  const otherPrefix = await run(await side({ prefixSha256: "0".repeat(64) }));
  assert.equal(otherPrefix.calls.restored, 0);
  assert.match(otherPrefix.skipped[0]!, /another prefix/);
  const otherBytes = await run(await side({ model: { first: "robot-v3-00001-of-00007.gguf", bytes: 1, parts: shas } }));
  assert.equal(otherBytes.calls.restored, 0, "the same name with other bytes is another model");
});

test("a turn's report carries its time, tokens and tools; the reply's words only when the page was opened to send them (?report=text)", async () => {
  const { turnReport } = await import("../tab/phone-model.ts");
  const t = { at: 0, ms: 900, promptTokens: 65, outputTokens: 7, grammar: true, calls: [], text: "Your address is on the robot now.", raw: "Your address is on the robot now.", prompt: "", timings: { prompt_n: 65 } };
  const plain = turnReport(t, false);
  assert.deepEqual(plain, { ms: 900, promptNew: 65, promptTotal: 65, out: 7, calls: [] });
  assert.doesNotMatch(JSON.stringify(plain), /address/, "nothing of the conversation leaves the phone");
  assert.equal(turnReport(t, true).text, "Your address is on the robot now.");
  assert.deepEqual(turnReport({ ...t, calls: ['set_color({"part":"all"})'] }, false).calls, ["set_color"], "tool names, not their arguments");
});

test("both windows read the robot before every turn, so the lock knows the skills home; only the exchanges window shows the state line", async () => {
  const { phoneWindow } = await import("../tab/phone-model.ts");
  let reads = 0;
  const refresh = async () => { reads++; return `[Robot now: ${reads}]`; };
  const task = phoneWindow(true, { refresh, fits: () => true }) as Record<string, unknown>;
  await (task.prepare as () => Promise<void>)();
  assert.equal(reads, 1, "?window=task still reads the robot (and its skills home) before a turn");
  assert.equal(task.window, undefined);
  assert.equal(task.stateLine, undefined, "the task window shows no state line");
  const exchanges = phoneWindow(false, { refresh, fits: () => true });
  await exchanges.prepare();
  assert.equal(exchanges.window, "exchanges");
  assert.equal((exchanges as { stateLine: () => string }).stateLine(), "[Robot now: 2]");
});

test("a saved workspace that cannot be read is an error, never an empty one; only none saved starts empty", async () => {
  const { loadWorkspace } = await import("../tab/workspace-store.ts");
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  const had = Object.getOwnPropertyDescriptor(nav, "storage");
  const named = (name: string) => Object.assign(new Error(name), { name });
  const dir = (entries: [string, unknown][]) => ({ kind: "directory", getDirectoryHandle: async () => dir([]), entries: async function* () { yield* entries; } });
  const file = (read: () => Promise<ArrayBuffer>) => ({ kind: "file", getFile: async () => ({ lastModified: 1, arrayBuffer: read }) });
  const root = (work: unknown) => ({ getDirectoryHandle: async () => ({ getDirectoryHandle: async () => { if (work instanceof Error) throw work; return work; } }) });
  const use = (r: unknown) => Object.defineProperty(nav, "storage", { configurable: true, value: { getDirectory: async () => r } });
  try {
    use(root(named("NotFoundError")));
    assert.deepEqual(await loadWorkspace("phone"), [], "none saved: a new session");
    use(root(dir([["robot.json", file(async () => new TextEncoder().encode("{}").buffer as ArrayBuffer)]])));
    assert.equal((await loadWorkspace("phone")).length, 1);
    use(root(dir([["robot.json", file(async () => { throw named("NotReadableError"); })]])));
    await assert.rejects(loadWorkspace("phone"), /NotReadableError/, "a saved robot that cannot be read stops the start");
    use(root(named("SecurityError")));
    await assert.rejects(loadWorkspace("phone"), /SecurityError/, "storage refused is not an empty workspace");
  } finally {
    if (had) Object.defineProperty(nav, "storage", had); else delete nav.storage;
  }
});

test("a build is found by a GET (the 03 server answers HEAD 405, the offline worker serves GETs only), its body let go", async () => {
  const { served } = await import("../tab/phone-model.ts");
  let cancelled = 0;
  const server = (async (_u: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") !== "GET") return new Response(null, { status: 405 });
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 200 });
  }) as typeof fetch;
  assert.equal(await served("/vendor/wllama-jspi32/wllama.wasm", server), true);
  assert.equal(cancelled, 1, "the body is not read");
  assert.equal(await served("/x", (async () => new Response("no", { status: 404 })) as typeof fetch), false);
  assert.equal(await served("/x", (async () => { throw new TypeError("offline"); }) as typeof fetch), false);
});

test("a turn cancelled while it waits for the one before it reaches no model", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { llm, calls } = fakeLlm();
  const complete = llm.complete!;
  llm.complete = async (req, o) => { if (calls.complete.length === 0) await gate; return complete(req, o); };
  const model = new PhoneModel(llm, { url: "https://p.example/m/robot-v3-00001-of-00007.gguf", threads: 2, nCtx: 2048, batch: 64, maxTokens: 300 });
  const ask = (signal?: AbortSignal) => model.toolChat({ messages: rendered[0]!.messages, tools: serving.tools, maxTokens: 50 }, signal);
  const first = ask();
  const cancel = new AbortController();
  const second = ask(cancel.signal);
  cancel.abort(); // while the first turn holds the engine
  release();
  await first;
  const r = await second;
  assert.equal(calls.complete.length, 1, "only the first turn reached the engine");
  assert.deepEqual(r.toolCalls, []);
});

test("a turn that cannot resume where the engine is starts from the warm state again, read from the engine's cache; the next call of a turn resumes", async () => {
  const url = "https://p.example/m/robot-v3-00001-of-00007.gguf", state = "https://p.example/m/robot-v3.state.bin";
  let refuse = false;
  const { llm, calls } = fakeLlm({ restore: async (b) => { if (refuse) throw new Error("the restore returned nothing"); return { tokens: 1252, bytes: b.size }; } });
  const opened: string[] = [];
  llm.cachedFile = async (u, want) => { opened.push(`${u} ${want?.bytes} ${want?.sha256}`); return new Blob([new Uint8Array(64)]); };
  const model = new PhoneModel(llm, { url, threads: 2, nCtx: 2048, batch: 64, maxTokens: 300 });
  const parts = JSON.stringify({ parts: [{ name: "robot-v3-00001-of-00007.gguf", bytes: 1, sha256: "a".repeat(64) }] });
  const sidecar = JSON.stringify({ model: { first: "robot-v3-00001-of-00007.gguf", bytes: 501453056, parts: ["a".repeat(64)] }, prefixSha256: await sha(PREFIX), bytes: 64, sha256: "c".repeat(64) });
  await withFetch({ [`${state}.json`]: sidecar, "https://p.example/m/robot-v3.parts.json": parts }, async () => { await model.load(); await model.warm(serving.system, serving.tools, { url: state }); }); // the state itself would be a 404: it comes from the engine's cache
  assert.equal(calls.restored, 1);
  assert.deepEqual(opened, [`${state} 64 ${"c".repeat(64)}`], "checked against the sidecar's bytes and sha256");

  const sys = { role: "system", content: serving.system };
  const call = { role: "assistant", content: "", tool_calls: [{ id: "c0", type: "function", function: { name: "set_color", arguments: '{"part": "all", "color": "yellow"}' } }] };
  const result = { role: "tool", tool_call_id: "c0", content: "The whole robot is now yellow." };
  const ask = (messages: object[]) => model.toolChat({ messages: messages as ToolChatMessage[], tools: serving.tools, maxTokens: 50 });
  const first = [sys, { role: "assistant", content: "[Robot now: A]" }, { role: "user", content: "paint it yellow" }];
  await ask(first);
  await ask([...first, call, result]);
  assert.equal(calls.restored, 1, "the first turn starts where the warm-up left the engine, and the turn's next call keeps everything before the reply");
  await ask([sys, { role: "user", content: "paint it yellow" }, call, result, { role: "assistant", content: "Done." }, { role: "assistant", content: "[Robot now: B]" }, { role: "user", content: "what color is it?" }]);
  assert.equal(calls.restored, 2, "the next turn: its window put the last exchange where the state line was");
  assert.ok("ms" in model.turns.at(-1)!.rewarm!, "the turn says it started from the warm state");
  await ask([sys, { role: "assistant", content: "[Robot now: B]" }, { role: "user", content: "hi" }]);
  assert.equal(calls.restored, 3, "a new chat, or a window that dropped its oldest exchange");
  assert.equal(opened.length, 3, "each restore read from the engine's cache");
  refuse = true;
  const before = calls.complete.length;
  await ask([sys, { role: "assistant", content: "[Robot now: C]" }, { role: "user", content: "spin" }]);
  assert.equal(calls.complete.length, before + 1, "a restore that fails does not stop the turn");
  assert.deepEqual(model.turns.at(-1)!.rewarm, { failed: "the restore returned nothing" });
});

test("a window is kept while its prompt fits 1648 tokens, the window counted at the measured 3.9 characters a token after the system turn", async () => {
  const { llm } = fakeLlm(); // the warm-up counts the system turn as 1255 tokens: 393 are left for the window
  const model = new PhoneModel(llm, { url: "https://p.example/m/robot-v3-00001-of-00007.gguf", threads: 2, nCtx: 2048, batch: 64, maxTokens: 300 });
  await model.warm(serving.system, serving.tools);
  const sys = { role: "system" as const, content: serving.system };
  const empty = renderNative(template, [sys, { role: "user", content: "" }], serving.tools, { enable_thinking: false }).length - PREFIX.length;
  const window = (chars: number) => [sys, { role: "user" as const, content: "a".repeat(chars - empty) }];
  assert.equal(model.fits(window(1400), serving.tools), true, "1400 characters, about 330 tokens at the fewest measured: kept (at 3 characters a token it was cut)");
  assert.equal(model.fits(window(1532), serving.tools), true, "the most that fits: 1255 + ceil(1532 / 3.9) = 1648");
  assert.equal(model.fits(window(1533), serving.tools), false);
});

test("the phone model passes the parts' manifest to the load, and the tools as the provider sends them", async () => {
  const { llm, calls } = fakeLlm();
  const model = new PhoneModel(llm, { url: "https://p.example/m/robot-v3-00001-of-00007.gguf", threads: 2, nCtx: 2048, batch: 64, maxTokens: 300 });
  const parts = [{ name: "robot-v3-00001-of-00007.gguf", bytes: 10, sha256: "a".repeat(64) }];
  await withFetch({ "https://p.example/m/robot-v3.parts.json": JSON.stringify({ parts }) }, () => model.load());
  assert.deepEqual(calls.loads[0]!.parts, parts);
  assert.deepEqual(toNativeTools(serving.tools.map((t) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters }))), serving.tools, "the registry's view of the serving tools converts back to them");
});

test("the state line is D1's, byte for byte: a renamed angry spider painted black, three skills home", () => {
  const drawn: Design = { version: 1, name: "quadruped", legDof: 3, torso: { length: 0.5, width: 0.22, height: 0.1 }, legs: [{ x: 0.8, thigh: 0.2, shin: 0.2, radius: 0.02 }, { x: -0.8, thigh: 0.2, shin: 0.2, radius: 0.02 }] };
  let r = initialRobot(drawn);
  for (const [tool, args] of [["morph", { preset: "spider" }], ["set_color", { part: "all", color: "black" }], ["set_shape", { part: "torso", shape: "round" }], ["set_shape", { part: "legs", shape: "round" }], ["set_face", { face: "angry" }], ["rename", { name: "Rex" }]] as const) {
    const out = applyRobotTool(r, tool, args as Record<string, unknown>, { skills: {} });
    assert.ok(out.state, `${tool}: ${out.text}`);
    r = out.state!;
  }
  assert.equal(stateLine(r, ["wave", "walk", "spin"]), "[Robot now: named Rex; body spider, changed since drawn; 6 legs; colors torso black, legs black; shapes torso round, legs round; face angry; doing walk; skills home: walk, spin, wave.]", "D1's literal example");
  assert.match(stateLine(r, ["walk", "spin"], "spin"), /doing spin; skills home: walk, spin\.\]$/, "with skills home, the default the page plays is what it does");
  assert.match(stateLine(initialRobot(drawn), [], "walk"), /^\[Robot now: named quadruped; body as drawn; 4 legs; colors torso default, legs default; .*doing nothing; skills home: none yet\.\]$/, "nothing home: doing nothing");
});

test("doing names the skill the pane plays: the manifest's default, else its first skill; walk for a lone policy; nothing with none home", async () => {
  const { defaultSkill, loadSkills } = await import("../robot-tools.ts");
  const drawn: Design = { version: 1, name: "quadruped", legDof: 3, torso: { length: 0.5, width: 0.22, height: 0.1 }, legs: [{ x: 0.8, thigh: 0.2, shin: 0.2, radius: 0.02 }, { x: -0.8, thigh: 0.2, shin: 0.2, radius: 0.02 }] };
  const skill = (name: string) => ({ policy: `skills/${name}.json`, command: 0 });
  const doing = async (files: Record<string, string>) => {
    const env = new FilesEnv(memoryFs("/workspace"));
    for (const [path, text] of Object.entries(files)) assert.ok((await env.writeFile(path, text, ctx)).ok);
    const home = Object.keys(await loadSkills(env as never, ctx));
    return /doing ([^;]+);/.exec(stateLine(initialRobot(drawn), home, await defaultSkill(env as never, ctx)))![1];
  };
  const manifest = (m: Record<string, unknown>) => ({ "home/skills.json": JSON.stringify({ version: 1, body_mjcf_sha256: "0".repeat(64), ...m }) });
  assert.equal(await doing(manifest({ default: "spin", skills: { walk: skill("walk"), spin: skill("spin") } })), "spin", "the manifest's default");
  assert.equal(await doing(manifest({ skills: { wave: skill("wave"), walk: skill("walk") } })), "wave", "no default named: its first skill, as parseSkills plays it");
  assert.equal(await doing(manifest({ default: "sprint", skills: { spin: skill("spin"), walk: skill("walk") } })), "spin", "a default it does not list: its first skill");
  assert.equal(await doing({ "home/policy.json": "{}" }), "walk", "one policy home: walk");
  assert.equal(await doing({}), "nothing", "nothing home");
});

test("the exchanges window: earlier exchanges in the model's format, the state line as the assistant's message, then the user; the oldest dropped first", () => {
  const p = BRAIN_PROVIDER;
  const call = (id: string, name: string, args: object) => ({ role: "assistant", provider: p, content: [{ type: "toolCall", id, name, arguments: args }] });
  const result = (id: string, text: string) => ({ role: "toolResult", toolCallId: id, toolName: "x", content: [{ type: "text", text }] });
  const reply = (text: string) => ({ role: "assistant", provider: p, content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text }] });
  const user = (text: string) => ({ role: "user", content: text });
  const transcript = [
    { role: "system", content: "", toolsAdded: serving.tools.map((t) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })) },
    user("Ok paint it yellow"), call("h0_0", "set_color", { part: "all", color: "yellow" }), result("h0_0", "The whole robot is now yellow. Looks only: the walking brain still fits."), reply("Done! It's yellow now."),
    user("now make it a spider"), call("h1_0", "morph", { preset: "spider" }), result("h1_0", "The robot is now a spider. This changes the body: the walking brain no longer fits, so the robot will stumble until it is retrained."), reply("Done! It's a spider now."),
    user("What color is the robot now?"),
  ];
  const line = "[Robot now: named Rex; body spider, changed since drawn; 6 legs; colors torso black, legs black; shapes torso round, legs round; face angry; doing nothing; skills home: walk, spin, wave.]";
  const all = nativeExchanges(transcript, { provider: p, mode: "none", system: serving.system, stateLine: line });
  assert.deepEqual(all.messages.map((m) => m.role), ["system", "user", "assistant", "tool", "assistant", "user", "assistant", "tool", "assistant", "assistant", "user"], "D1's literal example, message for message");
  assert.deepEqual(all.messages[2], { role: "assistant", content: "", tool_calls: [{ id: "h0_0", type: "function", function: { name: "set_color", arguments: '{"part":"all","color":"yellow"}' } }] });
  assert.deepEqual(all.messages[4], { role: "assistant", content: "Done! It's yellow now." }, "the final reply, thinking left out");
  assert.deepEqual(all.messages[9], { role: "assistant", content: line });
  assert.equal(all.steps, 0);
  const rendered = renderNative(template, all.messages, serving.tools, { enable_thinking: false });
  assert.ok(rendered.startsWith(PREFIX), "the warm prefix still leads");
  let calls = 0;
  const two = nativeExchanges(transcript, { provider: p, mode: "none", system: serving.system, stateLine: line, fits: (m) => { calls++; return m.filter((x) => x.role === "user").length <= 2; } });
  assert.deepEqual(two.messages.filter((m) => m.role === "user").map((m) => m.content), ["now make it a spider", "What color is the robot now?"], "the oldest exchange dropped, whole");
  assert.equal(two.dropped, 1);
  assert.ok(calls >= 2);
});

test("a reply cut inside a call runs nothing: reset with no closing tags is not a reset", async () => {
  const cut = "<tool_call>\n<function=morph>\n<parameter=preset>\ndog\n</parameter>\n</function>\n</tool_call>\n<tool_call>\n<function=reset>\n";
  const parsed = parseNative(cut, serving.tools);
  assert.equal(parsed.unfinished, true);
  assert.deepEqual(parsed.calls.map((c) => c.name), ["morph"], "the finished call is read, the cut one is not");
  const chat = lockedToolChat({ template: () => template, complete: async () => ({ text: cut, stoppedBy: "length", promptTokens: 12, outputTokens: 300, ms: 1 }) });
  const r = await chat({ messages: rendered[0]!.messages, tools: serving.tools, maxTokens: 300 });
  assert.deepEqual(r.toolCalls, [], "a cut reply runs none of its calls");
  assert.equal(r.stoppedBy, "length");
});

test("a parts manifest the server will not give (404, 503, offline) is taken from the copy kept by an earlier load; with none, the load says the parts go unchecked", async () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  try {
    const url = "https://p.example/m/robot-v3-00001-of-00007.gguf", manifest = "https://p.example/m/robot-v3.parts.json";
    const parts = [{ name: "robot-v3-00001-of-00007.gguf", bytes: 10, sha256: "a".repeat(64) }];
    const first = fakeLlm();
    await withFetch({ [manifest]: JSON.stringify({ parts }) }, () => new PhoneModel(first.llm, { url, threads: 2, nCtx: 2048, batch: 64, maxTokens: 300 }).load());
    const later = fakeLlm(), said: string[] = [];
    await withFetch({}, () => new PhoneModel(later.llm, { url, threads: 2, nCtx: 2048, batch: 64, maxTokens: 300, onStatus: (t) => said.push(t) }).load()); // the server answers 404
    assert.deepEqual(later.calls.loads[0]!.parts, parts, "the kept copy, on a 404");
    assert.deepEqual(said, []);
    store.clear();
    const none = fakeLlm(), told: string[] = [];
    await withFetch({}, () => new PhoneModel(none.llm, { url, threads: 2, nCtx: 2048, batch: 64, maxTokens: 300, onStatus: (t) => told.push(t) }).load());
    assert.equal(none.calls.loads[0]!.parts, undefined);
    assert.match(told[0]!, /no parts manifest/);
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test("the phone's files go into the offline cache under their paths; one is kept only at the server's version, never by its length alone", async () => {
  const { cacheFilesForOffline } = await import("../tab/offline.ts");
  type Kept = { body: string; headers: Record<string, string> };
  const put = new Map<string, Kept>();
  const g = globalThis as unknown as { caches?: unknown; location?: unknown };
  const before = { caches: g.caches, location: g.location };
  g.location = { origin: "https://p.example" };
  g.caches = { open: async () => ({ match: async (k: string) => (put.has(k) ? new Response(put.get(k)!.body, { headers: put.get(k)!.headers }) : undefined), put: async (k: string, r: Response) => void put.set(k, { body: await r.text(), headers: Object.fromEntries(r.headers) }) }) };
  const sent = (body: string, headers: Record<string, string> = {}): Kept => ({ body, headers: { "content-length": String(body.length), ...headers } });
  try {
    const was: Record<string, Kept> = {
      "/models/robot.parts.json": sent("old-same"), // an edit of the same size, from a server with no validators
      "/models/robot.state.bin": sent("cached!!", { etag: '"a"' }),
      "/main.js": sent("js-1", { etag: '"a"' }),
      "/models/robot.serving.json": sent("served-1", { "last-modified": "Mon, 12 Oct 2026 05:00:00 GMT" }),
    };
    for (const [path, kept] of Object.entries(was)) put.set(`https://p.example${path}`, kept);
    const files: Record<string, Kept> = {
      "/": sent("<html>"),
      "/models/robot.parts.json": sent("new-same"),
      "/models/robot.state.bin": sent("server!!", { etag: '"a"' }),
      "/main.js": sent("js-2", { etag: '"b"' }),
      "/models/robot.serving.json": sent("served-2", { "last-modified": "Mon, 12 Oct 2026 05:00:00 GMT" }),
    };
    const fetched: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: string) => { fetched.push(String(u)); return new Response(files[String(u)]!.body, { headers: files[String(u)]!.headers }); }) as typeof fetch;
    try {
      const saved = await cacheFilesForOffline(Object.keys(files));
      assert.equal(saved.files, 5);
    } finally { globalThis.fetch = real; }
    const body = (path: string) => put.get(`https://p.example${path}`)!.body;
    assert.equal(body("/"), "<html>");
    assert.equal(body("/models/robot.parts.json"), "new-same", "the same length and no validator: saved again");
    assert.equal(body("/main.js"), "js-2", "another ETag: saved again");
    assert.equal(body("/models/robot.state.bin"), "cached!!", "the same ETag: kept, not written again");
    assert.equal(body("/models/robot.serving.json"), "served-1", "the same Last-Modified and length: kept");
    assert.deepEqual(fetched, Object.keys(files));
  } finally {
    g.caches = before.caches;
    g.location = before.location;
  }
});

test("D1's lock rule: the prompt shows do with every skill, the grammar only the skills home, and no do at all when none is", async () => {
  const { narrowEnum } = await import("../tab/native-turn.ts");
  const seen: RawRequest[] = [];
  const run = async (home: string[]) => {
    const chat = lockedToolChat({ template: () => template, complete: async (req) => { seen.push(req); return { text: "Hi.", stoppedBy: "eog", promptTokens: 1, outputTokens: 1, ms: 1 }; } }, undefined,
      (shown) => shown.flatMap((t) => (t.function.name !== "do" ? [t] : home.length > 0 ? narrowEnum([t], "skill", home) : [])));
    await chat({ messages: rendered[0]!.messages, tools: serving.tools, maxTokens: 50 });
    return seen.at(-1)!;
  };
  const none = await run([]);
  assert.equal(none.prompt, rendered[0]!.prompt, "the prompt is unchanged: the warm state holds");
  assert.doesNotMatch(none.grammar!, /function=do>/, "no skill home: do is not in the grammar");
  const two = await run(["walk", "spin"]);
  assert.equal(two.prompt, rendered[0]!.prompt);
  assert.match(two.grammar!, /do-skill ::= "walk" \| "spin"/);
  assert.doesNotMatch(two.grammar!, /"sprint"/);
});

test("the build order: the shim's jspi32 first wherever JSPI is there and served, since only the shim restores the warm state; never the stock build on WebKit", () => {
  assert.deepEqual(buildOrder({ webkit: false, jspi: true, jspi32Served: true }), ["jspi32", "default", "asyncify"], "Chrome, desktop and Android");
  assert.deepEqual(buildOrder({ webkit: false, jspi: true, jspi32Served: false }), ["default", "asyncify"], "a page without the shim's jspi32");
  assert.deepEqual(buildOrder({ webkit: true, jspi: true, jspi32Served: true }), ["jspi32", "asyncify"], "Safari 27");
  assert.deepEqual(buildOrder({ webkit: true, jspi: false, jspi32Served: true }), ["asyncify"], "Safari 26");
  assert.deepEqual(buildOrder({ webkit: false, jspi: false, jspi32Served: true }), ["default", "asyncify"], "no JSPI (Firefox): wllama's own check takes the stock build to its compat path");
  assert.deepEqual(buildOrder({ webkit: false, jspi: true, jspi32Served: true, noMemory64: true }), ["jspi32", "asyncify"], "?mem64=0");
  assert.deepEqual(buildOrder({ webkit: true, jspi: true, jspi32Served: true, only: "default" }), ["default"], "?build= tries that one");
});

// ---- v5 (D1, 2026-10-12): a signature prefix. The serving file has no tools: its system text lists each tool on one line, and nothing renders a tools block.
const servingV5 = JSON.parse(readFileSync(fixture("robot-v5-serving.json"), "utf8")) as { system: string; tools?: ToolChatTool[] };
const renderedV5 = JSON.parse(readFileSync(fixture("robot-v5-rendered.json"), "utf8")) as { messages: ToolChatMessage[]; prompt: string }[];

test("v5: the prompt renders with no tools block, exactly as llama-server renders it; the grammar still holds the tools", async () => {
  assert.equal(servingV5.tools, undefined, "D1's v5 serving file has no tools");
  const seen: RawRequest[] = [];
  const chat = lockedToolChat({ template: () => template, complete: async (req) => { seen.push(req); return { text: "Hi.", stoppedBy: "eog", promptTokens: 1, outputTokens: 1, ms: 1 }; }, bare: () => true });
  for (const c of renderedV5) {
    await chat({ messages: c.messages, tools: serving.tools, maxTokens: 50 });
    assert.equal(seen.at(-1)!.prompt, c.prompt, "llama-server's /apply-template with no tools, byte for byte");
    assert.match(seen.at(-1)!.grammar!, /function=set_color>/, "the lock is over the tools the request carries");
  }
});

test("v5: the warm-up's prefix is the system turn with no tools block, the one the shipped state was made from (its sidecar's prefix sha256)", async () => {
  const { llm } = fakeLlm();
  const model = new PhoneModel(llm, { url: "https://p.example/m/robot-v5-00001-of-00007.gguf", threads: 2, nCtx: 2048, batch: 64, maxTokens: 300 });
  model.toolsInPrompt = false;
  await model.warm(servingV5.system, serving.tools);
  assert.ok(renderedV5.every((c) => c.prompt.startsWith(model.warmPrompt!)), "every v5 turn starts with it");
  assert.equal(await sha(model.warmPrompt!), "ee79e1a42ea1216928fa6fab3cde80628f008d09b20be75af5b7e0accfecab1e", "make-state.mjs's prefix sha256 for v5, from llama-server's rendering");
});

test("v5: the tools are the ones its system text lists, in its order; over the registry's own schemas they build D1's v5-lock.gbnf exactly", async () => {
  const { signatureTools, signatureView } = await import("../tab/native-turn.ts");
  const names = signatureTools(servingV5.system);
  assert.deepEqual(names, ["set_color", "set_shape", "set_face", "rename", "resize", "scale", "set_legs", "morph", "reset", "do"]);
  const registry = agentRegistry(async () => undefined, { switchTool: false, environments: [] });
  const offered = toNativeTools(registry.snapshot().tools().map((r) => ({ name: r.tool.name, description: r.tool.description, parameters: r.tool.parameters })));
  const shown = signatureView(offered, names);
  assert.deepEqual(shown.map((t) => t.function.name), names, "the conversation's tools the prefix names, nothing else (no update_robot, no shell)");
  assert.equal(lockGrammar(shown), readFileSync(fixture("robot-v5-lock.gbnf"), "utf8"), "D1's v5 lock, byte for byte");
});

test("a T7 turn reads its earlier exchanges on their own first, so the next turn (one exchange more) resumes there: no restore, no system turn read again", async () => {
  const url = "https://p.example/m/robot-v3-00001-of-00007.gguf", state = "https://p.example/m/robot-v3.state.bin";
  const { llm, calls } = fakeLlm({ restore: async (b) => ({ tokens: 1252, bytes: b.size }) });
  llm.cachedFile = async () => new Blob([new Uint8Array(64)]);
  const model = new PhoneModel(llm, { url, threads: 2, nCtx: 2048, batch: 64, maxTokens: 300 });
  model.stemFirst = true;
  const parts = JSON.stringify({ parts: [{ name: "robot-v3-00001-of-00007.gguf", bytes: 1, sha256: "a".repeat(64) }] });
  const sidecar = JSON.stringify({ model: { first: "robot-v3-00001-of-00007.gguf", bytes: 501453056, parts: ["a".repeat(64)] }, prefixSha256: await sha(PREFIX), bytes: 64 });
  await withFetch({ [`${state}.json`]: sidecar, "https://p.example/m/robot-v3.parts.json": parts }, async () => { await model.load(); await model.warm(serving.system, serving.tools, { url: state }); });
  const sys = { role: "system", content: serving.system };
  const exchange = (n: number) => [{ role: "user", content: `paint it color ${n}` }, { role: "assistant", content: "", tool_calls: [{ id: `c${n}`, type: "function", function: { name: "set_color", arguments: '{"part": "all", "color": "red"}' } }] }, { role: "tool", tool_call_id: `c${n}`, content: "The whole robot is now red." }, { role: "assistant", content: "Done." }];
  const turn = (n: number) => [sys, ...Array.from({ length: n }, (_, i) => exchange(i)).flat(), { role: "assistant", content: `[Robot now: ${n}]` }, { role: "user", content: `command ${n}` }];
  const ask = (messages: object[]) => model.toolChat({ messages: messages as ToolChatMessage[], tools: serving.tools, maxTokens: 50 });
  await ask(turn(1));
  const stem1 = calls.complete.at(-2)!;
  assert.equal(stem1.maxTokens, 0, "the earlier exchanges are read on their own, generating nothing");
  assert.ok(calls.complete.at(-1)!.prompt.startsWith(stem1.prompt) && stem1.prompt.endsWith("<|im_end|>\n"), "the turn's prompt continues it");
  assert.doesNotMatch(stem1.prompt, /Robot now/, "it stops before the state line, where the next turn's prompt will differ");
  await ask(turn(2));
  await ask(turn(3));
  assert.equal(calls.restored, 1, "only the warm-up's restore: each turn starts with the last one's earlier exchanges");
  assert.equal(model.turns.at(-1)!.rewarm, undefined);
  assert.ok(model.turns.at(-1)!.stem, "the turn says it read its exchanges first");
  await ask([sys, ...exchange(1), { role: "assistant", content: "[Robot now: 9]" }, { role: "user", content: "command 9" }]); // the oldest exchange dropped
  assert.equal(calls.restored, 2, "a window that dropped its oldest exchange starts from the warm state");
});
