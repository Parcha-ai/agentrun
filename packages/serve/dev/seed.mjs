#!/usr/bin/env node
// Seeds a data directory with sample agents, revisions and runs for working on the page: six agents of both kinds, their
// revisions with notes, and runs in every state, all made through /v2 on dev/faux.mjs (no key, no network). Synthetic
// content only. `npm run dev` then serves the directory.
import { existsSync, readdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startServe } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
export const FAUX = join(here, "faux.mjs");
export const DEFAULT_DATA = join(here, ".data");
/** Marks a directory this script made, the only kind `--reset` removes. */
const MARK = ".dev-seed";

const tick = (ms) => new Promise((done) => setTimeout(done, ms));

function client(baseUrl, token) {
  return async function api(method, path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 400)}`);
    return json;
  };
}

const SKILL = `---
name: totals-rubric
description: How to recompute an invoice's lines and total.
---
1. Multiply quantity by unit price for every line, to the cent.
2. Add the lines; compare with the printed total.
3. Report each difference with the line number and both amounts.
`;

const triage = (gated) => ({
  v: 2,
  name: "support-triage",
  schemas: {
    Ticket: { type: "object", required: ["subject", "body"], properties: { subject: { type: "string" }, body: { type: "string" } } },
    Triage: {
      type: "object",
      required: ["category", "urgency", "summary"],
      properties: { category: { type: "string", enum: ["billing", "bug", "account", "question"] }, urgency: { type: "number" }, summary: { type: "string" } },
    },
    Reply: { type: "object", required: ["reply"], properties: { reply: { type: "string" } } },
  },
  input: { schemaId: "Ticket" },
  output: { schemaId: "Reply", path: "reply" },
  root: {
    node: "chain",
    steps: [
      { node: "extract", label: "classify", instructions: "Classify the ticket: its category, its urgency from 1 to 10, and a one-sentence summary.", out: "Triage", as: "triage", tier: "fast" },
      ...(gated ? [{ node: "escalate", label: "urgent", when: { predicate: "gte", path: "triage.urgency", n: 8 }, kind: "review", stage: "gate", summary: "urgency 8 or more goes to the on-call person" }] : []),
      { node: "extract", label: "draft reply", instructions: "Draft a short, kind reply that says what happens next.", out: "Reply", as: "reply" },
    ],
  },
});

const leads = {
  v: 2,
  name: "lead-scorer",
  schemas: {
    Lead: { type: "object", required: ["company", "note"], properties: { company: { type: "string" }, note: { type: "string" } } },
    Facts: { type: "object", required: ["score", "reason"], properties: { score: { type: "number" }, reason: { type: "string" } } },
    Next: { type: "object", required: ["qualified", "next_step"], properties: { qualified: { type: "boolean" }, next_step: { type: "string" } } },
  },
  input: { schemaId: "Lead" },
  output: { schemaId: "Next", path: "next" },
  root: {
    node: "chain",
    steps: [
      { node: "extract", label: "score", instructions: "Score the lead from 0 to 100 and say why in one sentence.", out: "Facts", as: "facts", tier: "fast" },
      { node: "decide", label: "qualify", instructions: "Decide whether the lead is qualified, and the next step.", out: "Next", as: "next" },
    ],
  },
};

/** Each agent: its revisions in order (the first is the create), then its runs, each on a revision by position. */
const AGENTS = [
  {
    id: "invoice-checker",
    revisions: [
      { note: "First prompt", definition: { name: "Invoice checker", description: "Recomputes an invoice's lines and total and reports what is off.", instructions: "Check the invoice the person pastes. Recompute every line and the total, write your findings to findings.md, and answer with a table.", tools: ["read", "write"] } },
      { note: "Adds the totals rubric as a skill", skills: { "totals-rubric/SKILL.md": SKILL }, definition: { instructions: "Check the invoice the person pastes with the totals-rubric skill. Write your findings to findings.md, and answer with a table.", tools: ["read", "write"], skills: ["totals-rubric"] } },
      { note: "Asks for the currency when it is missing; thinks harder", definition: { instructions: "Check the invoice the person pastes with the totals-rubric skill. If the currency is not stated, ask the person before you compute. Write your findings to findings.md, and answer with a table.", tools: ["read", "write", "ask_person"], skills: ["totals-rubric"], thinking: "high" } },
    ],
    runs: [
      { on: 0, input: "Check invoice INV-1041 from the hosting vendor: hosting 420.00, 12 support hours at 85.00, 2 domains at 18.50, total 1,479.00." },
      { on: 0, input: "Check invoice INV-1042: hosting 420.00, total 420.00." },
      { on: 0, input: "Check invoice INV-0998 from the print shop: 500 flyers at 0.12, total 60.00.", archive: true },
      { on: 1, input: "Check invoice INV-1043 from the hosting vendor: hosting 420.00, 10 support hours at 85.00, total 1,270.00." },
      { on: 1, input: "Check invoice INV-1044 from the design studio: 3 days at 650.00, total 1,950.00." },
      { on: 1, input: "Check invoice INV-1045 from the cleaning service: 4 visits at 95.00, supplies 32.40, total 412.40." },
      { on: 2, input: "Check invoice INV-1046 (the currency is missing): consulting 2,400.00, travel 310.00, total 2,710.00.", until: "input_required" },
      { on: 2, input: "Check invoice INV-1047 (the currency is missing): licenses 12 at 30.00, total 360.00.", until: "input_required", answer: "EUR" },
      { on: 2, input: "Check invoice INV-1048 from the hosting vendor: hosting 440.00, total 440.00." },
      { on: 2, input: "Check invoice INV-1049 from the hosting vendor: hosting 440.00, 6 support hours at 85.00, total 950.00.", max_cost_usd: 0.000001 },
    ],
  },
  {
    id: "release-notes",
    revisions: [
      { note: "First prompt", definition: { name: "Release notes writer", description: "Turns a list of merged changes into release notes people can read.", instructions: "Write release notes from the merged changes the person lists. Draft CHANGELOG.md, fix what you got wrong, and answer with the notes.", tools: ["write", "edit"] } },
      { note: "Groups changes by area, in a table", definition: { instructions: "Write release notes from the merged changes the person lists: highlights first, then a table of changes by area, then fixes and upgrade notes. Draft CHANGELOG.md, fix what you got wrong, and answer with the notes.", tools: ["write", "edit"] } },
    ],
    runs: [
      { on: 0, input: "Write the release notes for 2.3.1 from: #401 fix export encoding, #402 faster startup." },
      { on: 1, input: "Write the release notes for 2.4.0 from: #412 incremental search, #418 typo tolerance, #420 theme switch, #423 CSV leading zeros." },
      { on: 1, input: "Write the release notes for 2.4.1 from: #430 fix the sign-in page on phones, #431 wrap long project names." },
      { on: 1, input: "Write the release notes for 2.5.0 (expect a provider outage) from: #440 audit log, #441 roles." },
    ],
  },
  {
    id: "meeting-notes",
    revisions: [
      { note: "First prompt", definition: { name: "Meeting notes", description: "Summarizes a meeting transcript into decisions, action items and open questions.", instructions: "Summarize the meeting transcript into decisions, action items with owners, and open questions." } },
      { note: "Shorter: three sections, no preamble", definition: { instructions: "Summarize the meeting transcript in three sections: Decisions, Action items (with owners), Open questions. No preamble.", thinking: "low" } },
    ],
    runs: [
      { on: 0, input: "Summarize the weekly product meeting: we agreed to ship the beta on the 3rd and keep the free tier at 100 runs." },
      { on: 1, input: "Summarize the pricing meeting: the free tier stays, the FAQ needs a draft, and nobody knows our downtime yet." },
      { on: 1, input: "Summarize the launch meeting: the waitlist email is due Friday and the usage chart is next sprint." },
      { on: 1, input: "Summarize the design workshop transcript (all four hours of it).", until: "working" },
      { on: 1, input: "Summarize the design workshop recording from Tuesday.", until: "working", then: "cancel" },
      { on: 1, input: "Summarize the design workshop notes from the offsite.", until: "working", then: "stop" },
      { on: 1, input: "Summarize the design workshop whiteboard photos.", until: "working", then: "stop", followUp: "Summarize what you have so far." },
      { on: 0, input: "Summarize the garbled meeting recording from the call with bad audio." },
    ],
  },
  {
    id: "support-triage",
    revisions: [
      { note: "Classify, then draft a reply", definition: { name: "Support triage", description: "Classifies a support ticket and drafts the reply.", workflow: triage(false) } },
      { note: "Urgent tickets go to a person first", definition: { workflow: triage(true) } },
    ],
    runs: [
      { on: 0, input: { subject: "Invoice shows the wrong plan", body: "We moved to the team plan last month but the invoice still says starter." } },
      { on: 0, input: { subject: "How do I export my data?", body: "Is there a way to download every project as CSV?" } },
      { on: 1, input: { subject: "Password reset email never arrives", body: "Tried three times this morning, nothing in spam either." } },
      { on: 1, input: { subject: "Feature question", body: "Can two people edit the same document at once?" } },
      { on: 1, input: { subject: "Everything is down", body: "Our whole team cannot log in since 9:00, this is an outage." } },
      { on: 1, input: { subject: "Data loss after the update", body: "Half of yesterday's entries are gone after the app updated, possible data loss." } },
      { on: 1, input: { subject: "Bulk import takes a while", body: "Importing 40,000 rows; it takes a while, just checking it is still going." }, until: "working" },
      { on: 1, input: { subject: "Second bulk import takes a while", body: "Another large import; it takes a while too." }, until: "working", then: "cancel" },
    ],
  },
  {
    id: "lead-scorer",
    revisions: [{ note: "Score, then qualify", definition: { name: "Lead scorer", description: "Scores an inbound lead and decides the next step.", workflow: leads } }],
    runs: [
      { on: 0, input: { company: "Acme Outdoor Supply", note: "500 seats, annual contract, security review next month." } },
      { on: 0, input: { company: "Example Tutoring Club", note: "Student project, no budget yet." } },
      { on: 0, input: { company: "Sample Freight Cooperative", note: "Enterprise trial running, champion is the ops lead." } },
    ],
  },
  {
    id: "recipe-scaler",
    archive: true,
    revisions: [{ note: "First prompt", definition: { name: "Recipe scaler", description: "Scales a recipe to a number of servings. Archived: replaced by a spreadsheet.", instructions: "Scale the recipe to the servings the person asks for, in grams and millilitres." } }],
    runs: [
      { on: 0, input: "Scale the garlic pasta recipe from 4 to 6 servings." },
      { on: 0, input: "Scale the pancake recipe from 2 to 8 servings." },
    ],
  },
];

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/** Polls the run until its status is one of `want`, or two minutes pass. */
async function until(api, id, want) {
  for (const deadline = Date.now() + 120_000; Date.now() < deadline; await tick(150)) {
    const run = await api("GET", `/runs/${id}`);
    if (want.includes(run.status)) return run;
    if (TERMINAL.has(run.status)) throw new Error(`run ${id} ended ${run.status} while waiting for ${want.join(" or ")}: ${JSON.stringify(run.error)}`);
  }
  throw new Error(`run ${id} never reached ${want.join(" or ")}`);
}

/** One run: start it, wait for what it should reach, then answer, stop, cancel or follow up as the plan says. */
async function play(api, agent, revisions, plan) {
  const body = { input: typeof plan.input === "string" ? { content: plan.input } : plan.input, revision: revisions[plan.on], ...(plan.max_cost_usd ? { max_cost_usd: plan.max_cost_usd } : {}) };
  const { run_id: id } = await api("POST", `/agents/${agent}/runs`, body);
  if (plan.until === "working") await until(api, id, ["working"]);
  if (plan.until === "input_required") await until(api, id, ["input_required"]);
  if (plan.answer) await api("POST", `/runs/${id}/messages`, { content: plan.answer });
  if (plan.then === "cancel") await api("POST", `/runs/${id}/cancel`);
  if (plan.then === "stop") {
    await tick(300);
    await api("POST", `/runs/${id}/stop`);
    await until(api, id, ["input_required"]);
  }
  if (plan.followUp) await api("POST", `/runs/${id}/messages`, { content: plan.followUp });
  const settled = !plan.until || plan.answer || plan.then === "cancel" || plan.followUp;
  if (settled) await until(api, id, [...TERMINAL]);
  if (plan.archive) await api("POST", `/runs/${id}/archive`);
  return id;
}

/** Runs `jobs` at most `width` at a time. */
async function pool(jobs, width) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < jobs.length) {
      const at = next++;
      results[at] = await jobs[at]();
    }
  }));
  return results;
}

export async function seed({ data = DEFAULT_DATA, reset = false, width = 6, log = console.log } = {}) {
  data = resolve(data);
  if (existsSync(data) && readdirSync(data).length) {
    if (!reset) throw new Error(`${data} is not empty; pass --reset to seed it again`);
    if (!existsSync(join(data, MARK))) throw new Error(`${data} was not made by this script (no ${MARK}); remove it yourself or pick another --data`);
    await rm(data, { recursive: true, force: true });
  }
  await mkdir(data, { recursive: true });
  await writeFile(join(data, MARK), "sample data made by packages/serve/dev/seed.mjs\n");
  const server = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "1s" });
  try {
    const api = client(server.baseUrl, server.token);
    const jobs = [];
    for (const agent of AGENTS) {
      const revisions = [];
      for (const [at, { note, definition, skills }] of agent.revisions.entries()) {
        const body = { definition: at === 0 ? { id: agent.id, ...definition } : definition, note, ...(skills ? { skills } : {}) };
        const made = at === 0 ? await api("POST", "/agents", body) : await api("PUT", `/agents/${agent.id}/definition`, body);
        revisions.push(made.revision);
      }
      for (const plan of agent.runs) jobs.push(() => play(api, agent.id, revisions, plan));
    }
    const ids = await pool(jobs, width);
    for (const agent of AGENTS.filter((a) => a.archive)) await api("POST", `/agents/${agent.id}/archive`);
    const all = [...(await api("GET", "/runs?limit=100")).runs, ...(await api("GET", "/runs?limit=100&archived=true")).runs];
    const counts = {};
    for (const run of all) counts[run.status] = (counts[run.status] ?? 0) + 1;
    log(`seeded ${AGENTS.length} agents and ${ids.length} runs in ${data}: ${Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(", ")}`);
    return { data, runs: ids.length, counts };
  } finally {
    await server.close();
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { data: { type: "string" }, reset: { type: "boolean", default: false } } });
  seed({ data: values.data, reset: values.reset }).catch((error) => {
    console.error(`seed: ${error.message}`);
    process.exit(1);
  });
}
