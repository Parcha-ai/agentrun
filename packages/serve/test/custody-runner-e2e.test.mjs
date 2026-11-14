// Secret custody end to end on the runner (#2139): a server with its runner beside it, started as the CLI starts it, and a
// run that uses a saved model key, a saved tool key and a signed-in MCP credential. Distinct values are planted where the
// owner puts them (the settings API, an OAuth sign-in), the run goes through the real runner, and then every place a person
// or the agent can read is read for every planted value in every form the harness looks for (as is, base64, hex,
// URL-encoded, JSON-escaped, or a 16-character piece):
//   - the run's timeline rows (the served route), its view, /usage and /stats;
//   - the run's files, listed and read as the API serves them;
//   - the webhook payloads the server sent (run.needs_input, run.ended);
//   - the server's log and what this process wrote to stderr and the console;
//   - the store's bytes (its tables and WAL; the sealed columns stay sealed);
//   - the environment of the run's own process, as the agent's model saw it (fixtures/faux-custody-e2e.mjs files it).
// The monid vendor echoes the key it was sent back in its error, as a provider that quotes a request would, and the agent
// writes what it saw into a file of its folder: the worst case a run's own words can make of a key. The same run goes on pi
// and on a CLI harness (claude-agent, on the faux harness).
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, scratch, serve, storeBytes, withEnv } from "./support.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { startFakeOAuth } from "./fixtures/fake-oauth-server.mjs";
import { findPlanted, plantedValue } from "./fixtures/planted-secrets.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const FAUX_E2E = new URL("./fixtures/faux-custody-e2e.mjs", import.meta.url).pathname;
const FAUX_HARNESS_E2E = new URL("./fixtures/faux-custody-harness-e2e.mjs", import.meta.url).pathname;
const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const CALLBACK = "/v2/settings/mcp-servers/oauth/callback";

/** A webhook receiver on loopback: every body posted to it, in order. */
async function receiver(t) {
  const bodies = [];
  const http = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push({ headers: req.headers, body });
    res.writeHead(204).end();
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (http.close(resolve), http.closeAllConnections())));
  return { url: `http://127.0.0.1:${http.address().port}/hook`, bodies };
}

/** The owner's browser at an OAuth sign-in: the authorization URL (the fake approves at once) and its redirect to the
 *  server's callback, with the cookie the start set. */
async function signIn(api, mcpUrl, base) {
  const started = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcpUrl, scopes: ["read"] });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const asked = await fetch(started.body.authorization_url, { redirect: "manual" });
  assert.equal(asked.status, 302, await asked.text());
  const back = await fetch(asked.headers.get("location"), { redirect: "manual", headers: { cookie: started.headers.get("set-cookie").split(";")[0] } });
  assert.equal(back.status, 302, await back.clone().text());
  assert.match(back.headers.get("location"), /sign_in=ok/, "the sign-in came back ok");
}

/** What this process writes to stderr and the console while `t` runs. */
function captureLogs(t) {
  const lines = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => (lines.push(String(chunk)), write(chunk, ...rest));
  const consoled = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    consoled[level] = console[level];
    console[level] = (...args) => lines.push(args.map(String).join(" "));
  }
  t.after(() => {
    process.stderr.write = write;
    for (const [level, fn] of Object.entries(consoled)) console[level] = fn;
  });
  return () => lines.join("\n");
}

