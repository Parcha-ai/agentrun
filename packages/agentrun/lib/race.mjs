// `agentrun race start` and `agentrun race show`: one task run side by side on 2 to 4 harness and model lanes, as the
// console's New race form starts one (apps/console lib/race.ts laneStart, RaceStart.tsx) and its race view reads it. Each
// lane is a new agent of its own (POST /agents) with the console's lane instructions and a new agent's default tools on
// this server, and one run of its first revision (POST /agents/{agent_id}/runs) carrying the race's task, cap and labels:
// race:<label>, lane, harness and model. `race show LABEL` reads the runs that label groups (GET /runs?label=race:LABEL).
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

/** Exits: 0 every lane started (start) or the race read (show); 1 a lane not started, the others' runs going on; 2 refused
 *  (a lane, task, cap or label not given as the command takes it). */
const REFUSED = 2;
const RACE_KEY = "race";
const LANE_KEY = "lane";
const MIN_LANES = 2;
const MAX_LANES = 4;
/** Every lane's instructions, as the console's: the task itself is the run's input, the same on every lane. */
const LANE_INSTRUCTIONS = "Do the task you are given.";
/** The tools a run on the runner never names (the browser runs only there) and those it names only where its run
 *  shell runs them: the console's (agentForm.ts RUNNER_ONLY, SANDBOX_ONLY; place.ts RUNNER_SHELL). */
const RUNNER_ONLY = new Set(["browser"]);
const RUNNER_SHELL = new Set(["bash"]);
/** A label's words: what a run label's value takes, and a race's page names. */
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The race view reads at most this many runs of a label: more is a label used for something else too. */
const RACE_READ = 50;

/** A new race's label as the console makes one: when it starts (UTC, to the minute) and 48 random bits. */
export function newRaceLabel(now = new Date(), random = randomUUID) {
  const at = now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  return `${at}-${random().replace(/-/g, "").slice(0, 12)}`;
}

/** `HARNESS/MODEL`: the harness is the word before the first slash, the model all after it (a model id may hold one). */
export function laneOf(text) {
  const at = text.indexOf("/");
  const harness = text.slice(0, at).trim(), model = text.slice(at + 1).trim();
  return at > 0 && harness && model ? { harness, model } : undefined;
}

/** A new agent's tools on this server for `harness`, as the console's race form gives a lane (lib/race.ts laneKit): every
 *  tool its harness runs here that is available (agentForm.ts toolOffers: unless it says it is not), never a workflow's
 *  call-only one, nor a host tool over the run's own (`meta`: tools_search, tools_call, codemode; no grant). Where the server's default place is a
 *  box, a runner-only tool is left out; on the runner, a box-only tool is kept only where the runner's own shell runs it
 *  (GET /computers, the computer none's `shell`: "local"). */
export function laneTools(harness, capabilities, computers) {
  const offers = Array.isArray(capabilities?.tools) ? capabilities.tools : [];
  const sandbox = capabilities?.places?.default_place?.mode === "sandbox";
  const none = (Array.isArray(computers?.kinds) ? computers.kinds : []).find((kind) => kind?.kind === "none");
  const shell = none?.shell === "local" ? RUNNER_SHELL : new Set();
  return offers
    .filter((t) => t && typeof t.name === "string" && t.available !== false && !t.call_only && t.meta !== true && Array.isArray(t.harnesses) && t.harnesses.includes(harness))
    .filter((t) => (sandbox ? !RUNNER_ONLY.has(t.name) && !t.runner_only : !t.sandbox_only || shell.has(t.name)))
    .map((t) => t.name);
}

const jsonBody = (value) => ({ body: Buffer.from(JSON.stringify(value)), type: "application/json" });
const parsed = (bytes) => {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
};

/** One request whose refusal is a value, not an exit: the server's code and message, so one lane's refusal leaves the
 *  others started. Each request has a client of its own, so lanes asked at once never read one another's refusal. A
 *  server not reached throws (cli.request's unreachable). */
async function call(cli, target, io, method, path, value, headers = {}) {
  let said;
  const client = {
    ...cli.clientOf(target, io),
    refused: (response, bytes) => {
      const answer = parsed(bytes);
      said = { status: response.status, code: answer?.error?.code ?? answer?.code ?? `http_${response.status}`, message: answer?.error?.message ?? answer?.message ?? `HTTP ${response.status}` };
      return 1;
    },
  };
  const { bytes, code } = await cli.request(client, { method, path, headers, ...(value === undefined ? {} : jsonBody(value)) });
  return code !== undefined ? { refused: said } : { answer: parsed(bytes) };
}

