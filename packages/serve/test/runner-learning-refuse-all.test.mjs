// The runner's learning end refuses every secret the server keeps, as far as the runner can read it (runner/learning-end.ts
// refuse: the runner's own secrets, what the claim handed the run, the sign-in pointers it was handed, and every value the
// server keeps sealed, runner/store-secrets.ts storeSecrets: the store's planes and the server's files beside it), the
// server's whole list (server.ts serverSecrets) and not only the keys a claim hands its run. A run through a real runner
// and the pi spec builder (adapter-run-spec.ts adapterRunSpecFromLaunch), whose input, owner's correction and compile
// drafts quote a webhook trigger's signing secret with no shape a check knows, the GitHub App's webhook secret, an MCP
// server's bearer header, a key saved on the server (one the run is not handed), the server's API token and its session
// secret, learns none of them: not in the agent's learning folder, not in the run's kept learning, not in what its compile
// turn is asked. A webhook trigger's secret is refused by its value as the store holds it now (after a rotation, the new
// one), and another server's whsec_ secret by its shape (trigger-secrets-learning.test.mjs, moved onto the runner).
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { seal } from "../dist/sealing.js";
import { closeOpenSessions, MODEL, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { mergesOf, repoOf } from "./learn-support.mjs";

const { openSqliteStore, sealMcpCredential } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { learningEndOfRun } = await import("../dist/runner/learning-end.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { learningFolderOf, seedOf } = await import("../dist/learning.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { sealedSettingsOverStore } = await import("../dist/sealed-settings-store.js");
const { webhook } = await import("../dist/trigger-webhook.js");
const { TOKEN_FILE } = await import("../dist/files.js");
const { SESSION_SECRET_FILE } = await import("../dist/owner.js");
const { agentLearningFolder } = await import("../dist/workspace/index.js");

after(closeOpenSessions);

const SEAL_KEY = Buffer.alloc(32, 7);
const AGENT = "agent-1";
const RUN = "run-1";
const TIMING = { leaseMs: 60_000, renewEveryMs: 20_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const WAIT_MS = 30_000;
/** A planted value: distinct per secret, long enough to be a key, built for the test and no real one. */
const planted = (name) => `planted${name}${"q8".repeat(12)}`;
/** A trigger setting written as the store-backed settings write one (sealed-settings-store.ts), any field's value. */
const putSetting = (server, adapter, scope, field, value) => server.triggerSettings.put({ adapter, scope, field, sealed: seal(SEAL_KEY, Buffer.from(value, "utf8"), `trigger_settings|${adapter}|${scope}|${field}`).toString("base64") });
/** A compile draft of workflow `answer` whose README description quotes `quoted` (the agent's one tool is `read`). */
const draft = (quoted) => `\`\`\`\`workflow answer\n---\ndescription: Calls it with ${quoted}; use when asked\nexample: {"content":"What is six times seven?"}\n---\n${JSON.stringify({
  v: 2, name: "answer",
  schemas: { In: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }, Answer: { type: "object", properties: { answer: { type: "number" }, confidence: { type: "number" } }, required: ["answer", "confidence"] } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" }] },
})}\n\`\`\`\``;
/** The compile turn's own asks among the model's requests: its first ask and every "try again". */
const compileAsks = (requests) => requests.flatMap((body) => (body.messages ?? []).filter((message) => message.role === "user").map((message) => (typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join(""))))
  .filter((text) => text.startsWith("One more turn:") || text.startsWith("Your workflow draft did not pass the checks"));

/** Every file of the agent's learning folder but git's own (its working tree, `.agentrun/snapshot.json`), by path. */
function folderFiles(dir) {
  const files = {};
  const walk = (at) => {
    let names;
    try {
      names = readdirSync(at);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === ".git") continue;
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[path] = readFileSync(path, "utf8");
    }
  };
  walk(agentLearningFolder(dir, AGENT));
  return files;
}

/** A learning agent's run (due to compile at every run) through a real runner on the pi spec builder, after
 *  `plant(server, dir)` keeps the secrets it gives back; its input, its owner's feedback (queued before the claim) and
 *  every compile draft quote each of them. Resolves with its kept learning, the learning folder's files, the compile
 *  turn's asks and the run's merges on main. */
async function learnedQuoting(t, plant) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-learning-refuse-all-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: AGENT, name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: { compile_after: 1 } } });
  const values = await plant(server, dir);
  const quoted = values.join(" and ");
  const seed = await seedOf(dir, AGENT);
  const launch = { input: { content: `Use ${quoted} for the call.` }, title: "t", place: { mode: "runner" }, model: { provider: "anthropic", modelId: "claude-sonnet-5.5" }, learning: { seed: seed.sha, section: "" } };
  await server.runs.create({ id: RUN, agentId: AGENT, revisionId: "rev-1" }, { body: launch });
  await sendCommand(server, RUN, { kind: "steer", body: { text: `Next time call it with ${quoted}.` } });
  await server.flush?.();

  const leaky = draft(quoted);
  const requests = [];
  const provider = { api: "anthropic-messages", origin: "https://route.invalid", credential: () => `not-a-secret-${"x"}` };
  const routeOf = async () => ({ model: MODEL, provider, price: () => 0, fetch: scriptedOrigin([{ say: `Called it with ${quoted}.` }, { say: "Noted." }, { say: leaky }, { say: leaky }, { say: leaky }, { say: leaky }], requests) });
  const deps = { env: {}, data: dir, journal: (c) => store.journal(c), store, sealKey: SEAL_KEY, routeOf, computerForClaim: async () => ({ release: async () => {} }) };
  const endOfRun = learningEndOfRun(launch, { store, data: dir, env: {}, learningFolder: (agentId) => learningFolderOf(dir, agentId) });
  const createLoop = (loopDeps) => createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(launch, run, deps, claim))({ ...loopDeps, endOfRun });
  runner = startRunner({ store, createLoop, name: "runner-a", ...TIMING });

  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const row = await server.runs.get(RUN);
    if (row.state === "ended" && row.runner === null) break;
    if (Date.now() > deadline) throw new Error(`not within ${WAIT_MS} ms: run-1 ended`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { values, kept: await server.learning.proposal(RUN), files: folderFiles(dir), asks: compileAsks(requests), merges: mergesOf(repoOf(dir, AGENT), RUN) };
}

