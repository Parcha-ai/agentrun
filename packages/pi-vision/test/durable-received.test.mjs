// The pi-durable adapter with the real core behind it, through a real Harness on SQLite: what the model receives from
// `read` and from a guarded tool result on every pi-durable the peers accept, whose result the host's rows say an image
// was, what `scope` is given, what a host callback that throws becomes, and a read on an environment that refuses
// writes. Every file is built by the test.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AgentDoc } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { imageHeader } from "@parcha/pi-vision";
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { docxBytes, pdfBytes, pngBytes } from "@parcha/pi-vision/testing";
import { ctx, drive, textOf, tmp } from "./durable/rig.mjs";

const LINES = ["Invented memo for a test", "Item code 5521"];
const scope = (id) => ({ label: `conv-${id}`, deriveDir: `.vision/${id}` });
const workspace = (files) => {
  const dir = tmp();
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
};
const png = (width, height) => ({ type: "image", data: Buffer.from(pngBytes(width, height)).toString("base64"), mimeType: "image/png" });
/** A host's tool that returns `blocks` under both names pi-durable has given a result's blocks, as a tool built for
 *  every release does. */
const hostTool = (name, blocks) => ({ name, tools: [{ name, description: name, parameters: { type: "object", properties: {} }, execute: async () => ({ content: blocks, output: blocks }) }] });
/** The host's sink and rows, each call kept. */
const host = () => {
  const filed = [], looks = [], misses = [];
  return {
    filed, looks, misses,
    options: { evidence: { file: async (label) => { filed.push(label); return { path: `evidence/${label}/${filed.length}-look.md` }; } }, onLook: (look) => looks.push(look), onMiss: (miss) => misses.push(miss) },
  };
};
/** The tool results of the lead's last request, in the order of the calls that asked for them. */
const received = (requests) => {
  const messages = requests.at(-1);
  const calls = messages.findLast((m) => m.role === "assistant").content.filter((b) => b.type === "toolCall");
  return calls.map((call) => messages.find((m) => m.role === "toolResult" && m.toolCallId === call.id));
};

test("the model receives blocks from read of an image and of a PDF, and the guard's blocks from another tool's result", async () => {
  const cwd = workspace({ "chart.png": pngBytes(40, 30), "memo.pdf": pdfBytes([{ lines: LINES }]) });
  // The lead takes images up to 1000 px: the small one is shown, the large one cannot be fitted and is withheld.
  const [small, large] = [png(40, 30), png(1600, 1200)];
  const requests = [];
  const vision = createVisionExtension({ evidence: { file: async () => null }, scope });
  await drive({ extensions: [hostTool("snap", [{ type: "text", text: "a shot" }, small, large]), vision.extension], rounds: [[["read", { path: "chart.png" }], ["read", { path: "memo.pdf" }], ["snap", {}]]], cwd, onLead: (context) => requests.push(context.messages) });
  const [image, pdf, snap] = received(requests);
  assert.deepEqual(image.content.map((b) => b.type), ["text", "image"], "the image read reaches the model as blocks");
  assert.deepEqual([image.content[1].mimeType, imageHeader(Buffer.from(image.content[1].data, "base64")).width], ["image/png", 40]);
  for (const line of LINES) assert.match(textOf(pdf), new RegExp(line), "the PDF's text reaches the model");
  assert.deepEqual(snap.content.map((b) => b.type), ["text", "image", "text"], "the shot's text, the image that fits, the miss in place of the one that does not");
  assert.equal(snap.content[1].data, small.data);
  assert.ok(!JSON.stringify(snap.content).includes(large.data), "the image over the lead's limit never reaches it");
});