/** What went wrong with a request that threw, in its own words (an Exit's message names the server not reached). */
const wordsOf = (error) => (error instanceof Error ? error.message : String(error));

function taskOf(value, cli) {
  if (value === undefined) throw cli.fail(REFUSED, "--task TEXT|@FILE is the task every lane runs.");
  let task = value;
  if (value.startsWith("@")) {
    try {
      task = readFileSync(value.slice(1), "utf8");
    } catch (error) {
      throw cli.fail(REFUSED, `--task ${value}: ${error.code === "ENOENT" ? "no such file" : error.message}.`);
    }
  }
  if (!task.trim()) throw cli.fail(REFUSED, "--task is empty: give the task every lane runs.");
  return task.trim();
}

export const RACE_START = {
  command: ["race", "start"],
  pathParams: [],
  summary: "Run one task on 2 to 4 harness and model lanes side by side, as the console's New race form does",
  route: "POST /agents, then POST /agents/{agent_id}/runs, a lane each",
  help: [
    ["--lane HARNESS/MODEL", "a lane, 2 to 4 times: the harness, then its model (pi/anthropic/claude-sonnet-4.5)"],
    ["--task TEXT|@FILE", "the task every lane runs, the same on each"],
    ["--max-cost-usd USD", "each lane's cap (default 1)"],
    ["--label LABEL", "the race's label (default: the start time and random letters, as the console's)"],
    ["--file FILE_ID", "a file uploaded with POST /files, given to every lane's run (repeatable)"],
  ],
  options: { lane: { type: "string", multiple: true }, task: { type: "string" }, "max-cost-usd": { type: "string" }, label: { type: "string" }, file: { type: "string", multiple: true } },
  async run({ values, env, io, cli }) {
    const given = values.lane ?? [];
    const lanes = given.map(laneOf);
    const bad = given.find((_, i) => !lanes[i]);
    if (bad !== undefined) throw cli.fail(REFUSED, `--lane ${bad}: a lane is HARNESS/MODEL, the harness then its model (pi/anthropic/claude-sonnet-4.5).`);
    if (lanes.length < MIN_LANES || lanes.length > MAX_LANES) throw cli.fail(REFUSED, `A race takes ${MIN_LANES} to ${MAX_LANES} lanes (--lane HARNESS/MODEL each), given ${lanes.length}.`);
    const task = taskOf(values.task, cli);
    const cap = values["max-cost-usd"] === undefined ? 1 : Number(values["max-cost-usd"]);
    if (!(Number.isFinite(cap) && cap > 0)) throw cli.fail(REFUSED, `--max-cost-usd ${values["max-cost-usd"]}: each lane's cap is dollars above 0.`);
    const label = values.label ?? newRaceLabel();
    if (!LABEL.test(label)) throw cli.fail(REFUSED, `--label ${label}: a race's label is 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit.`);
    const files = values.file ?? [];
    const reads = {};
    const target = cli.targetOf(values, env);
    // What a new agent gets here: the server's tools for each harness, where its default place is, and the runner's shell.
    // Both are read before any lane starts, as the console's form waits for them: without the computers, a lane on the
    // runner would start without the shell its runner runs.
    for (const path of ["/capabilities", "/computers"]) {
      const read = await call(cli, target, io, "GET", path);
      if (read.refused) throw cli.fail(1, `GET ${path}: ${read.refused.message}. No lane was started.`);
      reads[path] = read.answer;
    }
    // Every lane at once, each on its own: one refused, or cut off, leaves the others started and every lane reported.
    const started = await Promise.all(lanes.map(async (lane, i) => {
      const n = i + 1;
      const said = { lane: n, harness: lane.harness, model: lane.model };
      const definition = { id: `race-${label}-${n}-1`, version: 1, name: `Race ${label}, lane ${n}`, instructions: LANE_INSTRUCTIONS, harness: lane.harness, model: lane.model, tools: laneTools(lane.harness, reads["/capabilities"], reads["/computers"]), skills: [] };
      const agentPath = `/agents/${encodeURIComponent(definition.id)}`;
      let made, run;
      try {
        made = await call(cli, target, io, "POST", "/agents", { definition });
      } catch (error) {
        // No answer: the agent may have been made, but no run of it was asked for.
        return { ...said, error: `its agent was not confirmed made: ${wordsOf(error)}` };
      }
      if (made.refused) return { ...said, error: `${made.refused.code}: ${made.refused.message}` };
      const body = { input: { content: task }, revision: made.answer?.revision, max_cost_usd: cap, labels: { [RACE_KEY]: label, [LANE_KEY]: String(n), harness: lane.harness, model: lane.model }, ...(files.length ? { file_ids: files } : {}) };
      try {
        run = await call(cli, target, io, "POST", `${agentPath}/runs`, body, { "idempotency-key": `race-${label}-${n}` });
      } catch (error) {
        // Asked, with no answer: the run may have started. A refusal is only what the server said.
        return { ...said, agent_id: definition.id, unsure: wordsOf(error) };
      }
      if (run.refused) {
        const refusal = { ...said, agent_id: definition.id, error: `${run.refused.code}: ${run.refused.message}` };
        // A lane's agent is the race's own: one whose run never started is archived, as the console lets one go. An
        // archive that fails is said beside the refusal, never in its place.
        try {
          const archived = await call(cli, target, io, "POST", `${agentPath}/archive`);
          return archived.refused ? { ...refusal, archive: `${archived.refused.code}: ${archived.refused.message}` } : refusal;
        } catch (error) {
          return { ...refusal, archive: wordsOf(error) };
        }
      }
      return { ...said, agent_id: definition.id, run_id: run.answer?.run_id, status: run.answer?.status };
    }));
    io.stdout.write(`${JSON.stringify({ label, filter: `${RACE_KEY}:${label}`, console: `#/races/${encodeURIComponent(label)}`, lanes: started }, null, 2)}\n`);
    for (const lane of started) {
      const name = `Lane ${lane.lane} (${lane.harness}/${lane.model})`;
      if (lane.error) io.stderr.write(`${name} did not start: ${lane.error}${lane.archive ? ` (its agent was not archived: ${lane.archive})` : ""}\n`);
      if (lane.unsure) io.stderr.write(`${name} may have started: its start had no answer (${lane.unsure}). See agentrun race show ${label}.\n`);
    }
    return started.some((lane) => lane.error || lane.unsure) ? 1 : 0;
  },
};

/** A lane's seconds: from its run's start to its end, or to now while it goes. */
const secondsOf = (run, now) => {
  const from = Date.parse(run.created_at), to = run.ended_at ? Date.parse(run.ended_at) : now;
  return Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, Math.round((to - from) / 1000)) : null;
};

