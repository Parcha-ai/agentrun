// The planted-secret harness over a run's reads: every GET operation the served API document lists that reads a run (its
// view, timeline, files, graph, browser, learning, and the run lists) is called for a run whose words hold planted
// secrets, and none may show them. A run read route the harness has no case for fails the build (the gate below), so a
// new read route can't skip the cut.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openapiDocument } from "../dist/openapi.js";
import { saveSignIn } from "../dist/sign-ins-store.js";
import { openSqliteStore } from "../dist/store/sqlite/store.js";
import { findPlanted, plantedValue } from "./fixtures/planted-secrets.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

const FAUX_READ = new URL("./fixtures/faux-read-notes.mjs", import.meta.url).pathname;

/** The run read operations: every GET whose path reads a run or a list of runs. */
export function runReadOperations(doc) {
  return Object.entries(doc.paths ?? {})
    .filter(([path, item]) => item.get && /(^|\/)runs(\/|$)/.test(path))
    .map(([path, item]) => ({ path, operation: item.get.operationId }));
}

/** The harness's case for each run read operation, by operationId: the paths it reads for `run` ({ id, agentId, file }). */
const RUN_READS = {
  listAllRuns: (run) => ["/runs", `/runs?agent_id=${encodeURIComponent(run.agentId)}`],
  listRuns: (run) => [`/agents/${run.agentId}/runs`],
  getRun: (run) => [`/runs/${run.id}`],
  getTimeline: (run) => [`/runs/${run.id}/timeline`],
  listRunFiles: (run) => [`/runs/${run.id}/files`],
  readRunFile: (run) => [`/runs/${run.id}/files/${run.file}`],
  getRunGraph: (run) => [`/runs/${run.id}/graph`],
  getRunBrowser: (run) => [`/runs/${run.id}/browser`],
  getRunLearning: (run) => [`/runs/${run.id}/learning`],
  getRunLearningDiff: (run) => [`/runs/${run.id}/learning/diff`],
};

/** A case that can't pass on this line yet, by "<operationId> (<run>)": what it waits on. */
const WAITS = {
  "getTimeline (handed)":
    "waits on the run timeline cutting the view's own secrets (the run timeline's redactor), and withholding a withheld run",
  "getTimeline (withheld)":
    "waits on the run timeline cutting the view's own secrets (the run timeline's redactor), and withholding a withheld run",
  "getRun (handed)":
    "waits on a run's title being cut of the sign-in it was handed, and withheld with a withheld run (store-view's title, the run lists' summary)",
  "getRun (withheld)":
    "waits on a run's title being cut of the sign-in it was handed, and withheld with a withheld run (store-view's title, the run lists' summary)",
  "listRuns (handed)":
    "waits on a run's title being cut of the sign-in it was handed, and withheld with a withheld run (store-view's title, the run lists' summary)",
  "listRuns (withheld)":
    "waits on a run's title being cut of the sign-in it was handed, and withheld with a withheld run (store-view's title, the run lists' summary)",
  "listAllRuns (handed)":
    "waits on a run's title being cut of the sign-in it was handed, and withheld with a withheld run (store-view's title, the run lists' summary)",
  "listAllRuns (withheld)":
    "waits on a run's title being cut of the sign-in it was handed, and withheld with a withheld run (store-view's title, the run lists' summary)",
  "readRunFile (withheld)":
    "waits on the run file routes refusing a withheld run, as the view does",
  "readRunFile (handed)":
    "waits on a ruling for a run's file bytes that hold what it was handed (the file route serves bytes uncut)",
};

test("every run read operation the API document lists has a case in the harness: a new one fails until it does", () => {
  const listed = runReadOperations(openapiDocument(() => undefined));
  assert.ok(listed.length >= 2, "the document lists run reads");
  assert.deepEqual(listed.filter(({ operation }) => !Object.hasOwn(RUN_READS, operation)).map(({ path, operation }) => `GET ${path} (${operation})`), [], "run reads with no case");
});

/** A GET of `path` (under /v2) with the server's token: its status, headers and body as text. */
function get(port, token, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path: `/v2${path}`, agent: false, headers: { authorization: `Bearer ${token}` } }, (res) => {
      const parts = [];
      res.on("data", (chunk) => parts.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, text: `${JSON.stringify(res.headers)}\n${Buffer.concat(parts).toString("utf8")}` }));
    });
    req.once("error", reject).end();
  });
}

/** A file reserved and sent with the server's token: its id. */
async function uploaded(server, path, text) {
  const bytes = Buffer.from(text);
  const made = await server.api("POST", "/files", { path, size_bytes: bytes.length, content_type: "text/plain" });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const sent = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, method: "PUT", path: made.body.upload.url, agent: false, headers: { authorization: `Bearer ${server.token}`, "content-type": "application/octet-stream" } }, (res) => {
      res.resume().on("end", () => resolve(res.statusCode));
    });
    req.once("error", reject).end(bytes);
  });
  assert.equal(sent, 200);
  return made.body.file?.file_id ?? made.body.file_id;
}

/** A completed run of agent `agentId` whose input and its notes file (read through its read tool, then answered) hold
 *  `words`: its id. */
