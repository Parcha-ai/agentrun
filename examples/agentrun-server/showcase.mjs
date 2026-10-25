#!/usr/bin/env node
// Seeds a running AgentRun Server with the showcase agents in showcase.json, through its /v2 API only: each agent and
// its revisions in order (the last is current), then, with --runs, every sample run on the revision it names, waited
// for until it is final. An agent that already has its revisions is left as it is, so a second seed starts nothing new
// but the runs. The token comes from AGENTRUN_API_KEY, or from the file --token-file names (the server's own
// DIR/.token, from inside its container), never from the command line.
//
//   AGENTRUN_API_KEY=... node examples/agentrun-server/showcase.mjs [--url http://127.0.0.1:7340] [--runs] [--only <agent id>]
//   node examples/agentrun-server/showcase.mjs --token-file /data/.token --runs
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { url: { type: "string", default: "http://127.0.0.1:7340" }, runs: { type: "boolean", default: false }, only: { type: "string" }, parallel: { type: "string", default: "4" }, "token-file": { type: "string" } } });
const token = values["token-file"] ? (await readFile(values["token-file"], "utf8")).trim() : process.env.AGENTRUN_API_KEY;
if (!token) {
  console.error("Set AGENTRUN_API_KEY to the server's token (the AGENTRUN_API_KEY line it prints), or pass --token-file DIR/.token.");
  process.exit(2);
}
const base = `${values.url.replace(/\/+$/, "")}/v2`;
const showcase = JSON.parse(await readFile(new URL("./showcase.json", import.meta.url), "utf8"));

async function api(method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok && res.status !== 404) throw new Error(`${method} ${path}: ${res.status} ${data?.error?.message ?? ""}`);
  return { status: res.status, etag: res.headers.get("etag"), data };
}

/** The agent's revisions, oldest first: the showcase's revision n is the n-th. */
async function revisionsOf(id) {
  const { data } = await api("GET", `/agents/${encodeURIComponent(id)}/revisions?limit=100`);
  return data.revisions.slice().reverse();
}

async function seedAgent(agent) {
  const id = agent.revisions[0].definition.id;
  const found = await api("GET", `/agents/${encodeURIComponent(id)}`);
  let revisions = found.status === 404 ? [] : await revisionsOf(id);
  if (revisions.length >= agent.revisions.length) {
    console.log(`${id}: has its ${agent.revisions.length} revision(s)`);
    return revisions;
  }
  if (revisions.length) throw new Error(`${id} exists with ${revisions.length} of the showcase's ${agent.revisions.length} revisions; seed it into an empty server, or delete nothing and pick another --url`);
  const [first, ...rest] = agent.revisions;
  let { etag } = await api("POST", "/agents", first);
  for (const next of rest) {
    const { definition, ...more } = next;
    const { id: _id, name: _name, description: _description, ...changed } = definition;
    ({ etag } = await api("PUT", `/agents/${encodeURIComponent(id)}/definition`, { definition: changed, ...more }, { "if-match": etag }));
  }
  revisions = await revisionsOf(id);
  console.log(`${id}: ${revisions.length} revision(s), current ${revisions.at(-1).revision.slice(0, 12)}`);
  return revisions;
}

async function finished(runId) {
  for (;;) {
    const { data } = await api("GET", `/runs/${runId}`);
    if (["completed", "failed", "cancelled"].includes(data.status)) return data;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

const agents = showcase.agents.filter((agent) => !values.only || agent.revisions[0].definition.id === values.only);
const jobs = [];
for (const agent of agents) {
  const revisions = await seedAgent(agent);
  if (!values.runs) continue;
  const id = agent.revisions[0].definition.id;
  for (const run of agent.runs) jobs.push({ id, note: agent.revisions[run.revision].note, revision: revisions[run.revision].revision, input: run.input });
}

let failed = 0;
const queue = [...jobs];
async function worker() {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const { data } = await api("POST", `/agents/${encodeURIComponent(job.id)}/runs`, { input: job.input, revision: job.revision });
    const done = await finished(data.run_id);
    if (done.status !== "completed") failed++;
    const said = done.result?.final_answer ?? JSON.stringify(done.result?.output ?? done.error?.message ?? "");
    const cost = done.cost?.usd == null ? "-" : `$${done.cost.usd.toPrecision(2)}`;
    console.log([job.id, job.note.slice(0, 32), done.status, cost, String(said).replace(/\s+/g, " ").slice(0, 80)].join(" | "));
  }
}
await Promise.all(Array.from({ length: Math.max(1, Number(values.parallel) || 1) }, worker));
if (values.runs) console.log(`${jobs.length} run(s), ${failed} not completed`);
process.exit(failed ? 1 : 0);
