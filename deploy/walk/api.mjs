// The walks' API client, run inside the server's container (`docker compose exec -T server node /walk/api.mjs ...`),
// where the server listens on its own address (`server`), with the token the server keeps in /data/.token. One command
// per call; each prints one JSON line. A wait polls every 250 ms until what it waits for holds, and fails after its bound.
//   agent                          make the walk's agent (pi, the runner's place, the write tool) -> {agent}
//   start <agent> <steps> <ms>     start a run of it                                          -> {run}
//   run <run>                      the run's status, state and claim                          -> {status, state, claim}
//   claimed <run> [not-runner]     wait until a runner (other than not-runner) holds the run  -> {claim, at}
//   step <run> <k>                 wait until the run's step k is done (step-k.txt written)   -> {files, at}
//   end <run>                      wait until the run ends; its steps and files               -> {status, steps, files}
import { readFileSync } from "node:fs";

const BASE = "http://server:7340/v2";
const token = readFileSync("/data/.token", "utf8").trim();
const [command, ...args] = process.argv.slice(2);
const fail = (why) => {
  console.error(`walk api: ${why}`);
  process.exit(1);
};

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) fail(`${method} ${path} answered ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function until(what, seconds, check) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const found = await check();
    if (found) return found;
    if (Date.now() > end) fail(`${what}: not within ${seconds} s`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const files = async (run) => {
  const listed = await call("GET", `/runs/${run}/files`);
  const all = listed.files ?? [];
  return all.map((f) => f.path).filter((p) => /^step-\d+\.txt$/.test(p)).sort();
};

/** The run's write calls by step, from its timeline: the `tool_use` rows of `write` for each step-k.txt (a step done
 *  twice would be two), and the `tool_result` rows that answer them. */
async function steps(run) {
  const rows = [];
  for (let after = 0; ; ) {
    const page = await call("GET", `/runs/${run}/timeline?after=${after}`);
    rows.push(...page.rows);
    if (!page.has_more) break;
    after = page.next_after;
  }
  const writes = rows.filter((row) => row.kind === "tool_use" && row.tool_name === "write");
  const ids = new Map(writes.map((row) => [row.tool_use_id, /step-(\d+)\.txt/.exec(JSON.stringify(row))?.[1] ?? "?"]));
  const calls = {};
  for (const step of ids.values()) calls[step] = (calls[step] ?? 0) + 1;
  const answered = rows.filter((row) => row.kind === "tool_result" && ids.has(row.tool_use_id)).length;
  return { calls, answered, rows: rows.length };
}

const ENDED = ["completed", "failed", "cancelled"];
let out;
if (command === "agent") {
  const made = await call("POST", "/agents", {
    definition: { name: "walk-steps", instructions: "Do each step the model asks for.", harness: "pi", tools: ["write"], place: { mode: "runner" } },
  });
  out = { agent: made.agent_id };
} else if (command === "start") {
  const [agent, n, ms] = args;
  const made = await call("POST", `/agents/${agent}/runs`, { input: { content: `walk: ${n} steps of ${ms} ms` } });
  out = { run: made.run_id };
} else if (command === "run") {
  const run = await call("GET", `/runs/${args[0]}`);
  out = { status: run.status, state: run.state, claim: run.claim, error: run.error ?? null };
} else if (command === "claimed") {
  const [id, not] = args;
  out = await until(`a runner${not ? ` other than ${not}` : ""} holds ${id}`, 120, async () => {
    const run = await call("GET", `/runs/${id}`);
    if (ENDED.includes(run.status)) fail(`run ${id} ended ${run.status} before it was claimed: ${JSON.stringify(run.error ?? null)}`);
    return run.claim && run.claim.runner !== not ? { claim: run.claim, at: Date.now() } : undefined;
  });
} else if (command === "step") {
  const [id, k] = args;
  out = await until(`step ${k} of ${id} done`, 300, async () => {
    const run = await call("GET", `/runs/${id}`);
    if (ENDED.includes(run.status)) fail(`run ${id} ended ${run.status} before step ${k}: ${JSON.stringify(run.error ?? null)}`);
    const have = await files(id);
    return have.includes(`step-${k}.txt`) ? { files: have, claim: run.claim, at: Date.now() } : undefined;
  });
} else if (command === "end") {
  const [id] = args;
  const run = await until(`run ${id} ends`, 300, async () => {
    const run = await call("GET", `/runs/${id}`);
    return ENDED.includes(run.status) ? run : undefined;
  });
  out = { status: run.status, state: run.state, claim: run.claim, error: run.error ?? null, result: run.result ?? null, steps: await steps(id), files: await files(id) };
} else fail(`unknown command ${JSON.stringify(command)}`);
console.log(JSON.stringify(out));
