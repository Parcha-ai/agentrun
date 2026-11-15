// A template eval case's fake mailbox (template-eval.ts `email:`, eval-mailbox.ts): each run on each layout gets a fresh
// fake account seeded from the case's fixture, started as the package's trigger starts it, and its graders see the email
// calls and what the account holds after. The package's agent is played by test/fixtures/faux-template-eval.mjs: its run's
// input (the trigger's content, then the payload) is its script.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { seededFaux, snapshot } from "../dist/eval-mailbox.js";
import { CaseError, evalTemplate, markdownReport, readCases } from "../dist/template-eval.js";
import { scratch } from "./support.mjs";

const FAUX = new URL("./fixtures/faux-template-eval.mjs", import.meta.url).pathname;
const STATE = await scratch();
process.env.AGENTRUN_TEST_EVAL_COUNTER = join(STATE, "counter");
process.env.AGENTRUN_TEST_EVAL_GRADER_LOG = join(STATE, "graders.jsonl");
const graderInputs = () => readFileSync(process.env.AGENTRUN_TEST_EVAL_GRADER_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const graderOf = (run, file) => run.graders.find((g) => g.grader === file);

const calls = (list) => list.map(([tool, args]) => `Call ${tool} with ${JSON.stringify(args)}`).join("\n");
const indented = (text, by) => text.split("\n").map((line) => `${" ".repeat(by)}${line}`).join("\n");

/** The new mail's run: its own thread read, the other thread searched and read (refused: outside its thread), a reply
 *  drafted, its message filed out of the inbox. */
const REPLY = `${calls([
  ["email_read", { message_id: "<a2@example.com>", thread: true }],
  ["email_search", { subject: "Lunch on Friday" }],
  ["email_read", { message_id: "<b1@example.com>" }],
  ["email_draft", { to: ["ana@example.com"], subject: "Re: Invoice 1042", text: "Invoice 1042 is attached again.", in_reply_to: "<a2@example.com>" }],
  ["email_file", { message_id: "<a2@example.com>", to: "Ignored", archive: true }],
])}\nAnswer:\nREPLIED {{last-result}}\nFILING {{describe:email_file}}`;
/** The one line email_file's description says for each kind of server (email/tools.ts FILING). */
const FILING = { folders: "On this server filing moves the message out of the inbox into the folder.", gmail: "On Gmail filing adds a label and keeps the message in the inbox; archive: true also removes it from the inbox." };
/** The morning digest's run: a search of the other thread, which a schedule's run (no thread) finds. */
const DIGEST = `${calls([["email_search", { subject: "Lunch on Friday" }]])}\nAnswer:\nDIGEST {{last-result}}`;

const msg = (fields) => ({ to: ["agent@acme.example"], date: "2026-11-13T10:00:00Z", ...fields });
const INBOX = [
  msg({ from: "ana@example.com", from_name: "Ana", subject: "Invoice 1042", message_id: "<a1@example.com>", text: "Can you send invoice 1042 again?" }),
  msg({ from: "bo@example.com", subject: "Lunch on Friday", date: "2026-11-13T11:00:00Z", message_id: "<b1@example.com>", text: "Lunch on Friday?" }),
];
const NEW = msg({ from: "ana@example.com", from_name: "Ana", subject: "Re: Invoice 1042", date: "2026-11-14T08:00:00Z", message_id: "<a2@example.com>", in_reply_to: "<a1@example.com>", references: ["<a1@example.com>"], text: "Any news on the invoice?" });

/** A package that grants email_search, email_read, email_draft and email_file, with an email trigger and a schedule; its
 *  cases each a fixture, their graders as given. */
async function mailPackage(t, cases) {
  const dir = join(await scratch(t), "mailpkg");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), [
    "---",
    "name: mailpkg",
    "version: 0.1.0",
    "description: Answers email in its thread, and writes a morning digest of the inbox.",
    "harness: [pi]",
    "tools: [email_search, email_read, email_draft, email_file]",
    "budget: { per_run_usd: 0.5 }",
    "triggers:",
    "  - name: New mail",
    "    source: { kind: email, every_s: 60 }",
    "    target:",
    "      kind: start_run",
    "      input:",
    "        content: |",
    indented(REPLY, 10),
    "  - name: Morning digest",
    "    source: { kind: schedule, cron: \"0 9 * * *\", timezone: UTC }",
    "    target:",
    "      kind: start_run",
    "      input:",
    "        content: |",
    indented(DIGEST, 10),
    "---",
    "You answer the inbox's email.",
    "",
  ].join("\n"));
  for (const [name, { fixture, graders, yaml = "" }] of Object.entries(cases)) {
    const at = join(dir, "evals", name);
    mkdirSync(join(at, "graders"), { recursive: true });
    mkdirSync(join(at, "fixtures"), { recursive: true });
    writeFileSync(join(at, "case.yaml"), `email: fixtures/mailbox.json\n${yaml}`);
    writeFileSync(join(at, "prompt.md"), `---\ndescription: ${fixture.description}\n---\n`);
    writeFileSync(join(at, "fixtures", "mailbox.json"), JSON.stringify(fixture, null, 1));
    for (const [file, text] of Object.entries(graders)) writeFileSync(join(at, "graders", file), text);
  }
  return dir;
}

