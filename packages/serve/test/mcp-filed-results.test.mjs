// An MCP tool whose answers the agent's tool setting files (`mcp:<server>/<tool>: {file: {folder, show}}`): the gateway
// writes the answer's text, scrubbed and whole, at <folder>/<tool>-<time>-<id>.json in the run's files before it answers,
// and the model reads only a summary: the bytes, where it is filed, the values of the paths the setting shows, and the
// answer's shape (keys and types to depth 2, array lengths), never another value. A write that fails shows nothing and
// is an error; an answer that is an error is shown as before; a tool with no setting is answered as before, a long one
// spilled at the clip. Never through the clip: an answer past it is filed whole and none of it is shown.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MCP_CLIP, mcpGateway } from "../dist/mcp-gateway.js";
import { localWorkspace, WORKSPACE_ERRORS } from "../dist/workspace/index.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";

const TOKEN = `not-a-secret-${"filed-results-bearer-0123"}`;
const schema = { type: "object" };
/** A customer's words in every description: none of them may reach the model's text. */
const description = (i) => `Track Day Pass for Marisol Quintero, order ${i}`;
/** A page of a balance-transactions list as Composio answers it: its envelope, 100 items, a cursor at the last. */
const page = (count, pad = "") => ({ successful: true, error: null, data: { object: "list", data: Array.from({ length: count }, (_, i) => ({ id: `txn_${String(i).padStart(4, "0")}`, amount: 1000 + i, currency: "usd", created: 1763337600 + i, description: `${description(i)}${pad}`, metadata: { customer: `cus_${i}` } })), has_more: true, url: "/v1/balance_transactions" } });
const PAGE = JSON.stringify(page(100));
/** A page past the clip (MCP_CLIP characters). */
const BIG = JSON.stringify(page(400, " ".padEnd(120, "x")));
/** Composio's pagination: what the template names so the model asks for the next page and stops, never a description. */
const SHOW = ["successful", "error", "data.has_more", "data.data.-1.id", "data.data.-1.created"];
const SETTING = { folder: "stripe", show: SHOW };

/** Every string value in `value`, keys left out. */
const stringsOf = (value) => (typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(stringsOf) : value && typeof value === "object" ? Object.values(value).flatMap(stringsOf) : []);

async function setup(t, { filed, work: workOf } = {}) {
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  const answers = {
    page: () => ({ content: [{ type: "text", text: PAGE }] }),
    big: () => ({ content: [{ type: "text", text: BIG }] }),
    shapes: () => ({ content: [{ type: "text", text: JSON.stringify(SHAPES) }] }),
    words: () => ({ content: [{ type: "text", text: "not JSON: Marisol Quintero paid" }] }),
    refused: () => ({ content: [{ type: "text", text: "Stripe refused: rate limited, try again in 2 s" }], isError: true }),
    echo: () => ({ content: [{ type: "text", text: JSON.stringify({ seen: `Bearer ${TOKEN}` }) }] }),
  };
  for (const [name, run] of Object.entries(answers)) fake.tools[name] = { description: name, input: { type: "object", properties: {} }, run };
  const tools = Object.keys(answers).map((name) => ({ name, inputSchema: schema }));
  const work = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "mcp-filed-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const gateway = mcpGateway({
    pin: { fake: { url: fake.url, tools } },
    credentials: { fake: { url: fake.url, headers: { authorization: `Bearer ${TOKEN}` } } },
    work: workOf ?? (() => localWorkspace(work)),
    ...(filed ? { filed } : {}),
  });
  const call = (tool) => gateway.call("fake", tool, {}, { signal: new AbortController().signal });
  return { fake, gateway, work, call };
}
const textOf = (result) => result.content.map((block) => block.text).join("");
/** The names filed under `folder` of the run's files. */
const filedIn = async (work, folder) => readdir(join(work, folder)).catch(() => []);

test("a tool the setting files: its answer is filed byte for byte, and the model reads the bytes, the path, the shown values and the shape, no other string of it", async (t) => {
  const { call, work } = await setup(t, { filed: (server, tool) => (server === "fake" && tool === "page" ? SETTING : undefined) });
  const result = await call("page");
  assert.equal(result.isError, undefined, textOf(result));
  const [name, ...more] = await filedIn(work, "stripe");
  assert.deepEqual(more, [], "one file for one call");
  assert.match(name, /^page-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[0-9a-f]{8}\.json$/);
  assert.equal(await readFile(join(work, "stripe", name), "utf8"), PAGE, "the answer's text, whole and unchanged");
  const bytes = Buffer.byteLength(PAGE).toLocaleString("en-US");
  assert.equal(textOf(result), [
    `page answered ${bytes} bytes, filed whole at stripe/${name}. Its values are not shown here (the agent's setting files this tool's answers); only these are:`,
    '{"successful": true, "error": null, "data.has_more": true, "data.data.-1.id": "txn_0099", "data.data.-1.created": 1763337699}',
    'Shape: {"successful": boolean, "error": null, "data": {"object": string, "data": [100 objects], "has_more": boolean, "url": string}}',
  ].join("\n"));
  const shown = stringsOf(JSON.parse(PAGE)).filter((value) => textOf(result).includes(value));
  assert.deepEqual(shown, ["txn_0099"], "no string of the answer but the shown cursor");
  assert.ok(!/Marisol|Track Day|cus_/.test(textOf(result)), "no customer's word, no metadata");
  assert.deepEqual(await readdir(work), ["stripe"], "nothing spilled at evidence/");
});

