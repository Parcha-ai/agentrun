// A run on claude-agent through serve, on the real pinned Agent SDK and Claude CLI (a dev dependency here), against a
// fake Anthropic Messages endpoint on loopback (no key, no network): its requests go through the adapter's proxy to
// ANTHROPIC_BASE_URL's origin with the native model id, each paid request is booked once at serve's catalog price, and
// the CLI runs under the run's confinement (setpriv's no_new_privs, as pi's commands do, under the same user), in the
// session's private directory, with no key and no server variable in its environment. A run whose process dies while a
// request is in flight resumes on the next process, books the cut request once as unknown, and leaves no CLI behind.
// Every process the test reads is its own descendant.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { agent, follow, serve } from "./support.mjs";

/** A key for the fake endpoint: no real one. */
const KEY = `not-a-secret-${"anthropic"}`;
const MODEL = "claude-haiku-4-5";
/** claude-haiku-4-5 in serve's catalog: $1 in, $5 out per million tokens. */
const PRICE = { input: 1, output: 5 };

/** This test's own descendant processes, by walking each process's children from this one. */
async function descendants() {
  const out = [];
  const queue = [process.pid];
  while (queue.length) {
    const pid = queue.shift();
    for (const task of await readdir(`/proc/${pid}/task`).catch(() => [])) {
      for (const child of (await readFile(`/proc/${pid}/task/${task}/children`, "utf8").catch(() => "")).split(" ").filter(Boolean)) {
        out.push(Number(child));
        queue.push(Number(child));
      }
    }
  }
  return out;
}

/** The test's own descendant that runs the pinned Claude CLI. */
async function claudeProcess() {
  for (const pid of await descendants()) {
    const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0");
    if (argv.some((arg) => /claude-agent-sdk-[a-z0-9-]+\/claude$/.test(arg))) return pid;
  }
  return undefined;
}
const field = (status, name) => new RegExp(`^${name}:\\s+(.*)$`, "m").exec(status)?.[1]?.trim();
/** Whether `pid` still runs: a zombie, waiting to be reaped, does not. */
const alive = processAlive;

/** serve on the fake endpoint, with the env restored after. */
async function claudeServe(t, fake, env = {}, model = MODEL) {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  delete process.env.AGENT_MODEL_BASE_URL;
  Object.assign(process.env, { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: fake.url, AGENT_MODEL: `anthropic/${model}` }, env);
  const served = await serve(t, { faux: undefined });
  assert.equal((await served.api("POST", "/agents", agent("claude", { harness: "claude-agent", model: `anthropic/${model}` }))).status, 201);
  return served;
}

/** A fake endpoint whose first answer waits until `release`. */
async function heldFake(t) {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  t.after(() => release());
  let first = true;
  const fake = await fakeAnthropic({
    reply: () => {
      if (!first) return { text: "Claude answered." };
      first = false;
      return { hold: held, then: { text: "Claude answered." } };
    },
  });
  t.after(() => fake.close());
  return { fake, release };
}

