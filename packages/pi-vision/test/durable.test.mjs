// The pi-durable adapter through a real Harness on SQLite: pi's own `read` wrapped, the guard on every tool's result,
// the eyes a call is given, its memos, and the functions a host whose `read` is its own calls. The core behind the
// adapter is the test's (rig.mjs `loadDurable`), so each case states what the core answers and checks what the adapter
// did with it and passed to it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ToolTask } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { READ_MEDIA_ARGUMENTS, READ_MEDIA_DESCRIPTION, resolveLimits } from "@parcha/pi-vision";
import { fakeEyes, pngBytes } from "@parcha/pi-vision/testing";
import { drive, loadDurable, piDurableVersion, textOf, tmp, toolResult } from "./durable/rig.mjs";

const { callContext, createVisionExtension, packageProviders, piResult } = await loadDurable();

const MiB = 1024 * 1024;
const onModels = piDurableVersion() !== "1.0.4";
const usage = (usd) => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: usd, output: 0, cacheRead: 0, cacheWrite: 0, total: usd } });
const evidence = { file: async () => null };
const scope = (id) => ({ label: `conv-${id}`, deriveDir: `.vision/${id}` });
const workspace = (files = {}) => {
  const dir = tmp();
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
};
const piRead = CodingTools.tools.find((tool) => tool.name === "read");

test("the extension wraps read with the media arguments and declares it replay-safe, guards every tool, and offers no tool yet", () => {
  const { extension, tools } = createVisionExtension({ evidence, scope });
  assert.equal(extension.name, "vision");
  assert.deepEqual([extension.tools, tools], [[], []]);
  assert.deepEqual(extension.wraps.map((wrap) => wrap.tool), ["read"]);
  const wrapped = extension.wraps[0].wrap(piRead);
  assert.equal(wrapped.name, "read");
  assert.equal(wrapped.description, piRead.description + READ_MEDIA_DESCRIPTION);
  assert.deepEqual(Object.keys(wrapped.parameters.properties), [...Object.keys(piRead.parameters.properties), ...READ_MEDIA_ARGUMENTS]);
  assert.deepEqual([piRead.replay, wrapped.replay], [undefined, "safe"], "pi's read is unsafe by default; both halves of the wrapped one only read");
  assert.deepEqual(extension.hooks.map((hook) => hook.task), [ToolTask.definition.name], "the guard hooks pi's built-in tool task");
  const off = createVisionExtension({ evidence, scope, name: "eyes", install: { read: "off", guard: false } }).extension;
  assert.deepEqual([off.name, off.wraps, off.hooks], ["eyes", [], []]);
});

test("a media read is the core's result, priced once under read; the core gets pi's env, the route's limits, the scope, the eyes and a memo", async () => {
  const cwd = workspace({ "scan.png": pngBytes(4, 4) });
  const seen = [];
  globalThis.visionCore = {
    readMedia: async (env, args, call, setup) => {
      seen.push({ env, args, call, setup });
      return { content: [{ type: "text", text: "a scan" }, { type: "image", data: "AAAA", mimeType: "image/png" }], details: { sha256: "ab" }, usage: usage(0.01) };
    },
    guardResult: async (result) => result,
  };
  const eyes = fakeEyes();
  const host = { requestBytes: 8 * MiB };
  const { extension } = createVisionExtension({ eyes, evidence, scope, limits: () => host });
  const run = await drive({ extensions: [extension], rounds: [[["read", { path: "scan.png", ask: "what does it say?" }]]], cwd });
  assert.equal(run.settled, "done");
  const [result] = run.results;
  assert.deepEqual([result.isError, result.content, result.details], [false, [{ type: "text", text: "a scan" }, { type: "image", data: "AAAA", mimeType: "image/png" }], { sha256: "ab" }]);
  assert.equal(run.usage.tools.read.cost.total, 0.01);
  const [{ env, args, call, setup }] = seen;
  assert.deepEqual(args, { path: "scan.png", ask: "what does it say?" });
  assert.equal(env.cwd, cwd);
  assert.equal((await env.readBinaryFile("scan.png", { abortSignal: undefined, value: () => undefined })).ok, true, "pi's own environment passes as the port");
  assert.equal(typeof call.conversationId, "string");
  assert.equal(typeof call.memo, "function");
  assert.ok(call.signal instanceof AbortSignal);
  if (onModels) assert.deepEqual([call.model.id, call.model.inputLimits.images.resize.maxWidth], ["lead-1", 1000], "on pi 1.1 the lead is the catalog's entry, with its limits");
  else assert.deepEqual(call.model, { provider: "faux", modelId: "lead-1" }, "on pi 1.0 tools see no catalog: the reference the agent names");
  assert.deepEqual(setup.limits, resolveLimits(call.model, host));
  assert.equal(setup.limits.image.maxWidth, onModels ? 1000 : 2000);
  assert.deepEqual(setup.scope, scope(call.conversationId));
  assert.equal(setup.eyes, eyes);
  assert.equal(setup.evidence, evidence);
  assert.deepEqual([setup.providers.map((p) => p.name), setup.sources], [packageProviders().map((p) => p.name), {}], "with none of the host's, the package's own");
  assert.equal(setup.images?.name, "photon", "with no processor of the host's, Photon, which this process can load");
});