test("the shape: keys to depth 2, each array's length and what it holds, never a value or a key below; a shown path reaches a scalar or is null, a string cut at 200", async (t) => {
  const { call, work } = await setup(t, { filed: (_server, tool) => (tool === "shapes" ? { folder: "out/shapes", show: ["list.0.name", "list.-1", "nested.deep", "nested.text", "missing.path", "rows.2", "count"] } : undefined) });
  const result = await call("shapes");
  const [name] = await filedIn(work, "out/shapes");
  assert.equal(await readFile(join(work, "out", "shapes", name), "utf8"), JSON.stringify(SHAPES));
  const [, shown, shape] = textOf(result).split("\n");
  assert.equal(shown, `{"list.0.name": "first", "list.-1": null, "nested.deep": null, "nested.text": "${"y".repeat(200)}…", "missing.path": null, "rows.2": "c", "count": 3}`);
  assert.equal(shape, 'Shape: {"list": [2 objects], "nested": {"deep": object, "text": string, "none": [0 items], "mixed": [3 items], "grid": [1 array]}, "rows": [3 strings], "count": number, "on": boolean, "nothing": null}');
  assert.ok(!textOf(result).includes("hidden"), "no key below depth 2");
});

/** An answer of every kind of value, at every depth. */
const SHAPES = { list: [{ name: "first" }, { name: "second" }], nested: { deep: { hidden: "a value two levels down" }, text: "y".repeat(300), none: [], mixed: [1, "two", null], grid: [[1, 2]] }, rows: ["a", "b", "c"], count: 3, on: true, nothing: null };

test("an answer that is not JSON is filed whole; the model reads its bytes and that it is text, and no path is shown", async (t) => {
  const { call, work } = await setup(t, { filed: () => ({ folder: "notes", show: ["a"] }) });
  const result = await call("words");
  const [name] = await filedIn(work, "notes");
  assert.equal(await readFile(join(work, "notes", name), "utf8"), "not JSON: Marisol Quintero paid");
  assert.ok(!textOf(result).includes("Marisol"), textOf(result));
  assert.match(textOf(result), /\n\{"a": null\}\nShape: text, not JSON$/);
});

test("an answer past the clip is filed whole and none of it is shown: it never reaches the clip or the spill", async (t) => {
  assert.ok(BIG.length > MCP_CLIP, "the answer is past the clip");
  const { call, work } = await setup(t, { filed: (_server, tool) => (tool === "big" ? SETTING : undefined) });
  const result = await call("big");
  const [name] = await filedIn(work, "stripe");
  assert.equal(await readFile(join(work, "stripe", name), "utf8"), BIG, "the whole answer");
  assert.ok(textOf(result).length < 1_000, `a summary: ${textOf(result).length} characters`);
  assert.ok(!/Marisol|cut at/.test(textOf(result)), textOf(result));
  assert.match(textOf(result), /"data": \[400 objects\]/);
  assert.deepEqual(await readdir(work), ["stripe"], "nothing at evidence/mcp");
});

test("a write that fails shows nothing of the answer and is an error, in the Workspace's words; so does a Workspace that cannot open", async (t) => {
  const elsewhere = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "mcp-filed-elsewhere-"));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  const { call, work } = await setup(t, { filed: () => SETTING });
  await symlink(elsewhere, join(work, "stripe"));
  const result = await call("page");
  assert.equal(result.isError, true);
  assert.ok(textOf(result).includes(WORKSPACE_ERRORS.ESCAPE), textOf(result));
  assert.ok(!stringsOf(JSON.parse(PAGE)).some((value) => textOf(result).includes(value)), `no value of the answer: ${textOf(result)}`);
  assert.deepEqual(await readdir(elsewhere), [], "never through the link");

  const closed = await setup(t, { filed: () => SETTING, work: () => Promise.reject(Object.assign(new Error("/mnt/run-disk is gone"), { code: "UNAVAILABLE" })) });
  const unopened = await closed.call("page");
  assert.equal(unopened.isError, true);
  assert.ok(!/Marisol|txn_|\/mnt\/run-disk/.test(textOf(unopened)), textOf(unopened));
  assert.match(textOf(unopened), /could not be filed/);
});

test("an answer that is an error is shown as before and filed nowhere, so the model can react to a refusal", async (t) => {
  const { call, work } = await setup(t, { filed: () => SETTING });
  assert.deepEqual(await call("refused"), { content: [{ type: "text", text: "Stripe refused: rate limited, try again in 2 s" }], isError: true });
  assert.deepEqual(await readdir(work), []);
});

test("with no setting, or the setting on another tool, the answer is the model's as before, and a long one spills at the clip", async (t) => {
  for (const filed of [undefined, (_server, tool) => (tool === "other" ? SETTING : undefined)]) {
    const { call, work } = await setup(t, { filed });
    assert.deepEqual(await call("page"), { content: [{ type: "text", text: PAGE }] });
    assert.deepEqual(await readdir(work), [], "nothing filed");
    const long = textOf(await call("big"));
    assert.match(long, /the whole answer is in the run's files at evidence\/mcp\/fake\//, "spilled as before");
  }
});

test("the filed answer is scrubbed as the model's text is: no credential the call took is written", async (t) => {
  const { call, work } = await setup(t, { filed: () => ({ folder: "echo", show: ["seen"] }) });
  const result = await call("echo");
  const [name] = await filedIn(work, "echo");
  const filed = await readFile(join(work, "echo", name), "utf8");
  assert.ok(!filed.includes(TOKEN), filed);
  assert.ok(!textOf(result).includes(TOKEN), textOf(result));
});
