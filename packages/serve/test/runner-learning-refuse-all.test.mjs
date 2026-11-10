// The runner's learning end refuses every secret the server keeps, as far as the runner can read it (runner/learning-end.ts
// refuse: the runner's own secrets, what the claim handed the run, the sign-in pointers it was handed, and every value the
// server keeps sealed, runner/store-secrets.ts storeSecrets: the store's planes and the server's files beside it), the
// server's whole list (server.ts serverSecrets) and not only the keys a claim hands its run. A run through a real runner
// and the pi spec builder (adapter-run-spec.ts adapterRunSpecFromLaunch), whose person's words and end-of-run answer quote
// a webhook trigger's signing secret with no shape a check knows, the GitHub App's webhook secret, an MCP server's bearer
// header, a key saved on the server (one the run is not handed), the server's API token and its session secret, learns
// none of them: not in the agent's learning folder, not in the run's kept learning, not in what its learning run's grader
// is shown. A webhook trigger's secret is refused by its value as the store holds it now (after a rotation, the new one),
// and another server's whsec_ secret by its shape (trigger-secrets-learning.test.mjs, moved onto the runner).
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { seal } from "@parcha/pi-durable-agent";
import { closeOpenSessions, MODEL, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore, sealMcpCredential } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { learningLoopFactory } = await import("../dist/runner/learning-factory.js");
const { seedOf } = await import("../dist/learning.js");
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
const note = (name, body) => `---\nname: ${name}\ndescription: ${name}\ntype: reference\n---\n${body}\n`;
const CLEAN = note("Retry slowly", "Wait a little longer after each failed call.");
/** The grader keeps every item it is shown. */
const KEEP = JSON.stringify({ merge: true, reason: "Worth keeping.", items: [{ file: "keys.md", decision: "keep", why: "useful" }, { file: "retry-slowly.md", decision: "keep", why: "useful" }] });

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

/** A learning agent's run through a real runner on the pi spec builder, after `plant(server, dir)` keeps the secrets it
 *  gives back; the person's words and the run's end-of-run answer (a note `keys.md` and a clean one) quote each of them.
 *  Its learning run, when it queues one, runs on the learning loop, whose grader keeps everything and records what it
 *  is shown. Resolves with its kept learning, the learning folder's files and the grader's prompts. */
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
  await server.agents.create({ id: AGENT, name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  const values = await plant(server, dir);
  const quoted = values.join(" and ");
  const seed = await seedOf(dir, AGENT);
  const launch = { input: { content: `Use ${quoted} for the call.` }, title: "t", place: { mode: "runner" }, model: { provider: "anthropic", modelId: "claude-sonnet-5.5" }, learning: { given: [], seed: seed.sha, section: "", seedNotes: 0 } };
  await server.runs.create({ id: RUN, agentId: AGENT, revisionId: "rev-1" }, { body: launch });
  await server.flush?.();

  const reflected = `\`\`\`note keys.md\n${note("Keys", `Call it with ${quoted}.`)}\`\`\`\n\n\`\`\`note retry-slowly.md\n${CLEAN}\`\`\`\n\nReflected.`;
  const provider = { api: "anthropic-messages", origin: "https://route.invalid", credential: () => `not-a-secret-${"x"}` };
  const routeOf = async () => ({ model: MODEL, provider, price: () => 0, fetch: scriptedOrigin([{ say: `Called it with ${quoted}.` }, { say: reflected }]) });
  const deps = { env: {}, data: dir, journal: (c) => store.journal(c), store, sealKey: SEAL_KEY, routeOf, computerForClaim: async () => ({ release: async () => {} }) };
  const prompts = [];
  const createLoop = (loopDeps) => {
    const job = createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(launch, run, deps, claim))(loopDeps);
    const learn = learningLoopFactory({ refuse: async () => [], store, data: dir, ask: async ({ prompt }) => (prompts.push(prompt), { text: KEEP, usd: 0 }) })(loopDeps);
    return {
      start: (claim) => (claim.runId === RUN ? job.start(claim) : learn.start(claim)),
      command: (row) => job.command(row),
      stop: async (reason) => {
        await learn.stop?.(reason);
        return job.stop(reason);
      },
    };
  };
  runner = startRunner({ store, createLoop, name: "runner-a", ...TIMING });

  const until = async (check, what) => {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const found = await check();
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`not within ${WAIT_MS} ms: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  await until(async () => {
    const row = await server.runs.get(RUN);
    return row.state === "ended" && row.runner === null;
  }, "run-1 ended");
  const kept = await server.learning.proposal(RUN);
  if (kept?.learningRunId) await until(async () => (await server.runs.get(kept.learningRunId))?.state === "ended", "its learning run ended");
  return { values, kept: await server.learning.proposal(RUN), files: folderFiles(dir), prompts };
}

/** Each value `values` names that `text` holds. */
const held = (values, text) => values.filter((value) => text.includes(value));

/** The run learned none of `values`, anywhere: its kept learning, the learning folder, the grader's input. */
function learnedNone({ values, kept, files, prompts }) {
  assert.ok(kept, "the run kept its learning's end");
  assert.deepEqual(held(values, JSON.stringify(kept)), [], `its kept learning holds a secret: ${JSON.stringify(kept).slice(0, 800)}`);
  for (const [path, text] of Object.entries(files)) assert.deepEqual(held(values, text), [], `${path} holds a secret`);
  for (const prompt of prompts) assert.deepEqual(held(values, prompt), [], "the grader is shown a secret");
}

/** The run's learning was refused whole by the checks, for `rule` among its problems (said in its detail). */
function refusedFor(kept, rule) {
  assert.deepEqual([kept?.proposal?.state, kept?.proposal?.reason], ["dropped", "checker"], JSON.stringify(kept?.proposal));
  const rules = (kept.proposal.problems ?? []).map((problem) => problem.rule);
  assert.ok(rules.includes(rule), `${rule} among the problems: ${JSON.stringify(kept.proposal)}`);
}

test("a run quoting, in its words and its end-of-run answer, a webhook trigger's shapeless signing secret, the GitHub App's webhook secret, an MCP server's bearer header, a key saved on the server, the API token and the session secret learns none of them", { timeout: 120_000 }, async (t) => {
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
  refusedFor(learned.kept, "secret_value");
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
  refusedFor(learned.kept, "secret_value");
});

test("another server's whsec_ secret, which this store never held, is refused by its shape", { timeout: 120_000 }, async (t) => {
  const learned = await learnedQuoting(t, async () => [`whsec_${randomBytes(32).toString("base64")}`]);
  learnedNone(learned);
  refusedFor(learned.kept, "secret_shape");
});