/** Each value `values` names that `text` holds. */
const held = (values, text) => values.filter((value) => text.includes(value));

/** The run learned none of `values`, anywhere: its kept learning, the learning folder, the compile turn's asks. */
function learnedNone({ values, kept, files, asks }) {
  assert.ok(kept, "the run kept its learning's end");
  assert.deepEqual(held(values, JSON.stringify(kept)), [], `its kept learning holds a secret: ${JSON.stringify(kept).slice(0, 800)}`);
  for (const [path, text] of Object.entries(files)) assert.deepEqual(held(values, text), [], `${path} holds a secret`);
  assert.ok(asks.length > 0, "the compile turn was asked");
  for (const ask of asks) assert.deepEqual(held(values, ask), [], `the compile turn is shown a secret: ${ask.slice(0, 400)}`);
}

/** The run's learning was refused whole by the checks, for `rule` among its problems (said in its detail): its correction
 *  refused, every draft refused, nothing merged. */
function refusedFor({ kept, merges }, rule) {
  assert.deepEqual([kept?.proposal?.state, kept?.proposal?.reason], ["dropped", "checker"], JSON.stringify(kept?.proposal));
  const rules = (kept.proposal.problems ?? []).map((problem) => problem.rule);
  assert.ok(rules.includes(rule), `${rule} among the problems: ${JSON.stringify(kept.proposal)}`);
  assert.ok((kept.proposal.compiled?.attempts ?? []).length > 0 && kept.proposal.compiled.attempts.every(({ ok }) => !ok), `every draft refused: ${JSON.stringify(kept.proposal.compiled)}`);
  assert.deepEqual(merges, [], "nothing merged");
}

test("a run quoting, in its input, its owner's correction and its drafts, a webhook trigger's shapeless signing secret, the GitHub App's webhook secret, an MCP server's bearer header, a key saved on the server, the API token and the session secret learns none of them", { timeout: 120_000 }, async (t) => {
  const learned = await learnedQuoting(t, async (server, dir) => {
    const [hook, github, bearer, saved, token, session] = ["hookplain", "githubhook", "mcpbearer", "savedkey", "apitoken", "sessionsecret"].map(planted);
    await putSetting(server, webhook.id, "trg-1", "secret", hook);
    await putSetting(server, "github", "server", "webhook_secret", github);
    const url = "https://mcp.invalid/mcp";
    await server.mcp.put({ name: "headers", url, auth: "bearer", tools: [], sealed: sealMcpCredential(SEAL_KEY, "headers", { type: "headers", headers: { authorization: `Bearer ${bearer}` } }, url) });
    await putSealedKey(server, SEAL_KEY, "MONID_API_KEY", saved);
    writeFileSync(join(dir, TOKEN_FILE), `${token}\n`);
    writeFileSync(join(dir, SESSION_SECRET_FILE), `${session}\n`);
    return [hook, github, bearer, saved, token, session];
  });
  learnedNone(learned);
  refusedFor(learned, "secret_value");
});

test("a webhook trigger's signing secret is refused by the value the store holds; after a rotation, by the new one", { timeout: 120_000 }, async (t) => {
  let rotated;
  const learned = await learnedQuoting(t, async (server) => {
    const settings = sealedSettingsOverStore(server, webhook.id, webhook.settings, SEAL_KEY, () => {});
    await settings.load();
    const first = await settings.mint("trg-1", "secret");
    rotated = await settings.mint("trg-1", "secret");
    assert.notEqual(rotated, first);
    return [rotated];
  });
  learnedNone(learned);
  refusedFor(learned, "secret_value");
});

test("another server's whsec_ secret, which this store never held, is refused by its shape", { timeout: 120_000 }, async (t) => {
  const learned = await learnedQuoting(t, async () => [`whsec_${randomBytes(32).toString("base64")}`]);
  learnedNone(learned);
  refusedFor(learned, "secret_shape");
});
