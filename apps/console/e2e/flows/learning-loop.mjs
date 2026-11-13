// The self-learning loop told on an agent's Learning tab, in the browser at three widths and both themes, on an invented
// invoice-sorter agent: notes (two of them compiled into its workflow), a first compile held on its replay, a revised one
// promoted at run 21, a threshold refit at run 51, a later draft the checks refused. The real view is answered with those
// notes and the workflow listed; the loop's reads (GET .../learning/cost, .../promotions, .../loop and the workflow's
// revisions) with invented records. The story strip tells the loop end to end; the cost chart flags each record on its run
// lettered (P, H, R, F) with the server's own headline and the hand-back rate; the workflow card says the newest revision
// serves, carries each step's guard on its card and lists where it is unsure; scrubbing back to the refit's source says so;
// the feed says the refused draft in the checks' own words; a note says what it was compiled into. Nothing past any card's
// edge and no sideways scroll. E2E_SHOTS=<dir> saves each width and theme, each image stamped "Example data".
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { check, markExample } from "../harness.mjs";

const SAMPLE = JSON.parse(readFileSync(new URL("../../src/components/CostPerRun.sample.json", import.meta.url), "utf8"));
export const WIDTHS = [1440, 820, 390];
const WF = "sort-invoice";
const D0 = "c0ffee00c0ffee00", D1 = "a12596c0a12596c0", D2 = "1a48d30c1a48d30c";
const runAt = (n) => SAMPLE.runs.find((r) => r.n === n);
const later = (n, minutes) => new Date(Date.parse(runAt(n).started_at) - minutes * 60_000).toISOString();

