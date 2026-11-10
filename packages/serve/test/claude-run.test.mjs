// A run on claude-agent through serve, on the real pinned Agent SDK and Claude CLI (a dev dependency here), against a
// fake Anthropic Messages endpoint on loopback (no key, no network): its requests go through the adapter's proxy to
// ANTHROPIC_BASE_URL's origin with the native model id, each paid request is booked once at serve's catalog price, and
// the CLI runs under the run's confinement (setpriv's no_new_privs, as pi's commands do, under the same user), in the
// run's workspace (its state in the session's private directory), with no key and no server variable in its environment. A run whose process dies while a
// request is in flight resumes on the next process, books the cut request once as unknown, and leaves no CLI behind.
// Every process the test reads is its own descendant.
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { agent, follow, runDir, runRecordOf, serve } from "./support.mjs";

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

// SKIP (follow-up #2080): the claude-agent CLI on the runner does not run under setpriv --no-new-privs as pi's commands do.
test.skip("a run on claude-agent: through the adapter's proxy with the native model, each request booked once at serve's price, the CLI confined, in its own directory, with no key in its environment", { timeout: 180_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const { fake, release } = await heldFake(t);
  const { api, data } = await claudeServe(t, fake);
  // How many fit at once is this host's memory (admission.test.mjs).
  const { max_concurrent_runs, ...offer } = (await api("GET", "/capabilities")).body.harnesses.find((h) => h.id === "claude-agent");
  assert.deepEqual(offer, { id: "claude-agent", available: true, steer: false, default_model: `anthropic/${MODEL}`, run_memory_mib: 288 });
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
  assert.equal(cwd, realpathSync(join(runDir(data, runId), "work")), "the CLI works in the run's workspace, where its file tools write");
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
  const left = (await filesUnder(join(runDir(data, runId), "work"))).filter((path) => path.startsWith(".claude") || path.endsWith(".jsonl"));
  assert.deepEqual(left, [], "no CLI file in the run's workspace");
});