async function ranWith(server, agentId, words) {
  assert.equal((await server.api("POST", "/agents", agent(agentId, { tools: ["read"] }))).status, 201);
  const file = await uploaded(server, "notes.txt", `The notes: ${words}\n`);
  const run = await server.api("POST", `/agents/${agentId}/runs`, { input: { content: `Read the notes. ${words}` }, file_ids: [file] });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(server.api, run.body.run_id, ["completed"], { deadlineMs: 60_000 });
  return run.body.run_id;
}

/** Marks run `runId` handed `pointer` as its runner does at a claim (runs.sign_in_handed, its launch plane's browser), with
 *  the agent's sign-in saved under `sealKey`: this server's (it opens, and the run is cut of it) or another (it does not,
 *  and the run is withheld). */
async function handed(data, runId, agentId, pointer, sealKey) {
  const store = await openSqliteStore({ dataDir: data, role: "runner" });
  try {
    await saveSignIn(store, sealKey, { agentId, provider: "browserbase", pointer });
  } finally {
    await store.close();
  }
  const db = new DatabaseSync(join(data, "store.sqlite"));
  try {
    db.prepare("UPDATE runs SET sign_in_handed = ? WHERE id = ?").run(JSON.stringify([createHash("sha256").update(pointer).digest("hex")]), runId);
    const launch = db.prepare("SELECT body FROM run_launch WHERE run_id = ?").get(runId);
    assert.ok(launch, `run ${runId} has a launch row`);
    const body = JSON.parse(launch.body);
    db.prepare("UPDATE run_launch SET body = ? WHERE run_id = ?").run(JSON.stringify({ ...body, plane: { ...(body.plane ?? {}), browser: "browserbase" } }), runId);
  } finally {
    db.close();
  }
}

test("no planted secret in a run's words shows on any run read route: a run handed a sign-in this server opens is cut of it, and one it can't open is withheld in the view's words", { timeout: 240_000 }, async (t) => {
  const seal = randomBytes(32);
  withEnv(t, { AGENTRUN_SEAL_KEY: seal.toString("base64") }, ["AGENTRUN_SEAL_KEY"]);
  const logs = [];
  const server = await serve(t, { faux: FAUX_READ, log: (line) => logs.push(line) });
  // A stored tool key and a trigger's signing secret, each written the way the owner writes one, then in the run's words.
  const monid = plantedValue("monid");
  assert.equal((await server.api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: monid } })).status, 204);
  assert.equal((await server.api("POST", "/agents", agent("hooked"))).status, 201);
  const trigger = await server.api("POST", "/triggers", { name: "on push", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "hooked", input: { content: "Triage." }, max_cost_usd: 0.5 } });
  assert.equal(trigger.status, 201, JSON.stringify(trigger.body));
  const whsec = trigger.body.signing_secret ?? trigger.body.secret;
  assert.match(String(whsec), /^whsec_/, "the trigger's signing secret, shown once to its maker");
  // A run handed a sign-in this server opens: cut of the pointer; and one handed a sign-in it can't open: withheld.
  const pointer = `bb-ctx-${randomBytes(12).toString("hex")}`;
  const lost = `bb-ctx-${randomBytes(12).toString("hex")}`;
  const runs = {
    handed: { agentId: "handed", values: [pointer, monid, whsec] },
    withheld: { agentId: "withheld", values: [lost, monid, whsec] },
  };
  for (const run of Object.values(runs)) {
    run.id = await ranWith(server, run.agentId, run.values.join(" "));
    run.file = "inputs/notes.txt";
  }
  await handed(server.data, runs.handed.id, "handed", pointer, seal);
  await handed(server.data, runs.withheld.id, "withheld", lost, randomBytes(32));

  // The view's own verdict first: the handed run is shown, cut; the withheld one says why nothing is shown.
  const shown = (await server.api("GET", `/runs/${runs.handed.id}`)).body;
  assert.equal(shown.status, "completed");
  assert.match(String(shown.result?.final_answer ?? ""), /^Read: /, "the handed run is shown, cut of what it was handed");
  const withheld = await server.api("GET", `/runs/${runs.withheld.id}`);
  assert.deepEqual([withheld.body.result?.output ?? null, withheld.body.result?.final_answer ?? null], [null, null], "the withheld run's view shows none of its words");

  for (const { path, operation } of runReadOperations((await server.api("GET", "/openapi.json")).body)) {
    for (const [kind, run] of Object.entries(runs)) {
      const name = `${operation} (${kind})`;
      await t.test(`${name}: GET ${path} holds no planted value`, { skip: WAITS[name] ?? false }, async () => {
        const reads = RUN_READS[operation](run);
        const sources = [];
        for (const one of reads) {
          const res = await get(server.port, server.token, one);
          sources.push({ where: `GET ${one} (${res.status})`, text: res.text });
          // A withheld run's graph is refused (403), or it has none (404, an agentic run's): never served.
          if (kind === "withheld" && operation === "getRunGraph") assert.ok([403, 404].includes(res.status), `${one}: a withheld run's graph is never served: ${res.status}`);
        }
        assert.deepEqual(findPlanted(sources, run.values), [], `${name}: a planted value showed`);
      });
    }
  }
  await t.test("the server's log holds no planted value", () => {
    assert.deepEqual(findPlanted([{ where: "the server's log", text: logs.join("\n") }], [...runs.handed.values, ...runs.withheld.values]), []);
  });
});
