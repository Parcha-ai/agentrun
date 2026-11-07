// A learned workflow's call the owner allows, on a CLI harness's real adapter: its node's request goes through the
// session's one route whatever became of the turn that asked for it. A park ends that turn, and a real adapter's drive
// then closes its machine and the model proxy with it (a faux harness's proxy lives as long as its session, so it never
// shows this); a restart while the call waits leaves no drive at all. Either way the approved call runs before any turn
// of the harness's: its node must still reach the provider through the session's route, booked on the session's
// records. claude-agent runs the real pinned CLI against a scripted Anthropic endpoint on loopback (no key, no network),
// codex the real adapter against its stand-in for Codex's app-server and a faux gateway on loopback.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { agentFolderOf } from "../dist/files.js";
import * as learning from "../dist/learning.js";
import { LEARNED_WORKFLOW_TOOL } from "../dist/learned-workflow.js";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { git } from "./learn-support.mjs";
import { agent, answerFlow, call, cookieOf, follow, runDir, scratch, serve, withEnv } from "./support.mjs";
import { copyStandIn } from "../../run-adapters-codex/test/stand-in.mjs";

const SIGN_IN_PHRASE = "the owner signs in with this phrase";
const KEY = `not-a-secret-${"provider"}`;
const DESCRIPTION = "Answers a question as a number; use when the person asks for the answer";
const json = { "content-type": "application/json" };
const flowFiles = { "workflows/answer/workflow.json": JSON.stringify(answerFlow()), "workflows/answer/README.md": `---\nname: answer\ndescription: ${DESCRIPTION}\n---\n` };
const INPUT = { name: "answer", input: { question: "What is six times seven" } };
const MODEL_VARS = ["AGENT_MODEL_BASE_URL", "ANTHROPIC_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AGENTRUN_CODEX_STANDIN", "AGENTRUN_SERVE_CODEX_STANDIN"];
const SETPRIV = existsSync("/usr/bin/setpriv");

