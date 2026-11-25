// GET /v2/runs/{id}/export over a running server: an ended run's agentrun.share/1 bundle, gathered from what the server
// serves of it (its view, its Timeline rows, a workflow's graph, its files) and cut by the scrubber with the run's cut
// set, read last. A live run is 409, a withheld one 403, an unknown one 404, a restore of a cut that may not be restored
// 400, and a scrub that fails answers 500 with no body at all. Every planted value is synthetic, made fresh for the case.
// The server here is the real one (custody-support's), and the test counts no request of anyone's: a probe of / on its
// listener changes nothing it asserts.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { API_ONLY_ROUTES, servedApiOnly } from "../dist/api-only.js";
import { scrub } from "../dist/secret-cut.js";
import { ROUTES } from "../dist/server.js";
import { marked, server, sha, written } from "./custody-support.mjs";
import { flowAgent, follow } from "./support.mjs";
import { unixHome } from "./scrub-positives.mjs";

/** Fresh synthetic secrets of each kind: an sk- key (format), a value the server holds (an environment variable named
 *  as a key: held), a PGPASSWORD= value (label), a home path's user and an email (personal). */
function planted() {
  return {
    sk: `sk-proj-${randomBytes(24).toString("hex")}`,
    held: `sharetest${randomBytes(16).toString("hex")}`,
    pg: `Pw${randomBytes(9).toString("hex")}`,
    user: `qa${randomBytes(3).toString("hex")}`,
    email: `qa.${randomBytes(4).toString("hex")}@mailbox-synthetic.zz`,
  };
}

const formsOf = (value) => [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), Buffer.from(value).toString("base64"), Buffer.from(value).toString("base64url")];

/** No form of any planted value (but those named in `except`) in `text`. */
function holdsNoPlant(text, p, where, except = []) {
  for (const [name, value] of Object.entries(p)) {
    if (except.includes(name)) continue;
    for (const form of formsOf(value)) assert.ok(!text.includes(form), `${where}: the ${name} value is there`);
  }
}

/** A GET of /v2`path` with the server's token: status, headers and the body's bytes. */
function get(s, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: s.port, method: "GET", path: `/v2${path}`, agent: false, headers: { authorization: `Bearer ${s.token}` } }, (res) => {
      const parts = [];
      res.on("data", (chunk) => parts.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(parts), text: Buffer.concat(parts).toString("utf8") }));
    });
    req.once("error", reject).end();
  });
}

/** A text file uploaded with the server's token: its id. */
async function uploaded(s, path, text) {
  const bytes = Buffer.from(text);
  const made = await s.api("POST", "/files", { path, size_bytes: bytes.length, content_type: "text/plain" });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const sent = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: s.port, method: "PUT", path: made.body.upload.url, agent: false, headers: { authorization: `Bearer ${s.token}`, "content-type": "application/octet-stream" } }, (res) => res.resume().on("end", () => resolve(res.statusCode)));
    req.once("error", reject).end(bytes);
  });
  assert.equal(sent, 200);
  return made.body.file?.file_id ?? made.body.file_id;
}

/** A run of alpha (the faux model's "Hold, then echo": it answers with what it was told) told `said`, with `files`; ended
 *  unless `hold`, else held at its gate until `release`. */