export const RACE_SHOW = {
  command: ["race", "show"],
  pathParams: ["label"],
  summary: "A race's lanes: each lane's harness, model, run, status, cost and seconds, in lane order",
  route: "GET /runs?label=race:LABEL",
  help: [["LABEL", "the race's label, as race start printed it"]],
  options: {},
  async run({ args, values, env, io, cli }) {
    const label = args[0];
    if (!LABEL.test(label)) throw cli.fail(REFUSED, `${label}: a race's label is 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit.`);
    const query = new URLSearchParams({ limit: String(RACE_READ), label: `${RACE_KEY}:${label}` });
    const read = await call(cli, cli.targetOf(values, env), io, "GET", `/runs?${query}`);
    if (read.refused) throw cli.fail(1, `GET /runs: ${read.refused.message}`);
    const runs = Array.isArray(read.answer?.runs) ? read.answer.runs : [];
    if (!runs.length) throw cli.fail(REFUSED, `No run carries the label ${RACE_KEY}:${label}.`);
    const now = Date.now();
    const lane = (run) => Number(run.labels?.[LANE_KEY]);
    const lanes = [...runs].sort((a, b) => (lane(a) || Infinity) - (lane(b) || Infinity) || String(a.created_at).localeCompare(String(b.created_at)))
      .map((run) => ({ lane: run.labels?.[LANE_KEY] ?? null, harness: run.labels?.harness ?? null, model: run.labels?.model ?? null, run_id: run.run_id, status: run.status, cost_usd: run.cost?.usd ?? null, cap_usd: run.cost?.cap_usd ?? null, seconds: secondsOf(run, now) }));
    io.stdout.write(`${JSON.stringify({ label, lanes, ...(read.answer?.next_cursor ? { more: true } : {}) }, null, 2)}\n`);
    return 0;
  },
};
