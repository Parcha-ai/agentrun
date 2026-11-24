// A template eval on an owner's data folder (EvalOptions.data, `agentrun-serve eval-template --on-data DIR`): the eval's
// own in-process server and its runner open that folder in place of a temp one, so its runs use what the folder's server
// keeps (a ChatGPT plan's sign-in) and every fake of the eval's own server still binds (now, email, web). What the eval
// made is archived, the folder stays, and a folder another server holds, or whose email account an email case's fake
// would replace, is refused before anything runs. The agent and its grader are played by faux-template-eval.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { evalTemplate, readCases, startFake } from "../dist/template-eval.js";
import { asOwner, scratch, serve } from "./support.mjs";
import { ADDRESS, mailbox, saved } from "./email-support.mjs";
import { schedule } from "./trigger-support.mjs";

const PKG = new URL("./fixtures/templates-eval/evalpkg", import.meta.url).pathname;
const FAUX = new URL("./fixtures/faux-template-eval.mjs", import.meta.url).pathname;
const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const STATE = await scratch();
process.env.AGENTRUN_TEST_EVAL_COUNTER = join(STATE, "counter");
process.env.AGENTRUN_TEST_EVAL_GRADER_LOG = join(STATE, "graders.jsonl");

const AGENT = { version: 1, name: "The owner's own", description: "An agent the owner made before the eval.", instructions: "Answer.", skills: [], tools: [], computer: { kind: "none" }, learning: false };

/** A data folder a server set up and stopped, with an agent of the owner's on it: the folder and that agent's id. */
async function ownersFolder(t, before = async () => undefined, { runner = true } = {}) {
  const data = join(await scratch(), "agents");
  const first = await serve(t, { data, runner });
  const own = await first.api("POST", "/agents", { definition: AGENT });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  await before(first);
  await first.stop();
  return { data, own: String(own.body.agent_id) };
}

/** A package with one email case (a new message, started as its email trigger starts it). */
async function mailPackage() {
  const dir = join(await scratch(), "mailpkg");
  const at = join(dir, "evals", "reply");
  mkdirSync(join(at, "graders"), { recursive: true });
  mkdirSync(join(at, "fixtures"), { recursive: true });
  writeFileSync(join(dir, "agent.md"), [
    "---",
    "name: mailpkg",
    "version: 0.1.0",
    "description: Answers email in its thread.",
    "harness: [pi]",
    "tools: [email_search, email_read, email_draft, email_file]",
    "budget: { per_run_usd: 0.5 }",
    "triggers:",
    "  - name: New mail",
    "    source: { kind: email, every_s: 60 }",
    "    target:",
    "      kind: start_run",
    "      input:",
    "        content: Answer this email.",
    "---",
    "You answer the inbox's email.",
    "",
  ].join("\n"));
  writeFileSync(join(at, "case.yaml"), "email: fixtures/mailbox.json\n");
  writeFileSync(join(at, "prompt.md"), "---\ndescription: A new message in the inbox.\n---\n");
  const message = { from: "ana@example.com", to: ["agent@acme.example"], subject: "Invoice 1042", date: "2026-11-14T08:00:00Z", message_id: "<a1@example.com>", text: "Can you send invoice 1042 again?" };
  writeFileSync(join(at, "fixtures", "mailbox.json"), JSON.stringify({ description: "A new message.", account: { address: "agent@acme.example" }, layouts: ["folders"], mailboxes: { INBOX: [] }, message }));
  writeFileSync(join(at, "graders", "drafted.md"), "---\ntype: tool_used\ntool: email_draft\n---\n");
  return dir;
}