const REPLY_CASE = {
  fixture: { description: "Two threads in the inbox, and a new reply on the first.", account: { address: "agent@acme.example" }, layouts: ["gmail", "folders"], mailboxes: { INBOX }, message: NEW },
  graders: {
    "drafted.md": "---\ntype: tool_used\ntool: email_draft\nargs: { to: [ana@example.com] }\n---\n",
    "refused.md": "---\ntype: tool_used\ntool: email_read\nargs: { message_id: \"<b1@example.com>\" }\ncount: 1\n---\n",
    "filed.md": "---\ntype: mailbox\nmessage_id: \"<a2@example.com>\"\nin: Ignored\nnot_in: [INBOX]\n---\n",
    "judged.md": "---\ntype: llm\n---\nPass if the answer contains \"REPLIED\".\n",
  },
};

test("an email case's run is its trigger's on a fake mailbox, per layout: its graders see each email call, a refused one too, and what the mailbox holds after", { timeout: 600_000 }, async (t) => {
  const dir = await mailPackage(t, { reply: REPLY_CASE });
  const report = await evalTemplate({ dir, cases: ["reply"], serve: { faux: FAUX } });
  const [c] = report.cases;
  assert.deepEqual(c.runs.map((r) => r.layout), ["gmail", "folders"], JSON.stringify(c, null, 1));
  for (const run of c.runs) {
    assert.equal(run.status, "completed", JSON.stringify(run, null, 1));
    // Started by the email trigger's poll, on the new message: the run's thread is its, so the other one is refused.
    const read = run.calls.filter((call) => call.tool === "email_read");
    assert.equal(read.length, 2, JSON.stringify(run.calls));
    assert.match(String(read[1].result), /outside this run's thread/, JSON.stringify(read[1]));
    assert.match(run.answer, /^REPLIED \{"filed":true,"message_id":"<a2@example\.com>","to":"Ignored","archived":true/, run.answer);
    // email_file was described for the kind of server the fake plays, though it is saved as a loopback `other` account.
    const filing = /^FILING (.*)$/m.exec(run.answer)?.[1] ?? "";
    const other = run.layout === "gmail" ? "folders" : "gmail";
    assert.ok(filing.includes(FILING[run.layout]) && !filing.includes(FILING[other]), `${run.layout}: ${filing}`);
    // The draft, as the account holds it after.
    const [draft] = run.mailbox_after.added;
    assert.deepEqual({ to: draft.to, cc: draft.cc, subject: draft.subject, in_reply_to: draft.in_reply_to, text: draft.text.trim() }, { to: ["ana@example.com"], cc: [], subject: "Re: Invoice 1042", in_reply_to: "<a2@example.com>", text: "Invoice 1042 is attached again." });
    // Its message filed out of the inbox: on folders a move to the folder, on gmail the label with the inbox's taken off.
    const [moved] = run.mailbox_after.moved;
    assert.equal(moved.message_id, "<a2@example.com>");
    assert.equal(moved.before, "INBOX");
    assert.equal(moved.after, run.layout === "folders" ? "Ignored" : "[Gmail]/All Mail [Ignored]", JSON.stringify(moved));
    assert.deepEqual(run.mailbox_after.sent, [], "nothing sent");
    for (const file of ["drafted.md", "refused.md", "filed.md", "judged.md"]) assert.equal(graderOf(run, file).pass, true, `${run.layout} ${file}: ${graderOf(run, file).reason}`);
  }
  assert.equal(c.pass, true);
  // The llm grader saw the calls with their arguments, the refused one's words, and <mailbox-after>.
  const graded = graderInputs().filter((input) => input.includes("<mailbox-after untrusted>"));
  assert.equal(graded.length, 2);
  for (const input of graded) {
    assert.match(input, /email_draft \{"to":\["ana@example\.com"\],"subject":"Re: Invoice 1042"/);
    assert.match(input, /email_read \{"message_id":"<b1@example\.com>"\}.*outside this run's thread/);
    assert.match(input, /"in_reply_to": "<a2@example\.com>"/);
    assert.match(input, /<task untrusted>\n[\s\S]*<trigger-payload source="email"/, "the task is the run's input, the trigger's payload in it");
  }
  const md = markdownReport(report);
  assert.match(md, /\| reply \| gmail 1\/1, folders 1\/1 \| pass \|/);
  assert.match(md, /fake mailbox/);
});

test("an email case with no new message starts as the package's schedule's run, which searches the whole account", { timeout: 600_000 }, async (t) => {
  const dir = await mailPackage(t, {
    digest: {
      fixture: { description: "Two threads in the inbox, for the morning digest.", account: { address: "agent@acme.example" }, mailboxes: { INBOX } },
      graders: { "found.md": "---\ntype: regex\npattern: \"<b1@example\\\\.com>\"\n---\n", "untouched.md": "---\ntype: mailbox\nmessage_id: \"<b1@example.com>\"\nin: INBOX\n---\n" },
    },
  });
  const report = await evalTemplate({ dir, cases: ["digest"], serve: { faux: FAUX } });
  const [run] = report.cases[0].runs;
  assert.equal(run.layout, "folders", "folders by default");
  assert.equal(run.status, "completed", JSON.stringify(run, null, 1));
  assert.match(run.answer, /^DIGEST \{"messages":\[\{"message_id":"<b1@example\.com>"/, run.answer);
  assert.deepEqual(run.mailbox_after, { layout: "folders", added: [], moved: [], sent: [] });
  assert.equal(report.cases[0].pass, true, JSON.stringify(run.graders));
});

test("email_file with archive false keeps the message in INBOX on both layouts: refused on folders (the refused call still counts), a label on gmail; a grader of one layout grades that layout's run alone", { timeout: 600_000 }, async (t) => {
  const dir = await mailPackage(t, {
    reply: {
      ...REPLY_CASE,
      fixture: { ...REPLY_CASE.fixture, layouts: ["gmail", "folders"] },
      graders: {
        "kept.md": "---\ntype: mailbox\nmessage_id: \"<a2@example.com>\"\nin: INBOX\n---\n",
        "tried.md": "---\ntype: tool_used\ntool: email_file\nargs: { archive: false }\ncount: 1\n---\n",
        "labelled.md": "---\ntype: mailbox\nmessage_id: \"<a2@example.com>\"\nin: Ignored\nlayouts: [gmail]\n---\n",
        "unlabelled.md": "---\ntype: mailbox\nmessage_id: \"<a2@example.com>\"\nnot_in: [Ignored]\nlayouts: [folders]\n---\n",
      },
    },
  });
  const manifest = join(dir, "agent.md");
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace('"archive":true', '"archive":false'));
  const report = await evalTemplate({ dir, cases: ["reply"], serve: { faux: FAUX } });
  const runs = Object.fromEntries(report.cases[0].runs.map((run) => [run.layout, run]));
  for (const run of Object.values(runs)) {
    assert.equal(run.status, "completed", JSON.stringify(run, null, 1));
    for (const file of ["kept.md", "tried.md"]) assert.equal(graderOf(run, file).pass, true, `${run.layout} ${file}: ${graderOf(run, file).reason}`);
  }
  const [refused] = runs.folders.calls.filter((call) => call.tool === "email_file");
  assert.match(String(refused.result), /pass archive: true to move it/, JSON.stringify(refused));
  assert.deepEqual(runs.folders.mailbox_after.moved, [], "nothing moved");
  // Each layout's own grader graded its run, and is not a grader of the other's: the case passes on both.
  assert.equal(graderOf(runs.gmail, "labelled.md").pass, true, graderOf(runs.gmail, "labelled.md").reason);
  assert.equal(graderOf(runs.folders, "unlabelled.md").pass, true, graderOf(runs.folders, "unlabelled.md").reason);
  assert.equal(graderOf(runs.folders, "labelled.md"), undefined);
  assert.equal(graderOf(runs.gmail, "unlabelled.md"), undefined);
  assert.equal(report.cases[0].pass, true, JSON.stringify(report.cases[0].runs.map((run) => run.graders)));
});

test("a trigger that watches a folder gets the new message there, a folder the fixture names empty is on the account, and on folders email_file with no archive moves the message", { timeout: 600_000 }, async (t) => {
  const dir = await mailPackage(t, {
    reply: {
      ...REPLY_CASE,
      fixture: { ...REPLY_CASE.fixture, layouts: ["folders"], mailboxes: { INBOX, Support: [] } },
      graders: { "filed.md": "---\ntype: mailbox\nmessage_id: \"<a2@example.com>\"\nin: Ignored\nnot_in: [Support, INBOX]\n---\n" },
    },
  });
  const manifest = join(dir, "agent.md");
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace("source: { kind: email, every_s: 60 }", "source: { kind: email, every_s: 60, mailbox: Support }").replace(',"archive":true', ""));
  const report = await evalTemplate({ dir, cases: ["reply"], serve: { faux: FAUX } });
  const [run] = report.cases[0].runs;
  assert.equal(run.status, "completed", JSON.stringify(run, null, 1));
  // The real email tools ran on the fake: on folders, filing with no archive is a move, and its answer says so.
  const [filed] = run.calls.filter((call) => call.tool === "email_file");
  assert.deepEqual(filed.arguments, { message_id: "<a2@example.com>", to: "Ignored" }, JSON.stringify(filed));
  assert.match(String(filed.result), /"archived":true.*"note":"moved out of the inbox to Ignored"/, JSON.stringify(filed));
  assert.deepEqual(run.mailbox_after.moved.map(({ message_id, before, after }) => ({ message_id, before, after })), [{ message_id: "<a2@example.com>", before: "Support", after: "Ignored" }]);
  assert.equal(graderOf(run, "filed.md").pass, true, graderOf(run, "filed.md").reason);
});

test("on gmail every message of a fixture's label is in All Mail with the label, its second as its first, and the label's mailbox lists them; an empty label is made", async (t) => {
  const receipt = (n) => msg({ from: "shop@example.com", subject: `Receipt ${n}`, message_id: `<r${n}@example.com>`, text: `Receipt ${n}.` });
  const faux = await seededFaux({ description: "Receipts", account: { address: "agent@acme.example" }, layouts: ["gmail"], mailboxes: { INBOX, Receipts: [receipt(1), receipt(2)], Travel: [] } }, "gmail");
  t.after(() => faux.close());
  const labelled = faux.messages("[Gmail]/All Mail").map((m) => [m.messageId, m.labels]);
  assert.deepEqual(labelled, [["<r1@example.com>", ["Receipts"]], ["<r2@example.com>", ["Receipts"]]]);
  assert.deepEqual(faux.messages("Receipts").map((m) => [m.uid, m.messageId]), [[1, "<r1@example.com>"], [2, "<r2@example.com>"]], "the label's mailbox lists them, as Gmail's does");
  assert.ok(faux.mailboxes().includes("Travel"), faux.mailboxes().join(", "));
  // Each message has one place, its own mailbox and labels, never the label's mailbox that lists it.
  const { places } = snapshot(faux);
  assert.deepEqual([...places].filter(([id]) => id.startsWith("<r")).map(([id, place]) => [id, place.mailbox, place.labels]), [["<r1@example.com>", "[Gmail]/All Mail", ["Receipts"]], ["<r2@example.com>", "[Gmail]/All Mail", ["Receipts"]]]);
});

test("an email case checks when it is read: its fixture, an email tool, the trigger it starts from, no prompt of its own, and only on the eval's own server", async (t) => {
  const problems = (dir) => {
    try {
      readCases(dir);
      return [];
    } catch (error) {
      assert.ok(error instanceof CaseError, String(error));
      return error.problems;
    }
  };
  const good = await mailPackage(t, { reply: REPLY_CASE });
  assert.deepEqual(problems(good), []);
  const [one] = readCases(good).cases;
  assert.equal(one.email.trigger, "New mail");
  assert.deepEqual(one.email.layouts, ["gmail", "folders"]);

  const bad = await mailPackage(t, {
    reply: { ...REPLY_CASE, fixture: { ...REPLY_CASE.fixture, layouts: ["outlook"], mailboxes: { INBOX: [{ ...INBOX[0], message_id: "a1@example.com" }] } } },
    lost: { ...REPLY_CASE, fixture: { ...REPLY_CASE.fixture, trigger: "Evening digest" } },
    said: { ...REPLY_CASE, yaml: "max_cost_usd: 1\n" },
    scoped: {
      ...REPLY_CASE,
      fixture: { ...REPLY_CASE.fixture, layouts: ["folders"] },
      graders: { "unrun.md": "---\ntype: mailbox\nmessage_id: \"<a2@example.com>\"\nin: INBOX\nlayouts: [gmail]\n---\n", "outlook.md": "---\ntype: regex\npattern: x\nlayouts: [outlook]\n---\n" },
    },
  });
  writeFileSync(join(bad, "evals", "said", "prompt.md"), "---\ndescription: A prompt of its own.\n---\nReply to it.\n");
  const said = problems(bad);
  assert.ok(said.some((p) => /reply\/fixtures\/mailbox\.json: layouts is a list of gmail and folders/.test(p)), said.join("\n"));
  assert.ok(said.some((p) => /reply\/fixtures\/mailbox\.json: .*message_id is a Message-ID in angle brackets/.test(p)), said.join("\n"));
  assert.ok(said.some((p) => /lost\/fixtures\/mailbox\.json: trigger Evening digest is not one of the package's triggers \(New mail, Morning digest\)/.test(p)), said.join("\n"));
  assert.ok(said.some((p) => /said\/prompt\.md: an email case's run is started by the package's trigger/.test(p)), said.join("\n"));
  assert.ok(said.some((p) => /scoped\/graders\/unrun\.md: layouts names gmail, which the case's fixture does not run on \(folders\)/.test(p)), said.join("\n"));
  assert.ok(said.some((p) => /scoped\/graders\/outlook\.md: layouts is a list of gmail and folders, each once/.test(p)), said.join("\n"));

  const toolless = await mailPackage(t, { reply: REPLY_CASE });
  const manifest = join(toolless, "agent.md");
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace("tools: [email_search, email_read, email_draft, email_file]", "tools: [read]"));
  assert.ok(problems(toolless).some((p) => /email fakes the server's email account, and the package's tools name no email tool/.test(p)), problems(toolless).join("\n"));

  await assert.rejects(evalTemplate({ dir: good, server: { baseUrl: "http://127.0.0.1:9", token: "x" } }), (error) => error instanceof CaseError && error.problems.some((p) => /evals\/reply: email fakes the server's email account on the eval's own server alone: run it without --server/.test(p)));
});