const untilRequest = async (fake) => {
  for (let i = 0; fake.messages().length === 0; i++) {
    assert.ok(i < 600, "a model request reaches the endpoint");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

/** The files under `dir`, by relative path. */
async function filesUnder(dir, at = "") {
  const out = [];
  for (const entry of await readdir(join(dir, at), { withFileTypes: true }).catch(() => [])) {
    const path = join(at, entry.name);
    if (entry.isDirectory()) out.push(path, ...(await filesUnder(dir, path)));
    else out.push(path);
  }
  return out;
}

test("a run on claude-agent: through the adapter's proxy with the native model, each request booked once at serve's price, the CLI confined, in its own directory, with no key in its environment", { timeout: 180_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const { fake, release } = await heldFake(t);
  const { api, data } = await claudeServe(t, fake);
  assert.deepEqual((await api("GET", "/capabilities")).body.harnesses.find((h) => h.id === "claude-agent"), { id: "claude-agent", available: true, steer: false });
  const run = await api("POST", "/agents/claude/runs", { input: { content: "Say what you did." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const runId = run.body.run_id;
  await untilRequest(fake);
  // Mid-turn, with the endpoint holding its first answer: the CLI's process, its rights, its directory, its environment.
  const cli = await claudeProcess();
  assert.ok(cli, "the Claude CLI runs, under this test");
  const status = await readFile(`/proc/${cli}/status`, "utf8");
  assert.equal(field(status, "NoNewPrivs"), "1", "under setpriv --no-new-privs, as pi's commands are");
  assert.equal(field(status, "Uid")?.split(/\s+/)[0], String(process.getuid()), "as the run's own user");
  const cwd = await readlink(`/proc/${cli}/cwd`);
  assert.ok(cwd.startsWith(join(data, "runs", runId, "harness")), `the CLI works in the session's private directory, not the workspace: ${cwd}`);
  const environ = (await readFile(`/proc/${cli}/environ`, "utf8")).split("\0").filter(Boolean);
  assert.ok(!environ.some((line) => line.includes(KEY)), "the key never reaches the CLI");
  assert.deepEqual(environ.filter((line) => /^(ANTHROPIC_API_KEY|AGENTRUN_[A-Z_]*)=/.test(line)).map((line) => line.split("=")[0]), [], "nor the server's variables");
  // The CLI's endpoint is the session's own proxy on loopback, never the endpoint the server holds the key for.
  const base = environ.find((line) => line.startsWith("ANTHROPIC_BASE_URL="))?.slice("ANTHROPIC_BASE_URL=".length);
  assert.ok(base === undefined || (new URL(base).hostname === "127.0.0.1" && new URL(base).origin !== new URL(fake.url).origin), `the CLI talks to the session's proxy: ${base}`);
  release();
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 120_000 });
  const asked = fake.messages();
  assert.ok(fake.requests.every((r) => !r.refused), "no request was refused and retried");
  assert.ok(asked.every((m) => m.path === "/v1/messages" && m.authorized && m.model === MODEL), `Anthropic Messages, with the key, the native id: ${asked.map((m) => m.model).join(", ")}`);
  const usage = rows.findLast((r) => r.kind === "usage")?.usage;
  assert.equal(usage?.requests, asked.length, "each request the endpoint answered is one booked request, once");
  // The endpoint reports a response's input as its request body's length over 4, and 12 output tokens.
  const expected = asked.reduce((sum, m) => sum + Math.ceil(JSON.stringify(m.body).length / 4) * PRICE.input + 12 * PRICE.output, 0) / 1e6;
  assert.equal(usage?.usd, Math.round(expected * 1e6) / 1e6, "each response's input and output at serve's catalog price");
  const left = (await filesUnder(join(data, "runs", runId, "work"))).filter((path) => path.startsWith(".claude") || path.endsWith(".jsonl"));
  assert.deepEqual(left, [], "no CLI file in the run's workspace");
});

test("a claude-agent run whose process dies while a request is in flight resumes on the next process: the cut request booked once as unknown, a chat sent meanwhile answered, and no CLI left behind", { timeout: 240_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const { fake } = await heldFake(t);
  const { api, data } = await claudeServe(t, fake);
  const run = await api("POST", "/agents/claude/runs", { input: { content: "Say what you did." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const runId = run.body.run_id;
  await untilRequest(fake);
  const cli = await claudeProcess();
  assert.ok(cli, "the Claude CLI runs, under this test");
  // Accepted while the request is in flight: it waits for the turn, and outlives the process.
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "And then?" })).status, 202);
  const { holder } = JSON.parse(await readFile(join(data, "runs", runId, "run.json"), "utf8"));
  process.kill(holder.pid, "SIGKILL");
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 180_000 });
  assert.deepEqual(rows.filter((r) => r.kind === "user_message").map((r) => r.text), ["Say what you did.", "And then?"]);
  assert.equal(rows.filter((r) => r.kind === "user_message" || r.kind === "final_answer").at(-1)?.kind, "final_answer", "the chat is answered");
  const usage = rows.findLast((r) => r.kind === "usage")?.usage;
  assert.equal(usage?.requests, fake.messages().length, "every request the endpoint saw is booked once, the cut one included");
  assert.equal(usage?.usd, null, "the cut request's cost is unknown, so the run's is: never 0");
  t.after(() => alive(cli) && process.kill(cli, "SIGKILL"));
  // The CLI starts under the run's prefix (setpriv --pdeathsig KILL): it dies with the process that started it.
  for (let i = 0; alive(cli); i++) {
    assert.ok(i < 20, `the dead process's CLI (pid ${cli}) is gone within 2 s`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

/** A request's system prompt, as text. */
const systemText = (body) => (typeof body?.system === "string" ? body.system : (body?.system ?? []).map((block) => block?.text ?? "").join("\n"));
/** Whether `text` is anywhere in a request's body, as its JSON writes it. */
const holds = (body, text) => JSON.stringify(body).includes(JSON.stringify(text).slice(1, -1));

test("a claude-agent run's skills: one the adapter takes is the Skill tool's (agentrun:<name>) and not in the system prompt until the model loads it, while one it would refuse (no front matter) stays inlined", { timeout: 180_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const CITE = `not-a-secret-${"cite"}-skill-body`;
  const LEGACY = `not-a-secret-${"legacy"}-skill-body`;
  let loaded = false;
  const fake = await fakeAnthropic({
    reply: (request) => {
      // The first turn offered the Skill tool loads cite; every other request is answered.
      if (!loaded && request.tools.includes("Skill")) {
        loaded = true;
        return { tool: { name: "Skill", input: { skill: "agentrun:cite" } } };
      }
      return { text: "Claude answered." };
    },
  });
  t.after(() => fake.close());
  const { api } = await claudeServe(t, fake);
  const skills = {
    "cite/SKILL.md": `---\nname: cite\ndescription: How this agent cites its sources.\n---\n${CITE}: cite every source you read.\n`,
    "cite/reference/sources.md": "Primary sources first.\n",
    "legacy/SKILL.md": `# Legacy\n${LEGACY}: the old way.\n`,
  };
  const created = await api("POST", "/agents", { ...agent("skilled", { harness: "claude-agent", model: `anthropic/${MODEL}`, skills: ["cite", "legacy"] }), skills });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const run = await api("POST", "/agents/skilled/runs", { input: { content: "Use the cite skill, then answer." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 120_000 });
  const asked = fake.messages();
  const first = asked.find((m) => m.tools.includes("Skill"));
  assert.ok(first, `the Skill tool is offered: ${JSON.stringify(asked.map((m) => m.tools))}`);
  assert.ok(first.tools.some((name) => name.endsWith("read_skill_file")), `with the adapter's read_skill_file for a skill's other files: ${first.tools}`);
  assert.ok(holds(first.body, "agentrun:cite"), "the model is shown cite as the run's skill");
  assert.ok(!holds(first.body, "agentrun:legacy"), "and not legacy, which the adapter refuses");
  assert.ok(!holds(first.body, '<skill name="cite">'), "cite is not inlined");
  assert.ok(!holds(first.body, CITE), "none of cite's SKILL.md is sent before the model loads it");
  const system = systemText(first.body);
  assert.ok(system.includes("Answer.") && system.includes(`<skill name="legacy">\n# Legacy\n${LEGACY}: the old way.\n</skill>`), `legacy stays inlined in the system prompt: ${system.slice(-2000)}`);
  assert.ok(asked.slice(asked.indexOf(first) + 1).some((m) => holds(m.body.messages, CITE)), "loading cite puts its SKILL.md before the model");
});

/** This test's own caller, by its user-agent. */
const PROBE_AGENT = "serve-log-test";
/** A value no log may carry, sent as a bearer and in a query string. */
const CANARY = `not-a-secret-${"canary"}-7b21e4`;

test("a model named as OpenRouter names it (anthropic/claude-haiku-4.5, dotted), on one gateway for every harness, runs on Anthropic's own id and is priced at serve's catalog", { timeout: 180_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const fake = await fakeAnthropic({ reply: () => ({ text: "Claude answered." }) });
  t.after(() => fake.close());
  // OpenRouter's name for claude-haiku-4-5: dotted, as the gateway names it, never the catalog's dashed id.
  const { api } = await claudeServe(t, fake, { AGENT_MODEL_BASE_URL: `${fake.url}/v1` }, "claude-haiku-4.5");
  const run = await api("POST", "/agents/claude/runs", { input: { content: "Say what you did." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { rows } = await follow(api, run.body.run_id, ["completed"], { deadlineMs: 120_000 });
  const asked = fake.messages();
  assert.ok(asked.length > 0 && asked.every((m) => m.path === "/v1/messages" && m.model === MODEL), `Anthropic's own id, which the gateway takes: ${asked.map((m) => m.model).join(", ")}`);
  const usage = rows.findLast((r) => r.kind === "usage")?.usage;
  const expected = asked.reduce((sum, m) => sum + Math.ceil(JSON.stringify(m.body).length / 4) * PRICE.input + 12 * PRICE.output, 0) / 1e6;
  assert.equal(usage?.usd, Math.round(expected * 1e6) / 1e6, "priced at Anthropic's id in the catalog, never unknown for the dotted name");
});

test("a capped run on a model named as OpenRouter names it (dotted) is held to its cap: below one request's ceiling, it is refused before anything is sent", { timeout: 180_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const fake = await fakeAnthropic({ reply: () => ({ text: "Claude answered." }) });
  t.after(() => fake.close());
  const { api } = await claudeServe(t, fake, {}, "claude-haiku-4.5");
  // claude-haiku-4-5's output ceiling at $5 a million is well past a tenth of a cent.
  const run = await api("POST", "/agents/claude/runs", { input: { content: "Say what you did." }, max_cost_usd: 0.001 });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["failed"], { deadlineMs: 120_000 });
  const ended = (await api("GET", `/runs/${run.body.run_id}`)).body;
  assert.deepEqual([ended.status, ended.error?.code], ["failed", "spend_cap_reached"], JSON.stringify(ended));
  assert.equal(fake.messages().length, 0, "nothing reached the endpoint");
});

test("a claude-agent run's model proxy reports a refusal in the run's log: one harness line, with no key in it, neither the one sent nor serve's own", { timeout: 180_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const { fake, release } = await heldFake(t);
  const { api, data } = await claudeServe(t, fake);
  const run = await api("POST", "/agents/claude/runs", { input: { content: "Say what you did." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const runId = run.body.run_id;
  await untilRequest(fake);
  // The session's proxy, as the CLI was told it.
  const cli = await claudeProcess();
  assert.ok(cli, "the Claude CLI runs, under this test");
  const environ = (await readFile(`/proc/${cli}/environ`, "utf8")).split("\0");
  const base = environ.find((line) => line.startsWith("ANTHROPIC_BASE_URL="))?.slice("ANTHROPIC_BASE_URL=".length);
  assert.ok(base, "the CLI is told the session's proxy");
  const refused = await fetch(`${new URL(base).origin}/?key=${CANARY}`, { headers: { "user-agent": PROBE_AGENT, authorization: `Bearer ${CANARY}`, "x-api-key": CANARY } });
  assert.equal(refused.status, 401, "a caller without the session's key is refused");
  release();
  await follow(api, runId, ["completed"], { deadlineMs: 120_000 });
  const log = await readFile(join(data, "runs", runId, "process.log"), "utf8");
  const lines = log.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return { line }; } });
  // Only this test's own request: another local process may call any loopback port, and is refused (and said) too.
  const said = lines.filter((l) => l.event === "harness" && /^model proxy \(.+\): refused$/.test(l.message ?? "") && l.userAgent === PROBE_AGENT);
  assert.deepEqual(said.map((l) => [l.harness, l.status, l.method, l.path]), [["claude-agent", 401, "GET", "/"]], `the refusal, once, in the run's log: ${log}`);
  for (const secret of [CANARY, KEY]) assert.ok(!log.includes(secret), `${secret} is not in the run's log`);
});
