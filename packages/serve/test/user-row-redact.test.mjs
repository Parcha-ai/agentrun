// A person's own message can hold a held key (pasted by mistake). The Timeline's row for it and the run's title, which
// the run list shows, hold none of it; the model still gets the message exactly as it was typed.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, flowAgent, follow, scratch, serve, withEnv } from "./support.mjs";

/** A held key, made at runtime: distinct per run, and no credential-shaped literal for the source export. */
const KEY = ["not-a-secret", "pasted-key", randomBytes(6).toString("hex")].join("-");
const holdsRun = (text, secret) => {
  for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) return true;
  return false;
};

test("a message that holds a held key: its Timeline row and the run's title (its view and the run list) hold none of it, and the model got it as typed", { timeout: 60_000 }, async (t) => {
  withEnv(t, { PARALLEL_API_KEY: KEY });
  const dir = await scratch(t);
  const file = join(dir, "got.txt");
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("pasted"))).status, 201);
  // A console link with its fragment, and the key in a URL's query too.
  const link = "http://127.0.0.1:7340/#/runs/01a1a88c-4f2e-7abc-8def-0123456789ab"; // key-gate: loopback-rule a console link a person pastes, as text
  const content = `My key is ${KEY}, see ${link} and https://api.example/v1?k=${KEY}&x=1. Record what you got in ${file} now.`;
  const started = await api("POST", "/agents/pasted/runs", { input: { content } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed"]);
  assert.equal(await readFile(file, "utf8"), content, "the model got the message exactly as typed");
  const rows = (await api("GET", `/runs/${runId}/timeline`)).body.rows;
  const own = rows.filter((row) => row.kind === "user_message");
  assert.equal(own.length, 1, JSON.stringify(rows.map((row) => row.kind)));
  assert.ok(!holdsRun(JSON.stringify(own), KEY), `the message's row: ${JSON.stringify(own.map((row) => [row.summary, row.text]))}`);
  assert.match(own[0].text, /^My key is \[redacted\], see /, own[0].text);
  for (const [field, text] of [["summary", own[0].summary], ["text", own[0].text]]) {
    assert.ok(text.includes(`see ${link} and https://api.example/v1?k=[redacted]&x=1.`), `the row's ${field}: ${text}`);
  }
  const view = (await api("GET", `/runs/${runId}`)).body;
  const listed = (await api("GET", "/runs?agent=pasted")).body.runs.find((run) => run.run_id === runId);
  for (const [where, title] of [["the run's view", view.title], ["the run list", listed.title]]) assert.ok(!holdsRun(title, KEY), `${where}'s title: ${title}`);
  assert.ok(!holdsRun(JSON.stringify(rows), KEY), "nowhere on the Timeline");
});

// A workflow run's title is its agent's name and a few of its input's values, a long one cut at 39 characters. It shows
// on the run's page, the runs list (and Mission Control, which reads it) and its agent's runs.
const DIGITS = ["1234", "5678", "9012"].join("");
const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];

test("a workflow run whose input holds a held key, cut or whole, and an all-digit one: its title on its page, the runs list and its agent's runs holds neither, and the run keeps its input as given", { timeout: 60_000 }, async (t) => {
  withEnv(t, { AGENT_MODEL: "openai/gpt-6-sol", OPENAI_API_KEY: DIGITS, PARALLEL_API_KEY: KEY }, [...NAMES, "PARALLEL_API_KEY"]);
  const { api, data } = await serve(t);
  const flow = {
    v: 2, name: "wf",
    schemas: {
      In: { type: "object", required: ["question", "note", "number"], properties: { question: { type: "string" }, note: { type: "string" }, number: { type: "number" } } },
      Out: { type: "object", required: ["note", "n"], properties: { note: { type: "string" }, n: { type: "number" } } },
    },
    input: { schemaId: "In" },
    output: { schemaId: "Out", path: "out" },
    root: { node: "chain", steps: [{ node: "extract", label: "out", instructions: "Submit the held key.", out: "Out", as: "out" }] },
  };
  assert.equal((await api("POST", "/agents", flowAgent("wf", flow))).status, 201);
  // The note is cut at 39 characters, inside the key.
  const input = { question: KEY, note: `see ${KEY} for the rest`, number: Number(DIGITS) };
  const started = await api("POST", "/agents/wf/runs", { input });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed", "failed"], { deadlineMs: 50_000 });
  const titles = [
    ["its page", (await api("GET", `/runs/${runId}`)).body.title],
    ["the runs list", (await api("GET", "/runs")).body.runs.find((run) => run.run_id === runId).title],
    ["its agent's runs", (await api("GET", "/agents/wf/runs")).body.runs.find((run) => run.run_id === runId).title],
  ];
  for (const [where, title] of titles) {
    assert.ok(title.startsWith("wf: "), `${where}: ${title}`);
    assert.ok(!holdsRun(title, KEY) && !title.includes(DIGITS), `${where}'s title: ${title}`);
  }
  assert.deepEqual(JSON.parse(await readFile(join(data, "runs", runId, "serve.json"), "utf8")).input, input, "the run keeps its input as given");
});