async function folderWith(data, id) {
  await learning.seedOf(data, id);
  const repo = join(agentFolderOf(data, id), "learning");
  for (const [path, text] of Object.entries(flowFiles)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ["add", "--", ...Object.keys(flowFiles)]);
  git(repo, ["commit", "-q", "-m", "learned"]);
}
function entries(data, runId, kinds) {
  const db = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { readOnly: true, timeout: 2_000 });
  try {
    return db.prepare("SELECT record FROM entries ORDER BY rowid").all().map((row) => JSON.parse(String(row.record))).filter((entry) => kinds.includes(entry.kind)).map((entry) => ({ kind: entry.kind, ...entry.data }));
  } finally {
    db.close();
  }
}
/** The owner's answer to an approval, signed in on `server` (`first`: the setup that makes the owner). */
async function owner(server, first) {
  const origin = `http://127.0.0.1:${server.port}`;
  const signed = first
    ? await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: SIGN_IN_PHRASE } })
    : await call(server.port, { method: "POST", path: "/v2/auth/sign-in", headers: { ...json, origin }, body: { password: SIGN_IN_PHRASE } });
  assert.ok([200, 201, 204].includes(signed.status), signed.text);
  const cookie = cookieOf(signed);
  return (runId, approvalId) => call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${approvalId}`, headers: { ...json, cookie, origin }, body: { decision: "allow" } });
}

/** The node's submit when a request offers it and has no tool result yet (the faux gateway's `call`, codex). */
const submitsAnswer = ({ body }) => {
  const offers = (body?.tools ?? []).some((tool) => tool?.name === "submit");
  const answered = (body?.input ?? []).some((item) => item?.type === "function_call_output");
  return offers && !answered ? { name: "submit", input: { value: { answer: 42 } } } : undefined;
};

/** The route a harness's run takes here, set on `t`: a provider on loopback the node's request must reach. */
async function routeFor(t, harness) {
  if (harness === "claude-agent") {
    const fake = await fakeAnthropic({
      reply: (r) => {
        // The learned node's own request: its submit tool, never the session's.
        if (r.tools.includes("submit")) return { tool: { name: "submit", input: { value: { answer: 42 } } } };
        const asked = r.tools.includes(`mcp__hands__${LEARNED_WORKFLOW_TOOL}`) && !r.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"));
        return asked ? { tool: { name: `mcp__hands__${LEARNED_WORKFLOW_TOOL}`, input: INPUT } } : { text: "Done." };
      },
    });
    t.after(() => fake.close());
    withEnv(t, { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: fake.url, AGENT_MODEL: "anthropic/claude-haiku-4-5" }, MODEL_VARS);
    return { reached: () => fake.messages().filter((m) => m.tools.includes("submit")).length, ask: "Use the learned workflow answer." };
  }
  const gw = await startFauxGateway({ call: submitsAnswer });
  t.after(() => gw.close());
  const standIn = join(await scratch(t), "codex-stand-in.mjs");
  await copyStandIn(standIn);
  withEnv(t, {
    AGENTRUN_CODEX_STANDIN: "1",
    AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "remote" } }),
    AGENT_MODEL_BASE_URL: gw.url, AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: KEY, AGENT_MODEL_PRICE: "1,2,0.5",
  }, MODEL_VARS);
  return { reached: () => gw.requests.filter((r) => (r.body?.tools ?? []).some((tool) => tool?.name === "submit")).length, ask: `call ${LEARNED_WORKFLOW_TOOL} ${JSON.stringify(INPUT)}` };
}

for (const harness of ["claude-agent", "codex"]) {
  for (const restart of [false, true]) {
    test(`on ${harness}'s real adapter, a learned call set to ask and allowed${restart ? " after a restart while it waits" : ""} runs its node through the session's route, though the turn that asked for it closed its drive's proxy${restart ? " and no drive is open" : ""}`, { timeout: 240_000, skip: !SETPRIV && "no setpriv here" }, async (t) => {
      const route = await routeFor(t, harness);
      const first = await serve(t, { learning: "on", faux: undefined, accounts: true, openSetup: true });
      const allowOn = await owner(first, true);
      const id = `real-${harness}-${restart ? "restart" : "live"}`;
      assert.equal((await first.api("POST", "/agents", agent(id, { learning: true, harness, instructions: route.ask, tool_settings: { [LEARNED_WORKFLOW_TOOL]: { permission: "ask" } } }))).status, 201);
      await folderWith(first.data, id);
      const started = await first.api("POST", `/agents/${id}/runs`, { input: { content: route.ask } });
      assert.equal(started.status, 202, JSON.stringify(started.body));
      const runId = started.body.run_id;
      await follow(first.api, runId, ["input_required", "completed", "failed"], { deadlineMs: 150_000 });
      const view = (await first.api("GET", `/runs/${runId}`)).body;
      assert.deepEqual([view.status, view.pending?.kind, view.pending?.tool], ["input_required", "approval", LEARNED_WORKFLOW_TOOL], JSON.stringify(view));
      let server = first;
      let allow = allowOn;
      if (restart) {
        await first.close();
        server = await serve(t, { learning: "on", faux: undefined, accounts: true, data: first.data });
        allow = await owner(server, false);
      }
      const answered = await allow(runId, view.pending.id);
      assert.equal(answered.status, 204, answered.text);
      const { rows } = await follow(server.api, runId, ["completed", "failed", "input_required"], { deadlineMs: 150_000 });
      const resumed = rows.find((row) => row.origin === "server" && /^AgentRun: learned_workflow /.test(row.summary ?? ""));
      assert.match(resumed?.text ?? "", /^learned_workflow ran once you allowed it\. Its result:\n\{\\?"answer\\?":42\}/, `the approved call's result: ${resumed?.text}`);
      const node = entries(first.data, runId, ["runner.request"]).filter((entry) => entry.host === LEARNED_WORKFLOW_TOOL);
      assert.equal(node.length, 1, "its node's request, on the session's records");
      assert.equal(route.reached(), 1, "its node's request reached the provider once");
      // The same money path as the harness's own requests: one start mark on the root, closed by its own BOOKED marker, at
      // its own cost as the session's booking priced it, and a side call (no wrap-up note, never a typical request).
      const marks = entries(first.data, runId, ["agentrun.request_started", "adapter.request"]).filter((entry) => entry.request === node[0].turn);
      assert.deepEqual(marks.map((entry) => [entry.kind, entry.host]), [["agentrun.request_started", LEARNED_WORKFLOW_TOOL], ["adapter.request", LEARNED_WORKFLOW_TOOL]], JSON.stringify(marks));
      const cost = entries(first.data, runId, ["runner.turn"]).find((entry) => entry.turn === node[0].turn);
      assert.ok(typeof cost?.usd === "number" && cost.usd > 0, `settled at its own cost: ${JSON.stringify(cost)}`);
      assert.equal(node[0].side, true, "a side call");
    });
  }
}