test("on an owner's data folder the eval's runs are that folder's server's: what the eval made is archived, and the folder and the owner's own agent stay", { timeout: 300_000 }, async (t) => {
  const { data, own } = await ownersFolder(t);
  const report = await evalTemplate({ dir: PKG, cases: ["all-pass"], data, serve: { faux: FAUX } });
  assert.deepEqual(report.server, { kind: "in_process", data });
  const [run] = report.cases[0].runs;
  assert.equal(run.status, "completed", JSON.stringify(run, null, 1));
  assert.ok(existsSync(join(data, "store.sqlite")), "the folder stays");
  // The folder's server, started again on it, has the eval's run, its agent archived, and the owner's agent as it was.
  const again = await serve(t, { data });
  const read = await again.api("GET", `/runs/${run.run_id}`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const made = await again.api("GET", `/agents/${run.agent_id}`);
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(typeof made.body.archived_at, "string", "the eval's agent is archived");
  const kept = await again.api("GET", `/agents/${own}`);
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.equal(kept.body.archived_at ?? null, null, "the owner's agent is not");
});

test("on an owner's data folder the eval keeps the folder's saved API token: the same .token after an eval, and after one refused once the server started", { timeout: 300_000 }, async (t) => {
  const { data } = await ownersFolder(t);
  const token = readFileSync(join(data, ".token"), "utf8");
  const report = await evalTemplate({ dir: PKG, cases: ["all-pass"], data, serve: { faux: FAUX } });
  assert.equal(report.cases[0].runs[0].status, "completed", JSON.stringify(report.cases[0], null, 1));
  assert.ok(existsSync(join(data, ".token")), "the folder's .token is still there");
  assert.equal(readFileSync(join(data, ".token"), "utf8"), token, "and holds the token it held");
  // Refused after its server started: the folder keeps an email account, which an email case's fake would replace.
  const faux = await mailbox(t);
  const again = await serve(t, { data });
  await saved(asOwner(again), faux);
  await again.stop();
  await assert.rejects(evalTemplate({ dir: await mailPackage(), data, serve: { faux: FAUX } }), /keeps an email account/);
  assert.equal(existsSync(join(data, ".token")) ? readFileSync(join(data, ".token"), "utf8") : null, token, "a refused eval keeps it too");
});

test("a data folder another server holds is refused before anything runs", { timeout: 120_000 }, async (t) => {
  const { data } = await ownersFolder(t);
  await serve(t, { data });
  await assert.rejects(evalTemplate({ dir: PKG, cases: ["all-pass"], data, serve: { faux: FAUX } }), /another server holds (this data root|the store)/);
});

test("an email case on a folder whose server keeps an email account is refused before anything runs, and the account stays: its fake would replace it", { timeout: 120_000 }, async (t) => {
  const faux = await mailbox(t);
  const { data } = await ownersFolder(t, (first) => saved(asOwner(first), faux));
  await assert.rejects(evalTemplate({ dir: await mailPackage(), data, serve: { faux: FAUX } }), (error) => {
    assert.match(error.message, new RegExp(`keeps an email account \\(${ADDRESS}\\)`));
    assert.match(error.message, /remove it \(DELETE \/v2\/settings\/email\)/);
    return true;
  });
  const again = await serve(t, { data });
  const account = await asOwner(again)("GET", "/settings/email");
  assert.equal(account.body.address, ADDRESS, JSON.stringify(account.body));
});

test("on an owner's folder an email case's fake mailbox is gone after the eval: the folder's server keeps no email account, as before it", { timeout: 300_000 }, async (t) => {
  const { data } = await ownersFolder(t);
  const report = await evalTemplate({ dir: await mailPackage(), data, serve: { faux: FAUX } });
  const [run] = report.cases[0].runs;
  assert.equal(run?.status, "completed", JSON.stringify(report.cases[0], null, 1));
  // The case saved its fake mailbox as the server's account for its run; the folder's server, started again, keeps none.
  const again = await serve(t, { data });
  const account = await asOwner(again)("GET", "/settings/email");
  assert.equal(account.status, 200, JSON.stringify(account.body));
  assert.equal(account.body.configured, false, `the case's fake mailbox is left as the owner's account: ${JSON.stringify(account.body)}`);
});

test("on an owner's folder a case's pins leave the owner's tool settings as they were, and an MCP server of the owner's by a fake's name is never replaced", { timeout: 300_000 }, async (t) => {
  let before;
  const { data } = await ownersFolder(t, async (first) => {
    assert.equal((await first.api("PUT", "/settings/tools", { "mcp:crm/get_contact": { pin: { id: "9" } } })).status, 200);
    before = (await first.api("GET", "/settings/tools")).body;
  });
  // mcp-match fills a pin of its own (update_contact on 7): on the owner's folder the agent's own pin holds the write, as
  // on a named server, and the case passes with the owner's settings untouched.
  const pinned = await evalTemplate({ dir: PKG, cases: ["mcp-match"], data, serve: { faux: FAUX } });
  assert.equal(pinned.pass, true, JSON.stringify(pinned.cases[0], null, 1));
  const after = await serve(t, { data });
  assert.deepEqual((await after.api("GET", "/settings/tools")).body, before, "the owner's tool settings are as they were");
  // The owner's own MCP server named crm: the case fails saying why, and the entry stays.
  const owner = await startFake("crm", readCases(PKG, ["mcp-match"]).cases[0].mcp.crm);
  t.after(() => owner.close());
  assert.equal((await after.api("PUT", "/settings/mcp-servers/crm", { url: owner.url, auth: { type: "none" } })).status, 200);
  await after.stop();
  const kept = await evalTemplate({ dir: PKG, cases: ["mcp-match"], data, serve: { faux: FAUX } });
  assert.equal(kept.pass, false);
  assert.match(kept.cases[0].error ?? "", /already has an MCP server named crm/);
  const again = await serve(t, { data });
  assert.equal((await again.api("GET", "/settings/mcp-servers/crm")).body.url, `${new URL(owner.url).origin}/…`, "the owner's entry is untouched");
});

test("a folder whose server has work of its own (an enabled trigger, a run not ended) is refused before anything runs: the eval's runner and triggers would take it up", { timeout: 300_000 }, async (t) => {
  const triggered = await ownersFolder(t, async (first) => {
    const own = (await first.api("GET", "/agents")).body.agents[0].agent_id;
    assert.equal((await first.api("POST", "/triggers", schedule(own, { cron: "0 9 * * 1", timezone: "UTC" }))).status, 201);
  });
  await assert.rejects(evalTemplate({ dir: PKG, cases: ["all-pass"], data: triggered.data, serve: { faux: FAUX } }), /has work of its own: 1 enabled trigger/);
  const queued = await ownersFolder(t, async (first) => {
    const own = (await first.api("GET", "/agents")).body.agents[0].agent_id;
    assert.equal((await first.api("POST", `/agents/${own}/runs`, { input: { content: "Say hello." } })).status, 202);
  }, { runner: false });
  await assert.rejects(evalTemplate({ dir: PKG, cases: ["all-pass"], data: queued.data, serve: { faux: FAUX } }), /has work of its own: 1 run not ended/);
  // Nothing ran: the owner's run is still queued.
  const again = await serve(t, { data: queued.data, runner: false });
  const runs = (await again.api("GET", `/runs?agent_id=${queued.own}`)).body.runs;
  assert.deepEqual(runs.map((r) => r.status), ["queued"], JSON.stringify(runs));
});

test("a data folder is the eval's own server's: with a named server it is refused, in the API and on the command line", async () => {
  const data = join(await scratch(), "agents");
  await assert.rejects(evalTemplate({ dir: PKG, data, server: { baseUrl: "http://127.0.0.1:9/v2", token: "t" } }), /--on-data .*--server/);
  const cli = spawnSync(process.execPath, [CLI, "eval-template", PKG, "--server", "http://127.0.0.1:9", "--on-data", data], { encoding: "utf8", env: { ...process.env, AGENTRUN_API_KEY: "t" } });
  assert.equal(cli.status, 2, cli.stderr);
  assert.match(cli.stderr, /--on-data .*--server/);
});