test("a host's image processor is used as it is given, in place of Photon", async () => {
  const cwd = workspace({ "a.png": pngBytes(2, 2) });
  const seen = [];
  globalThis.visionCore = { readMedia: async (env, args, call, setup) => { seen.push(setup.images); return { content: [{ type: "text", text: "ok" }] }; } };
  const own = { prepare: async () => undefined };
  const { extension } = createVisionExtension({ evidence, scope, images: own });
  await drive({ extensions: [extension], rounds: [[["read", { path: "a.png" }]]], cwd });
  assert.deepEqual(seen, [own]);
});

test("a route that fills in every argument reaches the core: page 0, which the schema refuses, is dropped before validation", async () => {
  const cwd = workspace({ "doc.pdf": "%PDF-1.4" });
  const seen = [];
  globalThis.visionCore = { readMedia: async (env, args) => { seen.push(args); return { content: [{ type: "text", text: "read" }] }; } };
  const { extension } = createVisionExtension({ evidence, scope });
  const filled = { path: "doc.pdf", offset: 0, limit: 0, char_offset: 0, ask: "", from_s: 0, to_s: 0, page: 0 };
  const run = await drive({ extensions: [extension], rounds: [[["read", filled], ["read", { path: "doc.pdf", page: 3 }]]], cwd });
  assert.deepEqual(run.results.map((r) => [r.isError, textOf(r)]), [[false, "read"], [false, "read"]]);
  const { page: _zero, ...rest } = filled;
  assert.deepEqual(seen, [rest, { path: "doc.pdf", page: 3 }]);
});

test("a path the core leaves to text is read by the wrapped read, arguments and all", async () => {
  const cwd = workspace({ "notes.txt": "first line\nsecond line\n" });
  globalThis.visionCore = { readMedia: async () => null };
  const { extension } = createVisionExtension({ evidence, scope });
  const run = await drive({ extensions: [extension], rounds: [[["read", { path: "notes.txt", offset: 2 }]]], cwd });
  assert.equal(run.results[0].isError, false);
  assert.match(textOf(run.results[0]), /second line/);
  assert.doesNotMatch(textOf(run.results[0]), /first line/);
  assert.equal(run.usage.tools.read, undefined, "a text read costs nothing");
});

test("the guard fits the images of every tool's result before it is committed, keeps its diagnostics, and skips results without images", async () => {
  const cwd = workspace();
  const tool = (name, content) => ({ name, description: name, parameters: { type: "object", properties: {} }, execute: async () => toolResult(content, { diagnostics: [{ severity: "info", message: `${name} ran` }] }) });
  const host = { name: "host", tools: [tool("snap", [{ type: "image", data: "BIGBIG", mimeType: "image/png" }]), tool("note", [{ type: "text", text: "plain" }])] };
  const guarded = [];
  globalThis.visionCore = {
    guardResult: async (result, call, setup) => {
      guarded.push({ result, call, setup });
      return { ...result, content: [{ type: "text", text: `fitted to ${setup.limits.image.maxWidth}` }, { type: "image", data: "SMALL", mimeType: "image/jpeg" }] };
    },
  };
  const { extension } = createVisionExtension({ evidence, scope, install: { read: "off" } });
  const run = await drive({ extensions: [host, extension], rounds: [[["snap", {}], ["note", {}]]], cwd });
  const [snap, note] = run.results;
  // A hook is given the task's runtime, which carries the catalog on 1.0.4 as well (undeclared there, declared from 1.1),
  // so the guard fits to the lead's own image limits on both.
  assert.deepEqual(snap.content.slice(0, 2), [{ type: "text", text: "fitted to 1000" }, { type: "image", data: "SMALL", mimeType: "image/jpeg" }]);
  assert.match(textOf(snap), /snap ran/, "the tool's diagnostic still reaches the model");
  assert.ok(!JSON.stringify(snap.content).includes("BIGBIG"), "the original image never reaches the transcript");
  assert.deepEqual(note.content.map((block) => block.text).slice(0, 1), ["plain"]);
  assert.equal(guarded.length, 1, "a result without an image is not the guard's");
  assert.deepEqual(guarded[0].result.content, [{ type: "image", data: "BIGBIG", mimeType: "image/png" }]);
  assert.equal(typeof guarded[0].call.memo, "function");
  assert.equal(guarded[0].call.model.id, "lead-1");
  assert.equal(guarded[0].call.tool, "snap", "the call names the tool the model called, for the guard's rows");
});