const schemas = { Answer: { type: "object", required: ["account"], properties: { account: { type: "string" } } } };
const flow = (threshold, fitted) => ({ v: 2, name: WF, schemas, input: { schemaId: "Answer" }, output: { schemaId: "Answer", path: "account" }, root: { node: "chain", steps: [
  { node: "extract", label: "read lines", instructions: "Read the invoice's vendor, lines and total.", out: "Answer", as: "lines" },
  { node: "extract", label: "classify", instructions: "Sort the invoice into a ledger account by vendor.", out: "Answer", as: "account", guard: { signal: "jev", threshold, ...(fitted ? { fit: { w: [2.1], b: -1.2, n: 40 } } : {}) } },
  { node: "extract", label: "check total", instructions: "Check the total against the lines.", out: "Answer", as: "checked", guard: { signal: "both", threshold: 0.6 } },
] } });
const REVISIONS = [
  { commit: "1".repeat(40), at: later(11, -5), by: { run: runAt(11).run_id }, reason: "Compiled from three notes.", text: JSON.stringify({ ...flow(0.7), root: { node: "chain", steps: flow(0.7).root.steps.slice(0, 2) } }), digest: D0 },
  { commit: "2".repeat(40), at: later(17, -5), by: { run: runAt(17).run_id }, reason: "Revised after its replay was held: a total check added.", text: JSON.stringify(flow(0.7)), digest: D1 },
  { commit: "3".repeat(40), at: later(51, 10), by: { user: true }, reason: "Thresholds refit on 40 graded runs.", text: JSON.stringify(flow(0.78, true)), digest: D2 },
];
const REPLAY = (n, wf, agent, back) => ({ of: [], n, agree: Math.round(n * 0.9), agent_acc: agent, wf_acc: wf, delta: Math.round((wf - agent) * 1000) / 1000, handed_back: back });
const PROMOTIONS = [
  { workflow: WF, digest: D0, at: later(12, 10), decided: "replaying", source: "replay", reason: "A new revision replays on the last 20 graded inputs.", runs: [] },
  { workflow: WF, digest: D0, at: later(14, 10), decided: "hold", source: "replay", reason: "Held: it did worse than the agent on its graded inputs.", replay: REPLAY(20, 0.85, 0.94, 3) },
  { workflow: WF, digest: D1, at: later(18, 10), decided: "replaying", source: "replay", reason: "A new revision replays on the last 20 graded inputs.", runs: [] },
  { workflow: WF, digest: D1, at: later(21, 10), decided: "promote", source: "replay", reason: "As good as the agent on its graded inputs.", replay: REPLAY(20, 0.95, 0.94, 2) },
  { workflow: WF, digest: D2, at: later(51, 10), decided: "promote", source: "refit", reason: "Refit: the cheapest thresholds within 2 pts.", replay: REPLAY(40, 0.95, 0.94, 3), refit: { from: D1, guards: [{ node: "classify", was: 0.7, threshold: 0.78 }] } },
];
// Each guarded step's runs: p from a fixed walk (no randomness), right or wrong where the workflow answered alone.
const points = (from, to, threshold, low) => SAMPLE.runs.filter((r) => r.n >= from && r.n <= to && r.path !== "agent").map((r, i) => {
  const p = r.path === "handed_back" ? (i % 3 === 0 ? null : 0.3 + (i % 4) * 0.08) : Math.min(0.99, 0.72 + ((i * 37) % 27) / 100 - (i % 9 === 0 ? low : 0));
  const escalated = p === null || p < threshold;
  return { run_id: r.run_id, p, escalated, correct: r.path === "workflow" && !escalated ? i % 11 !== 5 : null };
});
const guard = (digest, node, signal, threshold, from, to, low) => { const ps = points(from, to, threshold, low); return { workflow: WF, digest, node, signal, threshold, runs: ps.length, escalated: ps.filter((p) => p.escalated).length, points: ps }; };
const LOOP = {
  compiles: [
    { run_id: runAt(45).run_id, at: later(45, -5), workflow: null, from_notes: ["vendor-codes"], attempts: [{ ok: false, errors: ["/root/steps/1: an extract step's out names a schema the workflow does not define (Account)"] }, { ok: false, errors: ["the dry run handed back on every input: classify never reached 0.78"] }, { ok: false, errors: ["the draft is not JSON: Unexpected token } at 412"] }], digest: null, promoted: null, draft_errors: [], withheld: false },
    { run_id: runAt(17).run_id, at: later(17, -5), workflow: WF, from_notes: ["vendor-codes", "totals-include-tax", "credit-notes"], attempts: [{ ok: true, errors: [] }], digest: D1, promoted: true, draft_errors: [], withheld: false },
    { run_id: runAt(11).run_id, at: later(11, -5), workflow: WF, from_notes: ["vendor-codes", "totals-include-tax", "credit-notes"], attempts: [{ ok: false, errors: ["/root/steps/1: a guard needs a label"] }, { ok: true, errors: [] }], digest: D0, promoted: false, draft_errors: [], withheld: false },
  ],
  guards: [guard(D1, "classify", "jev", 0.7, 18, 50, 0.3), guard(D1, "check total", "both", 0.6, 18, 50, 0.1), guard(D2, "classify", "jev", 0.78, 51, 80, 0.35), guard(D2, "check total", "both", 0.6, 51, 80, 0.05)],
};
const fm = (name, description, extra = "") => `---\nname: ${name}\ndescription: ${description}\ntype: reference\n${extra}---\n`;
const NOTES = [
  ["vendor-codes", "Vendor codes", "Which ledger account each vendor's invoices go to", "compiled_into: sort-invoice\n", "Acme Paper goes to 6100 Office supplies; Northwind Freight to 6400 Shipping."],
  ["totals-include-tax", "Totals include tax", "An invoice total is the lines plus tax", "compiled_into: sort-invoice\n", "Check the total against the lines plus the tax line, not the lines alone."],
  ["credit-notes", "Credit notes", "A negative total is a credit note", "", "A credit note goes to the account of the invoice it credits."],
].map(([slug, name, description, extra, body]) => ({ file: `${slug}.md`, name, description, type: "reference", status: "active", superseded_by: null, runs: { given: 60, read: 41 }, etag: `"${slug}"`, origin: "run", text: `${fm(name, description, extra)}${body}\n` }));
const ITEM = { name: WF, file: `workflows/${WF}/workflow.json`, readme: `workflows/${WF}/README.md`, description: "Sorts an invoice into its ledger account", status: "active", run: null, bytes: 1400, etag: '"w"' };

/** Each card's box against the page and its own content: text past a card's right edge, and a page wider than the view. */
function measure() {
  const past = [];
  for (const card of document.querySelectorAll('[data-testid="loop-story"], [data-testid="cost-per-run"], [aria-label="Learned workflow"], [data-testid="loop-feed"]')) {
    const edge = card.getBoundingClientRect().right;
    for (const t of card.querySelectorAll("p, span, h2, h3, li, text")) if (t.getBoundingClientRect().width && t.getBoundingClientRect().right > edge + 1 && !t.closest('[class*="overflow-auto"]')) past.push(`${card.getAttribute("data-testid") ?? card.getAttribute("aria-label")}: "${(t.textContent ?? "").slice(0, 40)}"`);
  }
  return { past, sideways: document.documentElement.scrollWidth > window.innerWidth + 1 };
}