test("the guard's looks and misses name the tool the model called and its result, not read", async () => {
  const cwd = workspace({});
  const screenshot = hostTool("screenshot", [{ type: "text", text: "a page" }, png(4, 4)]);
  const withheld = host();
  await drive({ extensions: [screenshot, createVisionExtension({ ...withheld.options, scope }).extension], rounds: [[["screenshot", {}]]], cwd, lead: "blind-1" });
  assert.deepEqual(withheld.misses.map((m) => [m.tool, m.source, m.code, m.receipt]), [["screenshot", "a screenshot result", "no_vision_route", null]]);
  const shown = host();
  await drive({ extensions: [screenshot, createVisionExtension({ ...shown.options, scope }).extension], rounds: [[["screenshot", {}]]], cwd });
  assert.deepEqual(shown.looks.map((l) => [l.tool, l.source, l.record.args.path, l.receipt]), [["screenshot", "a screenshot result", "a screenshot result", null]]);
  assert.deepEqual([withheld.filed, shown.filed], [[], []], "a result no door named files no receipt");
});

test("scope is given pi's own conversation id beside the string, so a host reads its conversation's documents there", async () => {
  const cwd = workspace({ "chart.png": pngBytes(4, 4) });
  const rows = host();
  const given = [];
  let harness;
  const vision = createVisionExtension({
    ...rows.options,
    scope: async (conversationId, id) => {
      given.push([conversationId, id]);
      const agent = await harness.snapshot(AgentDoc, id, ctx);
      return { label: `${conversationId}-${agent.model.modelId}`, deriveDir: `.vision/${conversationId}` };
    },
  });
  const run = await drive({ extensions: [vision.extension], rounds: [[["read", { path: "chart.png" }]]], cwd, opened: (opened) => { harness = opened; } });
  assert.equal(run.results[0].isError, false, textOf(run.results[0]));
  const [[conversationId, id]] = given;
  assert.equal(typeof conversationId, "string");
  assert.notEqual(typeof id, "string", "pi's own id, as its documents take it");
  assert.equal(String(id), conversationId);
  assert.deepEqual(rows.filed, [`${conversationId}-lead-1`]);
});

test("a scope, eyes or limits callback that throws is a typed miss for a media read and a row for the host; a plain text file still reads", async () => {
  const cwd = workspace({ "chart.png": pngBytes(4, 4), "notes.txt": "first line\n" });
  const down = (what) => () => { throw new Error(`${what} is down`); };
  for (const broken of [{ scope: down("scope") }, { eyes: down("eyes") }, { limits: down("limits") }]) {
    const rows = host();
    const vision = createVisionExtension({ ...rows.options, scope, ...broken });
    const run = await drive({ extensions: [vision.extension], rounds: [[["read", { path: "chart.png" }], ["read", { path: "notes.txt" }]]], cwd });
    const [media, plain] = run.results;
    assert.deepEqual([media.isError, media.details?.miss?.code], [false, "look_failed"], textOf(media));
    assert.deepEqual(rows.misses.map((m) => [m.tool, m.source, m.code, m.receipt]), [["read", "chart.png", "look_failed", null]]);
    assert.equal(plain.isError, false);
    assert.match(textOf(plain), /first line/);
  }
});

test("on an environment that refuses every write, an image, a PDF and a docx still read: a reader in this process needs no file", async () => {
  const cwd = workspace({ "chart.png": pngBytes(40, 30), "memo.pdf": pdfBytes([{ lines: LINES }]), "memo.docx": docxBytes() });
  const refused = Object.assign(new Error("this directory is read-only"), { code: "permission_denied" });
  const readOnly = (env) => new Proxy(env, { get: (target, key) => (key === "writeFile" ? async () => ({ ok: false, error: refused }) : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
  const vision = createVisionExtension({ evidence: { file: async () => null }, scope });
  const run = await drive({ extensions: [vision.extension], rounds: [[["read", { path: "chart.png" }], ["read", { path: "memo.pdf" }], ["read", { path: "memo.docx" }]]], cwd, env: () => readOnly(new NodeExecutionEnv({ cwd })) });
  for (const result of run.results) assert.equal(result.details?.miss, undefined, textOf(result));
  const [image, pdf, docx] = run.results;
  assert.deepEqual(image.content.map((b) => b.type), ["text", "image"]);
  for (const line of LINES) assert.match(textOf(pdf), new RegExp(line));
  assert.match(textOf(docx), /EXAMPLE WIDGETS LLC/);
});