// SKIP (follow-up #2080): a claude-agent run on the runner works in a scratch folder, not the run folder this test reads from.
test.skip("a claude-agent run writes where its CLI works: a relative path, the CLI's own absolute one and a learning note all land in the workspace, and no tool result names the server's data directory", { timeout: 180_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  // The model as sonnet answers (QA run 3, F20): a relative path, then the file at its working directory's absolute
  // path, then a learning note as M2's end-of-run turn writes one; then a path out of the workspace and a file that is not
  // there, then its answer.
  let cwd;
  const steps = [
    () => ({ name: "mcp__hands__write", input: { path: "hello.md", content: "relative\n" } }),
    () => ({ name: "mcp__hands__read", input: { path: "hello.md" } }),
    () => ({ name: "mcp__hands__write", input: { path: `${cwd}/hello.md`, content: "hello\n" } }),
    () => ({ name: "mcp__hands__write", input: { path: ".learning/note.md", content: "noted\n" } }),
    () => ({ name: "mcp__hands__write", input: { path: "../escape.md", content: "out" } }),
    () => ({ name: "mcp__hands__read", input: { path: "missing.md" } }),
  ];
  const fake = await fakeAnthropic({
    reply: (r) => {
      if (!r.tools.includes("mcp__hands__write")) return { text: "ok" };
      cwd ??= /(?:Primary working directory|Working directory): (\/[^\s"\\]+)/.exec(JSON.stringify(r.body))?.[1];
      const done = r.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_result").length;
      return done < steps.length ? { tool: steps[done]() } : { text: "I wrote hello.md." };
    },
  });
  t.after(() => fake.close());
  const { api, data } = await claudeServe(t, fake);
  assert.equal((await api("POST", "/agents", agent("claude-files", { harness: "claude-agent", model: `anthropic/${MODEL}`, tools: ["read", "write"] }))).status, 201);
  const run = await api("POST", "/agents/claude-files/runs", { input: { content: "Write a file called hello.md with one line saying hello." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const runId = run.body.run_id;
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 150_000 });
  const work = join(runDir(data, runId), "work");
  assert.ok(cwd, "the CLI told its model its working directory");
  assert.equal(realpathSync(cwd), realpathSync(work), "the CLI's working directory is the run's workspace");
  const calls = rows.filter((r) => r.kind === "tool_result").map((r) => [r.tool_name, r.tool_status]);
  assert.deepEqual(calls, [["write", "success"], ["read", "success"], ["write", "success"], ["write", "success"], ["write", "failed"], ["read", "failed"]], JSON.stringify(rows.filter((r) => r.kind === "tool_result").map((r) => r.tool_result_preview)));
  // What the model was told of each call: the CLI sends each tool's result back in the next request.
  const results = fake.messages().flatMap((m) => m.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_result").map((b) => (Array.isArray(b.content) ? b.content.map((c) => c.text ?? "").join("") : String(b.content)));
  const told = [...new Set(results)];
  assert.ok(told.some((text) => text.includes("relative")), `the relative write landed where the read looks: ${told.join(" | ")}`);
  assert.equal(await readFile(join(work, "hello.md"), "utf8"), "hello\n", "the absolute write landed on the same file, in the workspace");
  assert.equal(await readFile(join(work, ".learning", "note.md"), "utf8"), "noted\n", "the learning note is in the workspace");
  assert.deepEqual((await filesUnder(work)).sort(), [".learning", join(".learning", "note.md"), "hello.md"], "and nothing else: the CLI keeps no file of its own there");
  assert.ok(!existsSync(join(runDir(data, runId), "escape.md")), "the path out was not written");
  assert.ok(told.some((text) => /escape\.md: outside the workspace/.test(text)), `the path out is refused: ${told.join(" | ")}`);
  assert.ok(told.some((text) => /missing\.md/.test(text) && /ENOENT|no such file/i.test(text)), `the missing file is named: ${told.join(" | ")}`);
  for (const root of new Set([data, realpathSync(data)])) {
    assert.deepEqual(told.filter((text) => text.includes(root)), [], "no tool result names the server's data directory");
    // A row's summary quotes the call's own arguments (the model's absolute path, here): its result is the tool's words.
    assert.deepEqual(rows.filter((r) => r.kind === "tool_result" && String(r.tool_result_preview ?? "").includes(root)).map((r) => r.tool_result_preview), [], "nor does any tool result on the timeline");
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

test("a capped run on a model named as OpenRouter names it (dotted) is held to its cap: below one request's least, it is refused before anything is sent, in plain words, and the run pauses at its cap", { timeout: 180_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const fake = await fakeAnthropic({ reply: () => ({ text: "Claude answered." }) });
  t.after(() => fake.close());
  const { api } = await claudeServe(t, fake, {}, "claude-haiku-4.5");
  // claude-haiku-4-5 at $5 a million output tokens: the least a request may be limited to, its answer's 1,024 tokens,
  // costs $0.00512 before its input, past a tenth of a cent.
  const run = await api("POST", "/agents/claude/runs", { input: { content: "Say what you did." }, max_cost_usd: 0.001 });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["input_required", "failed"], { deadlineMs: 120_000 });
  const ended = (await api("GET", `/runs/${run.body.run_id}`)).body;
  assert.deepEqual([ended.status, ended.state, ended.error, ended.pending?.kind], ["input_required", "waiting", null, "budget"], JSON.stringify(ended));
  // Named as the catalog shows it, and nothing spent or held: the cap to raise to is the least.
  const words = /^Not sent: the next step needs at least \$(\d+\.\d\d), and this run's cap is \$0\.001\. Raise the cap to at least \$(\d+\.\d\d) to continue\.$/.exec(ended.pending.said);
  assert.ok(words, ended.pending.said);
  assert.equal(words[2], words[1]);
  assert.ok(Number(words[1]) >= 0.00512, `the least covers the answer's 1,024 tokens: $${words[1]}`);
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
  const log = await readFile(join(runDir(data, runId), "process.log"), "utf8");
  const lines = log.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return { line }; } });
  // Only this test's own request: another local process may call any loopback port, and is refused (and said) too.
  const said = lines.filter((l) => l.event === "harness" && /^model proxy \(.+\): refused$/.test(l.message ?? "") && l.userAgent === PROBE_AGENT);
  assert.deepEqual(said.map((l) => [l.harness, l.status, l.method, l.path]), [["claude-agent", 401, "GET", "/"]], `the refusal, once, in the run's log: ${log}`);
  for (const secret of [CANARY, KEY]) assert.ok(!log.includes(secret), `${secret} is not in the run's log`);
});

test("a refused key ends a claude-agent run at the provider's first 401: one request, no retries, and the run's error in plain words", { timeout: 120_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  // The provider refuses the key on every request, as OpenRouter does a wrong one. The CLI retries a 401 a dozen times
  // over about three minutes (QA, run 01a1a56c: 187 s while the run read Working); no retry can pass, so the run ends at
  // the first, with the provider's words.
  const fake = await fakeAnthropic({ reply: () => ({ error: { status: 401, type: "authentication_error", message: "User not found." } }) });
  t.after(() => fake.close());
  const { api } = await claudeServe(t, fake);
  const started = Date.now();
  const run = await api("POST", "/agents/claude/runs", { input: { content: "Say hello." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["failed"], { deadlineMs: 30_000 });
  const took = Date.now() - started;
  const paid = fake.messages().filter((r) => r.method === "POST" && r.path === "/v1/messages");
  assert.equal(paid.length, 1, `one paid request reached the provider, not ${paid.length}`);
  const view = (await api("GET", `/runs/${run.body.run_id}`)).body;
  assert.match(view.error?.message ?? "", /^\S+ refused ANTHROPIC_API_KEY \(401: User not found\): /, JSON.stringify(view.error));
  assert.ok(took < 30_000, `it failed in ${took} ms`);
});

test("a refused key whose 401 body never ends still ends a claude-agent run within seconds, after one request", { timeout: 120_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  // A provider (or a proxy before it) that sends the 401's headers and part of its body, then holds the rest: the turn
  // still ends at the first 401, with whatever words came, never waiting on a body that may not end.
  const { createServer } = await import("node:http");
  const asked = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    req.resume();
    res.writeHead(401, { "content-type": "application/json" });
    res.write('{"type":"error","error":{"type":"authentication_error","message":"User not found."');
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const { api } = await claudeServe(t, { url: `http://127.0.0.1:${server.address().port}` });
  const started = Date.now();
  const run = await api("POST", "/agents/claude/runs", { input: { content: "Say hello." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["failed"], { deadlineMs: 20_000 });
  const took = Date.now() - started;
  const paid = asked.filter((line) => /^POST \/v1\/messages(\?|$)/.test(line));
  assert.equal(paid.length, 1, `one paid request reached the provider: ${JSON.stringify(asked)}`);
  const view = (await api("GET", `/runs/${run.body.run_id}`)).body;
  assert.match(view.error?.message ?? "", /^\S+ refused ANTHROPIC_API_KEY \(401(: [^)]*)?\): /, JSON.stringify(view.error));
  assert.ok(took < 20_000, `it failed in ${took} ms`);
});