export default {
  name: "learning-loop",
  signedIn: true,
  async run({ page, base, api }) {
    const made = await api("POST", "/agents", { definition: { version: 1, name: "Invoice sorter", description: "Sorts an invoice into its ledger account.", instructions: "Answer with the ledger account.", harness: "pi", tools: [], skills: [], learning: true } });
    check(made.status === 201 || made.status === 200, `POST /v2/agents answered ${made.status}: ${JSON.stringify(made.body)}`);
    const id = made.body.agent_id;
    const enc = encodeURIComponent(id);
    // The real reads first: a fresh agent's loop and promotions read empty.
    const fresh = await api("GET", `/agents/${enc}/learning/loop`);
    check(fresh.status === 200 && fresh.body.compiles.length === 0 && fresh.body.guards.length === 0, `a fresh agent's loop read: ${fresh.status} ${JSON.stringify(fresh.body)}`);
    await page.route(new RegExp(`/v2/agents/${enc}/learning$`), async (route) => { const real = await (await route.fetch()).json(); route.fulfill({ json: { ...real, notes: { items: NOTES, total: NOTES.length, next_cursor: null }, workflows: [ITEM] } }); });
    await page.route(new RegExp(`/v2/agents/${enc}/learning/cost(\\?.*)?$`), (route) => route.fulfill({ json: { ...SAMPLE, agent: id } }));
    await page.route(new RegExp(`/v2/agents/${enc}/learning/promotions$`), (route) => route.fulfill({ json: { agent: id, promotions: PROMOTIONS } }));
    await page.route(new RegExp(`/v2/agents/${enc}/learning/loop$`), (route) => route.fulfill({ json: { agent: id, ...LOOP } }));
    await page.route(new RegExp(`/v2/agents/${enc}/learning/workflows/${WF}/revisions(\\?.*)?$`), (route) => route.fulfill({ json: { name: WF, revisions: REVISIONS, total: REVISIONS.length, truncated: false } }));
    const shots = process.env.E2E_SHOTS;
    if (shots) mkdirSync(shots, { recursive: true });
    const shoot = async (box, name) => { if (shots) { await box.scrollIntoViewIfNeeded(); await markExample(box); await box.screenshot({ path: join(shots, name) }); } };
    const wrong = [];
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => localStorage.setItem("agentrun.theme", t), theme);
      for (const width of WIDTHS) {
        const at = `${theme} ${width}px`;
        await page.setViewportSize({ width, height: width < 600 ? 3200 : 2000 });
        await page.goto(`${base}/#/agents/${enc}/learning`);
        await page.reload();
        const story = page.getByTestId("loop-story");
        await story.getByText("7.0x cheaper").waitFor().catch(async (e) => { if (shots) await page.screenshot({ path: join(shots, "learning-loop-failed.png"), fullPage: true }); throw e; });
        await page.getByRole("region", { name: "Learned workflow" }).getByText("Revision 3 of 3").waitFor();
        await page.evaluate(() => document.fonts.ready);
        check(await page.evaluate((t) => document.documentElement.classList.contains(t), theme), `${at}: the page is not in the ${theme} theme`);

        // The story: each stage's value and state.
        const stages = await story.locator("li").evaluateAll((els) => els.map((el) => `${el.getAttribute("data-testid")}=${el.getAttribute("data-state")}:${el.querySelector('[data-testid$="-value"]')?.textContent}`));
        check(stages.join("|") === `stage-notes=done:3 notes|stage-compiled=done:${WF}|stage-took_over=done:Run 21|stage-cheaper=done:7.0x cheaper|stage-unsure=watch:5% handed back`, `${at}: the story says ${stages.join("|")}`);
        await shoot(story, `loop-story-${theme}-${width}.png`);

        // The cost chart: a flag per record kind on its run, the server's headline with the hand-back rate.
        const cost = page.getByTestId("cost-per-run");
        const flags = await cost.locator('g[data-testid^="marker-"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
        check(flags.join() === "marker-revision,marker-hold,marker-revision,marker-promote,marker-refit", `${at}: the chart's markers are ${flags.join()}`);
        const headline = await cost.locator("h3 + p").textContent();
        check(/^\$0\.890 a run before takeover, \$0\.128 all-in after: 7\.0x cheaper · 5% handed back since$/.test(headline ?? ""), `${at}: the headline says ${headline}`);
        await shoot(cost, `loop-cost-${theme}-${width}.png`);
        // A flag's hover says its record.
        const flag = cost.locator('g[data-testid="marker-promote"] rect').first();
        const fb = await flag.boundingBox();
        await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
        const tip = cost.getByTestId("marker-tip");
        await tip.waitFor({ timeout: 5000 });
        check(/Promoted · run 21/.test((await tip.textContent()) ?? ""), `${at}: the flag's hover says ${await tip.textContent()}`);
        if (width === WIDTHS[0]) await shoot(cost, `loop-cost-${theme}-${width}-flag.png`);
        await page.mouse.move(0, 0);

        // The workflow card: the newest revision serves; each guard on its step's card; where it is unsure.
        const card = page.getByRole("region", { name: "Learned workflow" });
        check(/^ServingRefit on 40 graded inputs: workflow 95% vs agent 94% \(\+1 pts\), 3 handed back$/.test((await card.getByTestId("standing").textContent()) ?? ""), `${at}: the standing says ${await card.getByTestId("standing").textContent()}`);
        const verdicts = await card.locator("svg .verdict").allTextContents();
        check(verdicts.join() === "jev ≥0.78,self+jev ≥0.60", `${at}: the guards on the graph are ${verdicts.join()}`);
        check((await card.getByTestId("guard-row").count()) === 2 && (await card.getByTestId("guard-histogram").count()) === 2, `${at}: the unsure list is not two steps with their p`);
        await shoot(card, `loop-workflow-${theme}-${width}.png`);
        // Scrubbed back one: the refit's source, replaced in place.
        await card.getByRole("button", { name: "Previous revision" }).click();
        check(/^RefitIts thresholds were refit: revision 1a48d30 serves in its place\.$/.test((await card.getByTestId("standing").textContent()) ?? ""), `${at}: revision 2 says ${await card.getByTestId("standing").textContent()}`);
        await card.getByRole("button", { name: "Previous revision" }).click();
        check(/^HeldReplay on 20 graded inputs: workflow 85% vs agent 94% \(-9 pts\), 3 handed back$/.test((await card.getByTestId("standing").textContent()) ?? ""), `${at}: revision 1 says ${await card.getByTestId("standing").textContent()}`);

        // The feed: the refused draft in the checks' words; a note says what it went into.
        const feed = page.getByTestId("loop-feed");
        const errors = await feed.getByTestId("draft-errors").first().locator("li").allTextContents();
        check(errors.length === 3 && errors[2] === "Attempt 3: the draft is not JSON: Unexpected token } at 412", `${at}: the feed's draft errors are ${JSON.stringify(errors)}`);
        await shoot(feed, `loop-feed-${theme}-${width}.png`);
        const noteCard = page.locator('article[aria-label="Vendor codes"]');
        check(/Compiled into sort-invoice/.test((await noteCard.textContent()) ?? ""), `${at}: the note does not say what it was compiled into`);
        if (width === WIDTHS[0]) await shoot(noteCard, `loop-note-${theme}-${width}.png`);

        const m = await page.evaluate(measure);
        for (const t of m.past) wrong.push(`${at}: ${t} runs past its card`);
        if (m.sideways) wrong.push(`${at}: the page scrolls sideways`);
      }
    }
    // Early: an agent with one note and no workflow yet says how far it is from a compile.
    const early = await api("POST", "/agents", { definition: { version: 1, name: "Invoice sorter, new", instructions: "Answer with the ledger account.", harness: "pi", tools: [], skills: [], learning: true } });
    const eid = encodeURIComponent(early.body.agent_id);
    await page.route(new RegExp(`/v2/agents/${eid}/learning$`), async (route) => { const real = await (await route.fetch()).json(); route.fulfill({ json: { ...real, notes: { items: NOTES.slice(0, 1).map((n) => ({ ...n, text: n.text.replace("compiled_into: sort-invoice\n", "") })), total: 1, next_cursor: null } } }); });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => localStorage.setItem("agentrun.theme", t), theme);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1400 });
        await page.goto(`${base}/#/agents/${eid}/learning`);
        await page.reload();
        const story = page.getByTestId("loop-story");
        await story.waitFor();
        const compile = await story.getByTestId("stage-compiled").textContent();
        check(/1 of 3 notes, 0 of 5 runs: a workflow compiles at 3 notes or 5 runs/.test(compile ?? ""), `${theme} ${width}px early: the compile stage says ${compile}`);
        await shoot(story, `loop-early-${theme}-${width}.png`);
      }
    }
    check(!wrong.length, wrong.join("\n"));
  },
};
