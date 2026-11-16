// calendar_events in packages and template evals. A package's `tools` may name it, as they name the email tools, and it
// applies on a server with no calendar saved as the email tools do with no account (no refusal, no warning: the tool
// answers that no calendar is saved). An eval case's `calendar: <file>.ics` is served by the fake calendar server
// (calendar/ics-faux.ts) and saved as the eval server's calendar for the case's runs; the case's `now` is the window's
// clock; its graders see each calendar_events call with its arguments and answer. A case with both `email` and `calendar`
// (inbox-assistant's evening digest) reads both. The package's agent is played by test/fixtures/faux-template-eval.mjs.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FAUX_CALENDAR, startIcsFaux } from "../dist/calendar/ics-faux.js";
import { CaseError, evalTemplate, readCases } from "../dist/template-eval.js";
import { asOwner, scratch, serve, withEnv } from "./support.mjs";

const FAUX = new URL("./fixtures/faux-template-eval.mjs", import.meta.url).pathname;
const STATE = await scratch();
process.env.AGENTRUN_TEST_EVAL_COUNTER = join(STATE, "counter");
process.env.AGENTRUN_TEST_EVAL_GRADER_LOG = join(STATE, "graders.jsonl");
const graderInputs = () => readFileSync(process.env.AGENTRUN_TEST_EVAL_GRADER_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const graderOf = (run, file) => run.graders.find((g) => g.grader === file);
const calls = (list) => list.map(([tool, args]) => `Call ${tool} with ${JSON.stringify(args)}`).join("\n");
const indented = (text, by) => text.split("\n").map((line) => `${" ".repeat(by)}${line}`).join("\n");

/** A package granting `tools`, its prompt a plain run's; each case its files (case.yaml, prompt.md, fixtures, graders). */
async function calendarPackage(t, { tools = ["calendar_events"], triggers = [], cases = {} } = {}) {
  const dir = join(await scratch(t), "calpkg");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), [
    "---",
    "name: calpkg",
    "version: 0.1.0",
    "description: Reads the calendar, and the inbox, for a digest.",
    "harness: [pi]",
    `tools: [${tools.join(", ")}]`,
    "budget: { per_run_usd: 0.5 }",
    ...(triggers.length ? ["triggers:", ...triggers] : []),
    "---",
    "You read the calendar.",
    "",
  ].join("\n"));
  for (const [name, files] of Object.entries(cases)) {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(dir, "evals", name, file.split("/").slice(0, -1).join("/")), { recursive: true });
      writeFileSync(join(dir, "evals", name, file), text);
    }
    mkdirSync(join(dir, "evals", name, "graders"), { recursive: true });
  }
  return dir;
}

/** The week's case: the window from its clock (now) for 7 days, read with no arguments. */
const WEEK = {
  "case.yaml": "calendar: fixtures/work.ics\nnow: \"2026-11-16T09:00:00-05:00\"\n",
  "prompt.md": `---\ndescription: The week ahead, from Monday morning.\n---\n${calls([["calendar_events", {}]])}\nAnswer:\nWEEK {{last-result}}\n`,
  "fixtures/work.ics": FAUX_CALENDAR,
  "graders/read.md": "---\ntype: tool_used\ntool: calendar_events\ncount: 1\n---\n",
  "graders/judged.md": "---\ntype: llm\n---\nPass if the answer contains \"Standup (moved)\".\n",
};

