// A github_app MCP server on a CLI harness: the CLI calls the server's tool as a host tool through its tool bridge, and
// each call meets the claim's per-call check of the App, as pi's do. Here the CLI is a stand-in that asks the host's gate
// and calls the tool as every CLI adapter's bridge does; it calls twice in one turn, and the App is disconnected between
// the two calls.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { seal } from "../dist/sealing.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { registryPin } from "./store-helpers.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { permissionOf } = await import("../dist/tool-gate.js");
const { mcpForClaim } = await import("../dist/runner/mcp-run.js");const { githubAppAccess } = await import("../dist/runner/github-app.js");
const { GITHUB_UNUSABLE } = await import("../dist/runner/mcp-github.js");

const KEY = randomBytes(32);
const { privateKey: PEM } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const GH_TOKEN = "not-a-secret-ghs-cli-token";
const ADD = { name: "add", title: "Add", description: "Add two numbers.", input_schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }, annotations: { readOnlyHint: true } };
const STEADY = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };

/** A fake GitHub: installation 777 covers acme/widgets, its token minted for it, and each token revoked by itself. */
async function fakeGitHub(t) {
  const minted = [];
  const revoked = [];
  const server = createServer((req, res) => {
    req.resume().on("end", () => {
      const answer = (status, doc) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(doc));
      if (req.url === "/repos/acme/widgets/installation") return answer(200, { id: 777 });
      if (req.method === "POST" && req.url === "/app/installations/777/access_tokens") return minted.push(GH_TOKEN), answer(201, { token: GH_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      if (req.method === "DELETE" && req.url === "/installation/token") return revoked.push(String(req.headers.authorization).replace(/^Bearer /, "")), res.writeHead(204).end();
      return answer(404, { message: "Not Found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { api: `http://127.0.0.1:${server.address().port}`, minted, revoked };
}

/** A CLI stand-in whose one turn calls `mcp__gh__add` through the host's gate, then `between()`, then calls it again;
 *  `seen.answers` keeps what each call was answered. */
function bridgeCli(seen, between) {
  return {
    id: "stand-in-cli",
    check: () => [],
    async open(spec, io) {
      let state = "new";
      let turn;
      const call = async (n) => {
        const one = { callId: `toolu_cli_${n}`, tool: "mcp__gh__add", args: { a: 2, b: 3 } };
        const answer = await io.gate(one);
        if (answer !== "allow") return { text: answer.deny ?? "held", isError: true };
        return spec.tools.find((tool) => tool.name === one.tool).call(one.args, { callId: one.callId, signal: io.signal });
      };
      return {
        get state() { return state; },
        async send() {
          state = "idle";
          turn = (async () => {
            seen.answers = [await call(1)];
            await between();
            seen.answers.push(await call(2));
            io.onEvent({ type: "text", delta: "Done." });
            io.onEvent({ type: "turn_end", status: "completed" });
            return { status: "completed" };
          })();
        },
        async recover() {},
        async settleOpenTurn() { state = "idle"; },
        turnEnd: () => turn,
        async interrupt() {},
        async close() { await turn?.catch(() => undefined); },
      };
    },
  };
}

test("a CLI harness's MCP call meets the per-call App check too: an App disconnected between two calls of one claim refuses the second unsent, in words, and the run goes on; the token is revoked", { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-github-app-cli-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const github = await fakeGitHub(t);
  const fake = await startFakeMcp({ token: (authorization) => authorization === `Bearer ${GH_TOKEN}` });
  let runner;
  t.after(async () => {
    await runner?.close();
    await fake.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  for (const [field, value] of [["app_id", "4242"], ["private_key", PEM], ["slug", "agentrun-test-app"]]) {
    await server.triggerSettings.put({ adapter: "github", scope: "server", field, sealed: seal(KEY, Buffer.from(value, "utf8"), `trigger_settings|github|server|${field}`).toString("base64") });
  }
  await server.mcp.put({ name: "gh", url: fake.url, auth: "github_app", tools: [ADD], sealed: null });
  await server.agents.create({ id: "agent-1", name: "Cli" }, { id: "rev-1", kind: "agentic", body: {}, mcpPin: await registryPin(server) });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const seen = {};
  const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-github-app-cli-work-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const loop = createAdapterLoop(async (claim, run) => {
    const mcp = await mcpForClaim({ loopback: true, claim, store, sealKey: KEY, grants: ["mcp:gh/add"], harness: run.harness, work: () => work, launchInput: { content: "Fix https://github.com/acme/widgets" }, githubAppAccess: (s, key, input) => githubAppAccess(s, key, input, { api: github.api }), githubMcpOrigin: new URL(fake.url).origin });
    return {
      adapter: bridgeCli(seen, () => server.triggerSettings.removeScope("github", "server")),
      session: { key: "root", label: "root", system: [], tools: [], context: "fresh" },
      input: "Add them.",
      record: "loop",
      hooks: quiet,
      gate: (call) => permissionOf(call.tool, { "mcp:gh/add": { permission: "allow" } }),
      runCap: { capUsd: () => undefined, modelOf: () => undefined },
      ...(mcp ? { mcp } : {}),
    };
  });
  runner = startRunner({ store, createLoop: loop, name: "runner-a", ...STEADY });
  let row;
  for (const from = Date.now(); Date.now() - from < 30_000; await new Promise((resolve) => setTimeout(resolve, 20))) {
    row = await server.runs.get("run-1");
    if (row.state !== "running" && row.state !== "queued" && row.runner === null) break;
  }
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(seen.answers[0].text, "5", "the first call, with the App's token");
  assert.notEqual(seen.answers[0].isError, true);
  assert.equal(seen.answers[1].isError, true, JSON.stringify(seen.answers[1]));
  assert.equal(seen.answers[1].text, `The MCP server gh's credential can't be used right now: ${GITHUB_UNUSABLE.disconnected}.`);
  assert.equal(fake.log.filter((entry) => entry.method === "tools/call").length, 1, "the second call never reached the server");
  assert.deepEqual(github.minted, [GH_TOKEN], "no mint in between");
  // The revoke is sent as the token is dropped, best effort: it lands within the run's end, or soon after.
  for (let i = 0; i < 100 && !github.revoked.length; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(github.revoked, [GH_TOKEN], "the token revoked");
});