test("a guard that cannot run removes the result's images instead of letting pi keep them, and the call still answers", async () => {
  const cwd = workspace();
  const host = { name: "host", tools: [{ name: "snap", description: "snap", parameters: { type: "object", properties: {} }, execute: async () => toolResult([{ type: "text", text: "a shot" }, { type: "image", data: "BIGBIG", mimeType: "image/png" }]) }] };
  const reports = [];
  for (const broken of [{ core: async () => { throw new Error("guard down"); } }, { scope: () => { throw new Error("no scope"); } }]) {
    globalThis.visionCore = { guardResult: broken.core ?? (async (result) => result) };
    const { extension } = createVisionExtension({ evidence, scope: broken.scope ?? scope, install: { read: "off" } });
    const run = await drive({ extensions: [host, extension], rounds: [[["snap", {}]]], cwd, onReport: (error) => reports.push(error) });
    const [snap] = run.results;
    assert.equal(snap.isError, false);
    assert.deepEqual(snap.content.map((block) => block.type), ["text", "text"]);
    assert.equal(snap.content[0].text, "a shot");
    assert.ok(!JSON.stringify(snap.content).includes("BIGBIG"));
  }
  assert.deepEqual(reports, [], "the failure is handled, not left to pi");
});

test("a host's onMiss that throws or rejects never fails the call it reports on; its onLook reaches the core as it is, so the core sees a throw", async () => {
  const cwd = workspace({ "a.png": pngBytes(2, 2) });
  globalThis.visionCore = {
    readMedia: async (env, args, call, setup) => {
      const told = await Promise.resolve().then(() => setup.onLook({ conversationId: call.conversationId, tool: "read", source: args.path })).then(() => "heard", (error) => error.message);
      await setup.onMiss({ conversationId: call.conversationId, tool: "read", source: args.path, code: "needs" });
      return { content: [{ type: "text", text: `after the rows: ${told}` }] };
    },
  };
  const rows = [];
  const { extension } = createVisionExtension({
    evidence, scope,
    onLook: (look) => { rows.push(look.tool); throw new Error("row store down"); },
    onMiss: async (miss) => { rows.push(miss.code); throw new Error("row store down"); },
  });
  const run = await drive({ extensions: [extension], rounds: [[["read", { path: "a.png" }]]], cwd });
  assert.deepEqual([run.results[0].isError, textOf(run.results[0])], [false, "after the rows: row store down"]);
  assert.deepEqual(rows, ["read", "needs"]);
});

test("the eyes: a host's function decides per conversation; without one, eyesModel looks through api.models where pi has it", async () => {
  const cwd = workspace({ "a.png": pngBytes(2, 2) });
  globalThis.visionCore = {
    readMedia: async (env, args, call, setup) => {
      if (!setup.eyes) return { content: [{ type: "text", text: "no eyes" }] };
      const answer = await setup.eyes.see({ parts: [{ type: "image", data: "AAAA", mimeType: "image/png", width: 2, height: 2, fragment: args.path }], ask: args.ask }, call.signal);
      return { content: [{ type: "text", text: `${answer.model}: ${answer.text}` }], usage: answer.usage };
    },
  };
  const own = fakeEyes({ model: "host-eyes", answers: ["from the host"] });
  const byHost = createVisionExtension({ evidence, scope, eyes: ({ conversationId }) => (conversationId ? own : undefined), eyesModel: { provider: "faux", modelId: "eyes-1" } });
  const hosted = await drive({ extensions: [byHost.extension], rounds: [[["read", { path: "a.png", ask: "q" }]]], cwd });
  assert.equal(textOf(hosted.results[0]), "host-eyes: from the host", "the host's eyes win over eyesModel");

  const requests = [];
  const viaModels = createVisionExtension({ evidence, scope, eyesModel: { provider: "faux", modelId: "eyes-1", thinking: "off" } });
  const looked = await drive({
    extensions: [viaModels.extension], rounds: [[["read", { path: "a.png", ask: "what colour?" }]]], cwd,
    eyes: (context, options) => { requests.push({ blocks: context.messages.at(-1).content.map((b) => b.type), reasoning: options?.reasoning }); return "white"; },
  });
  if (onModels) {
    assert.equal(textOf(looked.results[0]), "faux/eyes-1: white");
    assert.deepEqual(requests, [{ blocks: ["text", "image", "text"], reasoning: "low" }], "the fragment's line, the image, the question; a look always thinks");
  } else {
    assert.equal(textOf(looked.results[0]), "no eyes", "pi 1.0 gives tools no models: no eyes, and the core says so");
    assert.deepEqual(requests, []);
  }
});