test("a case's calendar must be an .ics file in the case, an iCalendar file, for a package that names calendar_events; only the eval's own server honours it", async (t) => {
  const problemsOf = async (pkg) => {
    try {
      readCases(await calendarPackage(t, pkg));
    } catch (error) {
      assert.ok(error instanceof CaseError, error.stack);
      return error.problems.join("\n");
    }
    return "";
  };
  assert.equal(await problemsOf({ cases: { week: WEEK } }), "");
  assert.match(await problemsOf({ cases: { week: { ...WEEK, "case.yaml": "calendar: ../work.ics\n" } } }), /calendar is an iCalendar file \(\.ics\) in the case/);
  assert.match(await problemsOf({ cases: { week: { ...WEEK, "case.yaml": "calendar: fixtures/work.txt\n", "fixtures/work.txt": FAUX_CALENDAR } } }), /calendar is an iCalendar file \(\.ics\) in the case/);
  assert.match(await problemsOf({ cases: { week: { ...WEEK, "fixtures/work.ics": "<html>no</html>" } } }), /fixtures\/work\.ics: is not an iCalendar file/);
  assert.match(await problemsOf({ tools: ["web_fetch"], cases: { week: WEEK } }), /calendar fakes the server's calendar, and the package's tools don't name calendar_events/);
  const dir = await calendarPackage(t, { cases: { week: WEEK } });
  const NAMED = "http://127.0.0.1:9/v2"; // key-gate: loopback-rule a named server that is never reached
  await assert.rejects(evalTemplate({ dir, server: { baseUrl: NAMED, token: "t" } }), (error) => error instanceof CaseError && error.problems.some((p) => /calendar fakes the server's calendar on the eval's own server alone/.test(p)));
});

test("a package naming calendar_events applies on a server with no calendar as one naming the email tools does with no account: no refusal, no warning; its run is told there is none", { timeout: 150_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const both = await calendarPackage(t, { tools: ["read", "email_search", "calendar_events"] });
  const dir = join(both, "..");
  mkdirSync(join(dir, "mailonly"), { recursive: true });
  writeFileSync(join(dir, "mailonly", "agent.md"), readFileSync(join(both, "agent.md"), "utf8").replace("name: calpkg", "name: mailonly").replace(", calendar_events]", "]"));
  const { api } = await serve(t, { templates: dir, faux: FAUX });
  const listed = (await api("GET", "/templates")).body.templates.find((one) => one.name === "calpkg");
  assert.ok(listed, "listed");
  const calendar = await api("POST", "/templates/calpkg/apply", {});
  assert.equal(calendar.status, 201, JSON.stringify(calendar.body));
  const mail = await api("POST", "/templates/mailonly/apply", {});
  assert.equal(mail.status, 201, JSON.stringify(mail.body));
  assert.deepEqual(calendar.body.warnings ?? [], mail.body.warnings ?? [], "the same warnings as the email tools' package: none for calendar_events");
  const agent = (await api("GET", `/agents/${calendar.body.agent_id}`)).body;
  assert.ok(agent.definition.tools.includes("calendar_events"), JSON.stringify(agent.definition.tools));
  const started = await api("POST", `/agents/${calendar.body.agent_id}/runs`, { input: { content: `${calls([["calendar_events", {}]])}\nAnswer:\nSAID {{last-result}}` } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const deadline = Date.now() + 55_000;
  let view;
  for (;;) {
    view = (await api("GET", `/runs/${started.body.run_id}`)).body;
    if (["completed", "failed", "cancelled"].includes(view.status)) break;
    assert.ok(Date.now() < deadline, JSON.stringify(view));
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(view.status, "completed", JSON.stringify(view));
  assert.match(view.result?.final_answer ?? "", /^SAID calendar_events: This server has no calendar: save its iCal address in Settings → Calendar\./);
});

test("a calendar case's runs read its fake calendar on its clock: the window is the case's week, and its graders see each call with its arguments and answer", { timeout: 300_000 }, async (t) => {
  const dir = await calendarPackage(t, { cases: { week: WEEK } });
  const report = await evalTemplate({ dir, cases: ["week"], serve: { faux: FAUX } });
  const [c] = report.cases;
  const [run] = c.runs;
  assert.equal(run.status, "completed", JSON.stringify(c, null, 1));
  const answer = JSON.parse(run.answer.replace(/^WEEK /, ""));
  assert.deepEqual([answer.calendar, answer.from, answer.to], ["Work", "2026-11-16T09:00:00-05:00", "2026-11-23T09:00:00-05:00"]);
  assert.deepEqual(answer.events.map((e) => e.title), ["Standup (moved)", "Call with Pune", "Launch review", "Lunch"]);
  assert.equal(graderOf(run, "read.md").pass, true, JSON.stringify(run.graders));
  assert.equal(graderOf(run, "judged.md").pass, true, JSON.stringify(run.graders));
  assert.equal(c.pass, true);
  const seen = graderInputs().at(-1);
  assert.match(seen, /calendar_events \{\}/, "the call with its arguments");
  assert.match(seen, /Standup \(moved\)/, "and its answer");
  assert.ok(!/private-[0-9a-f]{32}/.test(seen), "never the fake calendar's address");
});

test("an email case with a calendar (an evening digest): the schedule's run reads the fake mailbox and the fake calendar on the case's day", { timeout: 300_000 }, async (t) => {
  const digest = `${calls([["email_search", { subject: "Lunch on Friday" }], ["calendar_events", { from: "2026-11-17", to: "2026-11-17" }]])}\nAnswer:\nDIGEST {{last-result}}`;
  const mailbox = { description: "One message in the inbox, for the evening digest.", account: { address: "agent@acme.example" }, mailboxes: { INBOX: [{ from: "bo@example.com", to: ["agent@acme.example"], subject: "Lunch on Friday", date: "2026-11-17T11:00:00Z", message_id: "<b1@example.com>", text: "Lunch on Friday?" }] } };
  const dir = await calendarPackage(t, {
    tools: ["email_search", "email_read", "email_draft", "calendar_events"],
    triggers: ["  - name: Evening digest", "    source: { kind: schedule, cron: \"0 18 * * *\", timezone: America/New_York }", "    target:", "      kind: start_run", "      input:", "        content: |", indented(digest, 10)],
    cases: {
      digest: {
        "case.yaml": "email: fixtures/mailbox.json\ncalendar: fixtures/work.ics\nnow: \"2026-11-17T18:00:00-05:00\"\n",
        "prompt.md": "---\ndescription: Tuesday's evening digest.\n---\n",
        "fixtures/mailbox.json": JSON.stringify(mailbox),
        "fixtures/work.ics": FAUX_CALENDAR,
        "graders/judged.md": "---\ntype: llm\n---\nPass if the answer contains \"Standup (moved)\".\n",
      },
    },
  });
  const report = await evalTemplate({ dir, cases: ["digest"], serve: { faux: FAUX } });
  const [c] = report.cases;
  const [run] = c.runs;
  assert.equal(run.status, "completed", JSON.stringify(c, null, 1));
  assert.deepEqual(run.calls.map((call) => call.tool), ["email_search", "calendar_events"], JSON.stringify(run.calls));
  // The answer, then the schedule's line the run's input ends with ("(Started by the schedule ...)"), which the faux model
  // says back as part of it.
  const answer = JSON.parse(run.answer.replace(/^DIGEST /, "").replace(/\s*\(Started by the schedule [^)]*\)\s*$/, ""));
  assert.deepEqual(answer.events.map((e) => [e.title, e.start]), [["Standup (moved)", "2026-11-17T14:00:00-05:00"]]);
  assert.equal(c.pass, true, JSON.stringify(run.graders));
});

test("on an owner's folder whose server keeps a calendar, a calendar case is refused before anything runs, and the calendar stays", { timeout: 150_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const faux = await startIcsFaux();
  t.after(() => faux.close());
  const data = join(await scratch(), "agents");
  const first = await serve(t, { data });
  assert.equal((await asOwner(first)("PUT", "/settings/calendar", { url: faux.address })).status, 200);
  await first.stop();
  const dir = await calendarPackage(t, { cases: { week: WEEK } });
  await assert.rejects(evalTemplate({ dir, data, serve: { faux: FAUX } }), /keeps a calendar \(Work\), and a calendar case saves its fake calendar as the server's calendar in its place/);
  const again = await serve(t, { data });
  assert.equal((await asOwner(again)("GET", "/settings/calendar")).body.configured, true, "the calendar stays");
});