async function ran(s, said, { files = [], hold = false } = {}) {
  const gate = join(s.data, "..", `gate-${randomBytes(4).toString("hex")}`);
  if (!hold) writeFileSync(gate, "");
  const started = await s.api("POST", "/agents/alpha/runs", { input: { content: `${said} Hold, then echo, until ${gate}.` }, file_ids: files });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  if (!hold) await follow(s.api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  return { runId, release: () => writeFileSync(gate, "") };
}

/** A workflow mapping over its input's items, each one llm call (graph-custody.test.mjs's). */
const mapped = {
  v: 2, name: "export-mapped",
  schemas: {
    In: { type: "object", required: ["question", "items"], properties: { question: { type: "string" }, items: { type: "array", items: { type: "string" } } } },
    Llm: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Llm", path: "answers" },
  root: { node: "chain", steps: [{ node: "map", label: "each", itemsPath: "items", as: "answers", resultPath: "answer", maxConcurrency: 1, body: { node: "call", label: "answer", via: "tool", tool: "llm", args: { prompt: "Answer." }, out: "Llm", as: "answer", deadline_s: 60 } }] },
};

test("the API-only profile does not serve the export: its allowlist leaves it out, so it answers 404 there", () => {
  assert.ok(ROUTES.some((route) => route.name === "getRunExport" && route.method === "GET" && route.pattern.test("/runs/run_1/export")), "the route is in the table");
  assert.ok(!API_ONLY_ROUTES.has("getRunExport"));
  assert.equal(servedApiOnly(ROUTES, "GET", "/v2/runs/run_1/export"), false);
});

test("GET /runs/{id}/export: an ended run's bundle, cut of every planted value; byte-identical again; restore; 409, 403, 404, 400 and a failed scrub's empty 500", { timeout: 240_000 }, async (t) => {
  const p = planted();
  // The scrubber the export cuts with: the real one, until a case turns it to fail.
  let failing = false;
  const shareScrub = async (text, opts) => (failing ? { ok: false, counts: {} } : scrub(text, opts));
  const s = await server(t, { agentTools: [], env: { SHARETEST_API_KEY: p.held }, shareScrub });
  const said = `Connect with PGPASSWORD=${p.pg} psql -h db; key ${p.sk}; token ${p.held}; notes in ${unixHome(p.user)}/work; mail ${p.email}.`;
  const notes = await uploaded(s, "notes.txt", `The notes: ${said}\n`);
  const { runId } = await ran(s, said, { files: [notes] });

  await t.test("an ended agentic run: 200, the bundle, its rows the served Timeline's, its file carried, no planted value in any form", async () => {
    const answer = await get(s, `/runs/${runId}/export`);
    assert.equal(answer.status, 200, answer.text.slice(0, 400));
    assert.match(answer.headers["content-type"], /^application\/json/);
    assert.equal(answer.headers["cache-control"], "no-store");
    holdsNoPlant(answer.text, p, "the bundle");
    const doc = JSON.parse(answer.text);
    assert.equal(doc.format, "agentrun.share/1");
    assert.match(doc.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(doc.agent, { name: "alpha", kind: "agentic" });
    assert.equal(doc.run.status, "completed");
    assert.equal(doc.graph, null);
    for (const dropped of ["run_id", "agent_id", "console_url", "input", "labels", "claim"]) assert.ok(!(dropped in doc.run), dropped);
    const timeline = await s.api("GET", `/runs/${runId}/timeline`);
    assert.deepEqual(doc.rows.map((row) => [row.id, row.kind]), timeline.body.rows.map((row) => [row.id, row.kind]), "the rows are the served Timeline's");
    const file = doc.files.find((each) => each.path === "inputs/notes.txt");
    assert.ok(file, JSON.stringify(doc.files.map((each) => each.path)));
    assert.match(file.content, /^The notes: Connect with PGPASSWORD=\[redacted:secret-assign\]/);
    // The file is cut as the server's own cut read cuts it (?cut=run: the held value and the key's shape "[redacted]"),
    // then by the scrubber (the label and personal cuts recorded).
    const served = await get(s, `/runs/${runId}/files/inputs/notes.txt?cut=run`);
    assert.ok(served.text.includes("key [redacted]; token [redacted];"), served.text);
    assert.ok(file.content.includes("key [redacted]; token [redacted];"), file.content);
    const kinds = new Set(doc.cuts.map((cut) => cut.kind));
    for (const kind of ["label", "personal"]) assert.ok(kinds.has(kind), `a ${kind} cut: ${[...kinds]}`);
    assert.ok(doc.omitted.some((each) => each.what === "recordings"));
  });

  await t.test("a second export is byte-identical", async () => {
    const one = await get(s, `/runs/${runId}/export`);
    const two = await get(s, `/runs/${runId}/export`);
    assert.equal(one.status, 200);
    assert.ok(one.bytes.equals(two.bytes), "the same bytes");
  });

  await t.test("restore: a label cut comes back in place and moves to restored; an unknown or malformed id is a 400 that names no value", async () => {
    const doc = JSON.parse((await get(s, `/runs/${runId}/export`)).text);
    const label = doc.cuts.find((cut) => cut.kind === "label" && cut.at === "/files/0/content");
    assert.ok(label, JSON.stringify(doc.cuts.map((cut) => [cut.at, cut.rule])));
    const restored = await get(s, `/runs/${runId}/export?restore=${label.id}`);
    assert.equal(restored.status, 200, restored.text.slice(0, 400));
    const back = JSON.parse(restored.text);
    assert.deepEqual(back.restored.map((each) => each.id), [label.id]);
    assert.ok(!back.cuts.some((cut) => cut.id === label.id));
    const content = back.files[0].content;
    assert.equal(content.slice(back.restored[0].start, back.restored[0].end), p.pg, "the value is back at its span");
    holdsNoPlant(restored.text, p, "the restored bundle", ["pg"]);
    assert.equal(restored.text.split(p.pg).length - 1, 1, "back in that one place alone");
    // Every value no restore may bring back (a held value, a key's shape) reaches the scrubber already "[redacted]" by the
    // served reads and the file cut: this bundle holds no cut of one to name. The unit tests pin a format, held or dump
    // cut's id as a 400.
    assert.ok(doc.cuts.every((cut) => cut.restorable), JSON.stringify(doc.cuts.map((cut) => [cut.kind, cut.restorable])));
    for (const id of ["c_0123456789abcdef", "c_nothex", encodeURIComponent(p.pg)]) {
      const refused = await get(s, `/runs/${runId}/export?restore=${id}`);
      assert.equal(refused.status, 400, `${id}: ${refused.text}`);
      holdsNoPlant(refused.text, p, "the refusal");
    }
  });

  await t.test("a run still at work is 409; once it ends it exports", async () => {
    const held = await ran(s, "Wait here.", { hold: true });
    const answer = await get(s, `/runs/${held.runId}/export`);
    assert.equal(answer.status, 409, answer.text);
    assert.equal(JSON.parse(answer.text).error.code, "run_not_final");
    held.release();
    await follow(s.api, held.runId, ["completed", "failed"], { deadlineMs: 60_000 });
    assert.equal((await get(s, `/runs/${held.runId}/export`)).status, 200);
  });

  await t.test("a withheld run (handed a sign-in nothing here opens) is 403, in the view's words, with no planted value", async () => {
    const { runId: withheld } = await ran(s, said);
    await written(s, "UPDATE run_launch SET body = json_set(body, '$.plane.browser', 'browserbase') WHERE run_id = ?", withheld);
    await marked(s, withheld, [sha("a pointer this server never kept")]);
    const answer = await get(s, `/runs/${withheld}/export`);
    assert.equal(answer.status, 403, answer.text.slice(0, 400));
    holdsNoPlant(answer.text, p, "the 403");
  });

  await t.test("an unknown run is 404", async () => {
    assert.equal((await get(s, `/runs/run_${randomBytes(6).toString("hex")}/export`)).status, 404);
  });

  await t.test("a workflow run carries its graph, cut", async () => {
    assert.equal((await s.api("POST", "/agents", flowAgent("mapped", mapped, { tools: ["llm"] }))).status, 201);
    const started = await s.api("POST", "/agents/mapped/runs", { input: { question: "q", items: [`mail ${p.email}`] } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await follow(s.api, started.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
    const answer = await get(s, `/runs/${started.body.run_id}/export`);
    assert.equal(answer.status, 200, answer.text.slice(0, 400));
    const doc = JSON.parse(answer.text);
    assert.equal(doc.agent.kind, "workflow");
    const graph = await s.api("GET", `/runs/${started.body.run_id}/graph`);
    assert.equal(graph.status, 200);
    assert.deepEqual(Object.keys(doc.graph).sort(), Object.keys(graph.body).filter((key) => key !== "read_at").sort(), "the graph as its route serves it, but for its read time");
    assert.ok(doc.cuts.some((cut) => cut.at.startsWith("/graph/") && cut.rule === "email"), "the graph's email is cut");
    holdsNoPlant(answer.text, p, "the workflow's bundle");
    assert.ok((await get(s, `/runs/${started.body.run_id}/export`)).bytes.equals(answer.bytes), "byte-identical again: the graph's read time is not carried");
  });

  await t.test("fails closed: a scrub that answers ok:false is a 500 with an empty body", async () => {
    failing = true;
    try {
      const answer = await get(s, `/runs/${runId}/export`);
      assert.equal(answer.status, 500);
      assert.equal(answer.bytes.length, 0, `no body: ${answer.text.slice(0, 200)}`);
    } finally {
      failing = false;
    }
    assert.equal((await get(s, `/runs/${runId}/export`)).status, 200, "the next export, with the scrubber whole, answers");
  });
});