/** The run, from a server that holds the planted keys, and everything readable of it, for `harness`. */
async function usedKeys(t, { harness }) {
  const SEAL = randomBytes(32).toString("base64");
  const MODEL_KEY = plantedValue("sk-planted-model");
  const TOOL_KEY = plantedValue("sk-planted-monid");
  const dir = await scratch(t);
  const envReport = join(dir, "env.json");
  withEnv(t, {
    AGENTRUN_SEAL_KEY: SEAL,
    AGENTRUN_TEST_FAUX_MONID_ACCEPTS: createHash("sha256").update(TOOL_KEY).digest("hex"),
    AGENTRUN_TEST_FAUX_MONID_ECHO: "/v1/run",
    AGENTRUN_TEST_FAUX_MONID_CALLS: join(dir, "monid-calls.jsonl"),
    CUSTODY_E2E_ENV_REPORT: envReport,
  }, ["AGENTRUN_SEAL_KEY", "AGENTRUN_TEST_FAUX_MONID_ACCEPTS", "AGENTRUN_TEST_FAUX_MONID_ECHO", "AGENTRUN_TEST_FAUX_MONID_CALLS", "CUSTODY_E2E_ENV_REPORT", "MONID_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
  const logs = [];
  const consoleText = captureLogs(t);
  const hook = await receiver(t);
  const as = await startFakeOAuth();
  const mcp = await startFakeMcp({ token: as.accepts, oauth: as.issuer });
  t.after(() => Promise.all([as.close(), mcp.close()]));
  // pi on its faux model; a CLI harness on the faux harness (every harness but pi runs on it), as the table module says.
  // The receiver is on 127.0.0.1, so the operator's switch that lets the webhook send to this machine is on.
  const server = await serve(t, { fauxMonid: FAUX_MONID, harnesses: true, webhookPrivateTargets: true, log: (line) => logs.push(line), ...(harness === "pi" ? { faux: FAUX_E2E } : { harnessTable: fauxTable(FAUX_HARNESS_E2E) }) });
  const { api, data } = server;

  // The owner's writes: a model key and a tool key from Settings, the webhook, and an OAuth sign-in.
  // The model key the harness's own route reads: OpenAI's for pi, Anthropic's for claude-agent.
  const modelKey = harness === "pi" ? ["openai", "OPENAI_API_KEY"] : ["anthropic", "ANTHROPIC_API_KEY"];
  assert.equal((await api("PUT", `/settings/tool-keys/${modelKey[0]}`, { values: { [modelKey[1]]: MODEL_KEY } })).status, 204);
  assert.equal((await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: TOOL_KEY } })).status, 204);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  await signIn(api, mcp.url, server.baseUrl);
  assert.ok(as.issued.length > 0, "the sign-in issued a token set");
  const tokens = [...as.issued];

  const tools = ["monid:faux/person/enrich", "mcp:docs/add", "write"];
  const saved = await api("POST", "/agents", agent("custody", { ...(harness === "pi" ? {} : { harness }), instructions: "Use the keys.", tools, tool_settings: { "monid:faux/person/enrich": { permission: "allow" }, "mcp:docs/*": { permission: "allow" }, write: { permission: "allow" } } }));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const started = await api("POST", "/agents/custody/runs", { input: { content: "Use the keys." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const { rows, last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
  assert.equal(last.status, "completed", JSON.stringify(rows.slice(-3)));

  // The run really used what was planted: monid took the stored key and the MCP server a bearer.
  const calls = existsSync(join(dir, "monid-calls.jsonl")) ? readFileSync(join(dir, "monid-calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const digest = createHash("sha256").update(TOOL_KEY).digest("hex").slice(0, 16);
  assert.ok(calls.some((call) => call.path === "/v1/run" && call.key === digest), `the run reached monid on the stored key: ${JSON.stringify(calls)}`);
  assert.ok(mcp.log.some((entry) => entry.tool === "add" && entry.authorization), "the run called the MCP server with its sign-in's token");

  // Everything a person or the agent can read.
  const view = (await api("GET", `/runs/${runId}`)).body;
  const served = (await api("GET", `/runs/${runId}/timeline`)).body;
  const files = (await api("GET", `/runs/${runId}/files`)).body;
  const fileTexts = [];
  for (const file of files.files ?? files.items ?? []) {
    const read = await api("GET", `/runs/${runId}/files/${file.path}`);
    fileTexts.push({ where: `the run's file ${file.path}`, text: typeof read.body === "string" ? read.body : JSON.stringify(read.body) });
  }
  // The server tells a run's end on its own timer, after the run's last row: wait for this run's run.ended to arrive.
  const endedBy = Date.now() + 30_000;
  const endedSent = () =>
    hook.bodies.some((sent) => {
      try {
        const message = JSON.parse(sent.body);
        return message.type === "run.ended" && message.data?.run_id === runId;
      } catch {
        return false;
      }
    });
  while (!endedSent()) {
    assert.ok(Date.now() < endedBy, `the server sent run ${runId}'s run.ended within 30 s (${hook.bodies.length} webhook bodies so far)`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // /usage and /stats are read only as they answered: an error body would pass the scan and read nothing.
  const usage = await api("GET", "/usage");
  const stats = await api("GET", "/stats");
  assert.equal(usage.status, 200, `GET /usage: ${JSON.stringify(usage.body)}`);
  assert.equal(stats.status, 200, `GET /stats: ${JSON.stringify(stats.body)}`);
  const sources = [
    { where: "the timeline rows followed", text: JSON.stringify(rows) },
    { where: "GET /runs/{id}/timeline", text: JSON.stringify(served) },
    { where: "GET /runs/{id}", text: JSON.stringify(view) },
    { where: "GET /usage", text: JSON.stringify(usage.body) },
    { where: "GET /stats", text: JSON.stringify(stats.body) },
    { where: "GET /runs (the list)", text: JSON.stringify((await api("GET", "/runs")).body) },
    { where: "the run's file list", text: JSON.stringify(files) },
    ...fileTexts,
    { where: "the webhook payloads", text: hook.bodies.map((sent) => sent.body).join("\n") },
    { where: "the server's log", text: logs.join("\n") },
    { where: "this process's stderr and console", text: consoleText() },
    { where: "store.sqlite (+wal, shm), utf8", text: storeBytes(data).toString("utf8") },
    { where: "store.sqlite (+wal, shm), latin1", text: storeBytes(data).toString("latin1") },
  ];
  // The scan reads what it should: the store, the files and the webhook were there to read.
  assert.ok(storeBytes(data).length > 0, "the store's bytes are read");
  assert.ok(files && JSON.stringify(files).length > 2, `the run's files are listed: ${JSON.stringify(files)}`);
  assert.ok(hook.bodies.length > 0, "the server sent the webhook");
  const env = JSON.parse(readFileSync(envReport, "utf8"));
  return { sources, env, planted: { model: MODEL_KEY, tool: TOOL_KEY, tokens }, rows, view, fileTexts, seal: SEAL, runId };
}

for (const harness of ["pi", "claude-agent"]) {
  test(`${harness}: a run that uses a saved model key, a saved tool key and a signed-in MCP credential leaves none of them in anything a person or the agent can read`, { timeout: 240_000 }, async (t) => {
    const { sources, env, planted, fileTexts, rows, seal, runId } = await usedKeys(t, { harness });
    const values = [planted.model, planted.tool, ...planted.tokens];
    // The scan reads what it says it reads: the run's id, which every one of these places holds, is found in each.
    const control = new Set(findPlanted(sources, [runId]).map((hit) => hit.where));
    for (const where of ["GET /runs/{id}", "GET /runs/{id}/timeline", "GET /runs (the list)", "the webhook payloads", "the server's log", "store.sqlite (+wal, shm), utf8"]) assert.ok(control.has(where), `the scan finds a value that is there: ${where} (found in ${[...control].join(", ")})`);
    // /usage and /stats name no run: they answered something, which is what is read for the values.
    for (const where of ["GET /usage", "GET /stats"]) assert.ok(sources.find((source) => source.where === where).text.length > 20, `${where} answered`);
    // The seal key opens every saved key and is the server's alone: it too is in none of them.
    assert.deepEqual(findPlanted(sources, [...values, seal]), [], "a planted value, or the seal key, shows in a place a person or the agent reads");
    // The key really was in flight: the vendor's error, which quotes it, reached the run and was shown with the key cut.
    assert.match(JSON.stringify(rows), /No such endpoint for the key/, "the vendor's echo came back to the run");
    // The agent wrote what it saw into a file: the file is there, and says nothing of a key.
    assert.ok(fileTexts.some((file) => file.text.includes("What I saw")), "the agent's note is in its folder");
    // The run's own process holds none of them: not in its environment, not in /proc/self/environ. (Not the seal key: this
    // test hands it to the server in the environment, where the launcher hands it over a pipe; secret-custody's launcher
    // cases prove no process holds it there.)
    assert.deepEqual(findPlanted([{ where: "the run's process environment", text: JSON.stringify(env) }], values), []);
  });
}