test("a memo keeps the first answer for the call: a second ask under the same key is not computed", async () => {
  const cwd = workspace({ "a.png": pngBytes(2, 2) });
  let computed = 0;
  globalThis.visionCore = {
    readMedia: async (env, args, call) => {
      const ask = () => call.memo("vision:look:k1", async () => ({ text: `answer ${++computed}` }));
      const [first, second] = [await ask(), await ask()];
      return { content: [{ type: "text", text: `${first.text} / ${second.text}` }] };
    },
  };
  const { extension } = createVisionExtension({ evidence, scope });
  const run = await drive({ extensions: [extension], rounds: [[["read", { path: "a.png" }]]], cwd });
  assert.equal(textOf(run.results[0]), "answer 1 / answer 1");
  assert.equal(computed, 1);
});

test("a host whose read is its own calls read and fit with callContext, and returns piResult; eyesModel looks through its call's models", async () => {
  const cwd = workspace({ "a.png": pngBytes(2, 2) });
  const calls = [];
  globalThis.visionCore = {
    readMedia: async (env, args, call, setup) => { calls.push(["read", call, setup.scope, setup.eyes?.model]); return { content: [{ type: "image", data: "RAW", mimeType: "image/png" }], usage: usage(0.02) }; },
    guardResult: async (result, call, setup) => { calls.push(["fit", call, setup.scope, setup.eyes?.model]); return { ...result, content: [{ type: "image", data: "FIT", mimeType: "image/png" }] }; },
  };
  const vision = createVisionExtension({ evidence, scope, eyesModel: { provider: "faux", modelId: "eyes-1" }, install: { read: "off", guard: false } });
  const ownRead = {
    name: "host", tools: [{
      name: "read", description: "the host's read", parameters: { type: "object", properties: { path: { type: "string" } } },
      execute: async (args, api, context) => {
        const call = await callContext(api, context);
        const media = await vision.read(api.env, args, call);
        return piResult(await vision.fit(media, call));
      },
    }],
  };
  const run = await drive({ extensions: [ownRead, vision.extension], rounds: [[["read", { path: "a.png" }]]], cwd });
  assert.deepEqual(run.results[0].content.slice(0, 1), [{ type: "image", data: "FIT", mimeType: "image/png" }]);
  assert.equal(run.usage.tools.read.cost.total, 0.02);
  assert.deepEqual(calls.map(([name]) => name), ["read", "fit"]);
  assert.equal(calls[0][1].callId, calls[1][1].callId);
  assert.deepEqual(calls[0][2], scope(calls[0][1].conversationId));
  assert.deepEqual(calls.map((c) => c[3]), onModels ? ["faux/eyes-1", "faux/eyes-1"] : [undefined, undefined], "the eyes pi's models give on 1.1, none on 1.0");
  assert.equal((await vision.read(null, { path: "a.png" }, { ...calls[0][1] }).then(() => calls.at(-1)[3])), undefined, "a copy of the context is not the call's: no models, no eyes");
});

test("pdfText hands the core's reader the bytes, an environment over this process, the host's providers and the signal", async () => {
  const seen = [];
  globalThis.visionCore = { pdfText: async (bytes, context) => { seen.push({ bytes, context }); return "page one"; } };
  const extra = { name: "hosted-reader", capabilities: ["text"], kinds: ["pdf"], detect: async () => ({ available: true, version: "1" }) };
  const vision = createVisionExtension({ evidence, scope, providers: [extra] });
  const signal = new AbortController().signal;
  assert.equal(await vision.pdfText(new Uint8Array([37, 80, 68, 70]), signal), "page one");
  const [{ bytes, context }] = seen;
  assert.deepEqual([...bytes], [37, 80, 68, 70]);
  assert.deepEqual([context.providers[0], context.providers.slice(1).map((p) => p.name), context.signal, context.env.cwd], [extra, packageProviders().map((p) => p.name), signal, process.cwd()], "the host's first, then the package's own");
  assert.equal((await context.env.fileInfo(process.cwd(), { abortSignal: undefined, value: () => undefined })).value.kind, "directory");
});

test("piResult carries only what pi stores: the blocks under both names pi-durable has given them, the error flag, details and usage", () => {
  const blocks = [{ type: "text", text: "t" }];
  assert.deepEqual(piResult({ content: blocks }), { output: blocks, content: blocks });
  assert.deepEqual(piResult({ content: [], isError: true, details: { a: 1 }, usage: usage(1) }), { output: [], content: [], isError: true, details: { a: 1 }, usage: usage(1) });
});
