// A template eval on an owner's data folder (EvalOptions.data, `agentrun-serve eval-template --on-data DIR`): the eval's
// own in-process server and its runner open that folder in place of a temp one, so its runs use what the folder's server
// keeps (a ChatGPT plan's sign-in) and every fake of the eval's own server still binds (now, email, web). What the eval
// made is archived, the folder stays, and a folder another server holds, or whose email account an email case's fake
// would replace, is refused before anything runs. The agent and its grader are played by faux-template-eval.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { evalTemplate } from "../dist/template-eval.js";
import { asOwner, scratch, serve } from "./support.mjs";
import { ADDRESS, mailbox, saved } from "./email-support.mjs";

const PKG = new URL("./fixtures/templates-eval/evalpkg", import.meta.url).pathname;
const FAUX = new URL("./fixtures/faux-template-eval.mjs", import.meta.url).pathname;
const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const STATE = await scratch();
process.env.AGENTRUN_TEST_EVAL_COUNTER = join(STATE, "counter");
process.env.AGENTRUN_TEST_EVAL_GRADER_LOG = join(STATE, "graders.jsonl");

const AGENT = { version: 1, name: "The owner's own", description: "An agent the owner made before the eval.", instructions: "Answer.", skills: [], tools: [], computer: { kind: "none" }, learning: false };

/** A data folder a server set up and stopped, with an agent of the owner's on it: the folder and that agent's id. */
async function ownersFolder(t, before = async () => undefined) {
  const data = join(await scratch(), "agents");
  const first = await serve(t, { data });
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

test("a data folder another server holds is refused before anything runs", { timeout: 120_000 }, async (t) => {
  const { data } = await ownersFolder(t);
  await serve(t, { data });
  await assert.rejects(evalTemplate({ dir: PKG, cases: ["all-pass"], data, serve: { faux: FAUX } }), /another server holds this data root/);
});

test("an email case on a folder whose server keeps an email account is refused before anything runs, and the account stays: its fake would replace it", { timeout: 120_000 }, async (t) => {
  const faux = await mailbox(t);
  const { data } = await ownersFolder(t, (first) => saved(asOwner(first), faux));
  await assert.rejects(evalTemplate({ dir: await mailPackage(), data, serve: { faux: FAUX } }), (error) => {
    assert.match(error.message, new RegExp(`keeps an email account \\(${ADDRESS}\\)`));
    assert.match(error.message, /Settings → Email/);
    return true;
  });
  const again = await serve(t, { data });
  const account = await asOwner(again)("GET", "/settings/email");
  assert.equal(account.body.address, ADDRESS, JSON.stringify(account.body));
});

test("a data folder is the eval's own server's: with a named server it is refused, in the API and on the command line", async () => {
  const data = join(await scratch(), "agents");
  await assert.rejects(evalTemplate({ dir: PKG, data, server: { baseUrl: "http://127.0.0.1:9/v2", token: "t" } }), /--on-data .*--server/);
  const cli = spawnSync(process.execPath, [CLI, "eval-template", PKG, "--server", "http://127.0.0.1:9", "--on-data", data], { encoding: "utf8", env: { ...process.env, AGENTRUN_API_KEY: "t" } });
  assert.equal(cli.status, 2, cli.stderr);
  assert.match(cli.stderr, /--on-data .*--server/);
});
