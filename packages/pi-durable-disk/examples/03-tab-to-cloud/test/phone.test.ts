// Pi on a phone (?phone=1): the parts that are not the browser. The native template rendered here is llama-server's own, byte for byte (fixtures from
// llama-server's /apply-template on D1's v3 fine-tune); the lock is D1's grammar, rule for rule (fixtures/robot-v3-lock.gbnf, D1's build_gbnf); the robot's
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
import { PhoneModel } from "../tab/phone-model.ts";
import { ROBOT_FILE } from "../robot-tools.ts";
import { parseRobot } from "../robot-model.ts";
import type { Llm, RawRequest, ToolChatMessage, ToolChatRequest, ToolChatTool } from "../../04-walks-home/tab/src/modelhost.ts";

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const serving = JSON.parse(readFileSync(fixture("robot-v3-serving.json"), "utf8")) as { system: string; tools: ToolChatTool[] };
const template = readFileSync(fixture("qwen35-robot-v3.jinja"), "utf8");
const rendered = JSON.parse(readFileSync(fixture("robot-v3-rendered.json"), "utf8")) as { messages: ToolChatMessage[]; prompt: string }[];

test("the model's template renders the conversation exactly as llama-server does: a request, two calls and their results, a chat turn before a call", () => {
  for (const [i, c] of rendered.entries()) assert.equal(renderNative(template, c.messages, serving.tools, { enable_thinking: false }), c.prompt, `case ${i}`);
});

test("the lock is D1's whole-schema grammar for the v3 tools, rule for rule", () => {
  assert.equal(lockGrammar(serving.tools).trim(), readFileSync(fixture("robot-v3-lock.gbnf"), "utf8").trim());
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
  const side = async (over: object = {}) => JSON.stringify({ model: { first: "robot-v3-00001-of-00007.gguf", bytes: 501453056 }, prefixSha256: await sha(PREFIX), ...over });
  const run = async (sidecar: string) => {
    const { llm, calls } = fakeLlm({ restore: async (b) => ({ tokens: 1255, bytes: b.size }) });
    const model = new PhoneModel(llm, { url, threads: 2, nCtx: 2048, batch: 64, maxTokens: 300 });
    const skipped: string[] = [];
    const warm = await withFetch({ [`${state}.json`]: sidecar, [state]: new Uint8Array(64) }, async () => { await model.load(); return model.warm(serving.system, serving.tools, { url: state, onSkip: (why) => skipped.push(why) }); });
    return { warm, calls, skipped };
  };
  const ok = await run(await side());
  assert.equal(ok.calls.restored, 1);
  assert.equal(ok.calls.complete.length, 0, "restored: nothing prefilled");
  assert.equal(ok.warm.restored?.tokens, 1255);
  const otherModel = await run(await side({ model: { first: "robot-v1-00001-of-00007.gguf", bytes: 501453056 } }));
  assert.equal(otherModel.calls.restored, 0);
  assert.match(otherModel.skipped[0]!, /another model/);
  assert.equal(otherModel.calls.complete[0]!.prompt, PREFIX, "prefilled instead");
  const otherPrefix = await run(await side({ prefixSha256: "0".repeat(64) }));
  assert.equal(otherPrefix.calls.restored, 0);
  assert.match(otherPrefix.skipped[0]!, /another prefix/);
  const otherBytes = await run(await side({ model: { first: "robot-v3-00001-of-00007.gguf", bytes: 1 } }));
  assert.equal(otherBytes.calls.restored, 0, "the same name with other bytes is another model");
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
  assert.equal(stateLine(r, ["wave", "walk", "spin"]), "[Robot now: named Rex; body spider, changed since drawn; 6 legs; colors torso black, legs black; shapes torso round, legs round; face angry; doing nothing; skills home: walk, spin, wave.]", "D1's literal example (no default named: doing nothing)");
  assert.match(stateLine(r, ["walk"], "walk"), /doing walk; skills home: walk\.\]$/, "with skills home, the manifest's default is what it does");
  assert.match(stateLine(initialRobot(drawn), [], "walk"), /^\[Robot now: named quadruped; body as drawn; 4 legs; colors torso default, legs default; .*doing nothing; skills home: none yet\.\]$/, "nothing home: doing nothing");
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

test("the phone's files go into the offline cache under their paths; one already there at the same length is kept", async () => {
  const { cacheFilesForOffline } = await import("../tab/offline.ts");
  const put = new Map<string, string>();
  const g = globalThis as unknown as { caches?: unknown; location?: unknown };
  const before = { caches: g.caches, location: g.location };
  g.location = { origin: "https://p.example" };
  g.caches = { open: async () => ({ match: async (k: string) => (put.has(k) ? new Response(put.get(k), { headers: { "content-length": String(put.get(k)!.length) } }) : undefined), put: async (k: string, r: Response) => void put.set(k, await r.text()) }) };
  try {
    put.set("https://p.example/models/robot.parts.json", "old-same");
    const files = { "/": "<html>", "/main.js": "js", "/models/robot.parts.json": "new-same" };
    const fetched: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: string) => { fetched.push(String(u)); return new Response(files[String(u) as keyof typeof files], { headers: { "content-length": String(files[String(u) as keyof typeof files].length) } }); }) as typeof fetch;
    try {
      const saved = await cacheFilesForOffline(Object.keys(files));
      assert.equal(saved.files, 3);
    } finally { globalThis.fetch = real; }
    assert.equal(put.get("https://p.example/"), "<html>");
    assert.equal(put.get("https://p.example/main.js"), "js");
    assert.equal(put.get("https://p.example/models/robot.parts.json"), "old-same", "the same length: kept, not written again");
    assert.deepEqual(fetched, ["/", "/main.js", "/models/robot.parts.json"]);
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
