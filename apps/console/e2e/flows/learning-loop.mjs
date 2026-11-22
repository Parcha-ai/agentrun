// The self-learning loop told on an agent's Learning tab, in the browser at three widths and both themes, on an invented
// invoice-sorter agent: two corrections from its owner, a first compile held on its one check, its one recompile
// promoted at run 21, a later draft the checks refused. The real view is answered with those corrections and the
// workflow listed; the loop's reads (GET .../learning/cost, .../promotions, .../loop and the workflow's revisions) with
// invented records. The story strip tells the loop end to end, the cheaper stage saying the agreement check it passed
// (never "the same accuracy"); the cost chart flags each record on its run lettered (R, H, P) with the server's own
// headline and the hand-back rate; the workflow card says the newest revision serves; scrubbing back to the first says it
// was held; the feed says the refused draft in the checks' own words; the corrections card counts the lines. Nothing past
// any card's edge and no sideways scroll. E2E_SHOTS=<dir> saves each width and theme, each image stamped "Example data".
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { check, markExample } from "../harness.mjs";

const SAMPLE = JSON.parse(readFileSync(new URL("../../src/components/CostPerRun.sample.json", import.meta.url), "utf8"));
export const WIDTHS = [1440, 820, 390];
const WF = "sort-invoice";
/** The story's cheaper headline: the sample's 7.7 (its served runs only), as the chart's headline says it, and the
 *  serving check it passed (the sample's replay: 38 of 40 agreed, the bar 80%), never "at the same accuracy". */
const CHEAPER = "7.7x cheaper";
const PASSED = "Passed the agreement check: 38 of 40 agreed (bar 80%) · served 59 runs, handed back 3";
const D0 = "c0ffee00c0ffee00", D1 = "a12596c0a12596c0";
const runAt = (n) => SAMPLE.runs.find((r) => r.n === n);
const later = (n, minutes) => new Date(Date.parse(runAt(n).started_at) - minutes * 60_000).toISOString();

const schemas = { Answer: { type: "object", required: ["account"], properties: { account: { type: "string" } } } };
const flow = (steps) => ({ v: 2, name: WF, schemas, input: { schemaId: "Answer" }, output: { schemaId: "Answer", path: "account" }, root: { node: "chain", steps: [
  { node: "extract", label: "read lines", instructions: "Read the invoice's vendor, lines and total.", out: "Answer", as: "lines" },
  { node: "extract", label: "classify", instructions: "Sort the invoice into a ledger account by vendor.", out: "Answer", as: "account" },
  { node: "extract", label: "check total", instructions: "Check the total against the lines.", out: "Answer", as: "checked" },
].slice(0, steps) } });
const REVISIONS = [
  { commit: "1".repeat(40), at: later(11, -5), by: { run: runAt(11).run_id }, reason: "Compiled from the agent's last 20 runs.", text: JSON.stringify(flow(2)), digest: D0 },
  { commit: "2".repeat(40), at: later(17, -5), by: { run: runAt(17).run_id }, reason: "Recompiled after its check held it: a total check added.", text: JSON.stringify(flow(3)), digest: D1 },
];
/** A check's record (a promotion record's `check`): its bar, and once decided its numbers on the agent's last 20 runs. */
const CHECK = (attempt, decided) => ({ compile_after: 20, agree_min: 0.8, alone_min: 0.7, attempt, ...(decided ? { n: 20, agreed: decided.agreed, alone: decided.alone, of: SAMPLE.runs.slice(0, 20).map((run) => run.run_id), outcomes: { answered: decided.alone, handed_back: 20 - decided.alone, failed: 0, skipped_write: 0 } } : {}) });
const PROMOTIONS = [
  { workflow: WF, digest: D0, at: later(12, 10), decided: "replaying", reason: "checking it on 20 inputs of the agent's last 20 completed runs against its own answers before it serves", check: CHECK(1), runs: [] },
  { workflow: WF, digest: D0, at: later(14, 10), decided: "hold", reason: "checked on 20 of the agent's inputs: answered 17 alone (85.0%, the bar 70.0%), and 12 of those said what the agent said (70.6%, the bar 80.0%): held", check: CHECK(1, { agreed: 12, alone: 17 }) },
  { workflow: WF, digest: D1, at: later(18, 10), decided: "replaying", reason: "checking it on 20 inputs of the agent's last 20 completed runs against its own answers before it serves", check: CHECK(2), runs: [] },
  { workflow: WF, digest: D1, at: later(21, 10), decided: "promote", reason: "checked on 20 of the agent's inputs: answered 18 alone (90.0%, the bar 70.0%), and 17 of those said what the agent said (94.4%, the bar 80.0%): promoted", check: CHECK(2, { agreed: 17, alone: 18 }) },
];
const LOOP = {
  compiles: [
    { run_id: runAt(45).run_id, round: 1, at: later(45, -5), workflow: null, attempts: [{ ok: false, errors: ["/root/steps/1: an extract step's out names a schema the workflow does not define (Account)"] }, { ok: false, errors: ["the dry run failed: /root/steps/2 reads state.total, which no step writes"] }, { ok: false, errors: ["the draft is not JSON: Unexpected token } at 412"] }], digest: null, promoted: null, draft_errors: [], withheld: false },
    { run_id: runAt(17).run_id, round: 1, at: later(17, -5), workflow: WF, attempts: [{ ok: true, errors: [] }], digest: D1, promoted: true, draft_errors: [], withheld: false },
    { run_id: runAt(11).run_id, round: 1, at: later(11, -5), workflow: WF, attempts: [{ ok: false, errors: ["/root/steps/1: an extract step needs a label"] }, { ok: true, errors: [] }], digest: D0, promoted: false, draft_errors: [], withheld: false },
  ],
  completed_runs: 20,
};
/** corrections.md as the owner left it: one correction a line, each given whole to every later run. */
const CORRECTIONS = "- Acme Paper goes to 6100 Office supplies; Northwind Freight to 6400 Shipping.\n- Check the total against the lines plus the tax line, not the lines alone.\n";
const ITEM = { name: WF, file: `workflows/${WF}/workflow.json`, readme: `workflows/${WF}/README.md`, description: "Sorts an invoice into its ledger account", status: "active", run: null, bytes: 1400, etag: '"w"' };

/** Each card's box against the page and its own content: text past a card's right edge, and a page wider than the view. */
function measure() {
  const past = [];
  for (const card of document.querySelectorAll('[data-testid="loop-story"], [data-testid="cost-per-run"], [aria-label="Learned workflow"], [data-testid="loop-feed"], [aria-label="Corrections"]')) {
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
    // The real reads first: a fresh agent's loop and promotions read empty, and so do its corrections.
    const fresh = await api("GET", `/agents/${enc}/learning/loop`);
    check(fresh.status === 200 && fresh.body.compiles.length === 0 && fresh.body.completed_runs === 0 && !("guards" in fresh.body), `a fresh agent's loop read: ${fresh.status} ${JSON.stringify(fresh.body)}`);
    const view = await api("GET", `/agents/${enc}/learning`);
    check(view.status === 200 && view.body.corrections === "" && !("notes" in view.body) && !("skills" in view.body), `a fresh agent's learning read: ${view.status} ${JSON.stringify(view.body)}`);
    await page.route(new RegExp(`/v2/agents/${enc}/learning$`), async (route) => { const real = await (await route.fetch()).json(); route.fulfill({ json: { ...real, corrections: CORRECTIONS, workflows: [ITEM] } }); });
    await page.route(new RegExp(`/v2/agents/${enc}/learning/cost(\\?.*)?$`), (route) => route.fulfill({ json: { ...SAMPLE, agent: id } }));
    await page.route(new RegExp(`/v2/agents/${enc}/learning/promotions$`), (route) => route.fulfill({ json: { agent: id, promotions: PROMOTIONS, serving: [{ workflow: WF, digest: D1, replaying: null }] } }));
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
        await story.getByText(CHEAPER).waitFor().catch(async (e) => { if (shots) await page.screenshot({ path: join(shots, "learning-loop-failed.png"), fullPage: true }); throw e; });
        await page.getByRole("region", { name: "Learned workflow" }).getByText("Revision 2 of 2").waitFor();
        await page.evaluate(() => document.fonts.ready);
        check(await page.evaluate((t) => document.documentElement.classList.contains(t), theme), `${at}: the page is not in the ${theme} theme`);

        // The story: each stage's value and state.
        const stages = await story.locator("li").evaluateAll((els) => els.map((el) => `${el.getAttribute("data-testid")}=${el.getAttribute("data-state")}:${el.querySelector('[data-testid$="-value"]')?.textContent}`));
        const checked = await story.getByTestId("stage-cheaper").textContent();
        check((checked ?? "").includes(PASSED) && !/same accuracy/.test(checked ?? ""), `${at}: the cheaper stage says ${checked}`);
        check(stages.join("|") === `stage-corrections=done:2 corrections|stage-compiled=done:${WF}|stage-took_over=done:Run 21|stage-cheaper=done:${CHEAPER}|stage-unsure=watch:5% handed back`, `${at}: the story says ${stages.join("|")}`);
        await shoot(story, `loop-story-${theme}-${width}.png`);

        // The cost chart: a flag per record kind on its run, the server's headline with the hand-back rate.
        const cost = page.getByTestId("cost-per-run");
        const flags = await cost.locator('g[data-testid^="marker-"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
        check(flags.join() === "marker-revision,marker-hold,marker-revision,marker-promote", `${at}: the chart's markers are ${flags.join()}`);
        const headline = await cost.locator("h3 + p").textContent();
        check(/^\$0\.890 a run before takeover, \$0\.116 all-in over 59 served runs after: 7\.7x cheaper · 5% handed back since$/.test(headline ?? ""), `${at}: the headline says ${headline}`);
        // The learned workflow stands beside the cost chart where the tab has room for both, and under it otherwise.
        const chartBox = await cost.boundingBox(), flowBox = await page.getByRole("region", { name: "Learned workflow" }).boundingBox();
        const beside = flowBox.x >= chartBox.x + chartBox.width - 1 && Math.abs(flowBox.y - chartBox.y) < 2 && Math.abs(flowBox.height - chartBox.height) < 2;
        const under = flowBox.y >= chartBox.y + chartBox.height - 1 && Math.abs(flowBox.x - chartBox.x) < 2;
        check(width >= 1440 ? beside : under, `${at}: the learned workflow is at ${JSON.stringify(flowBox)}, the cost chart at ${JSON.stringify(chartBox)}`);
        await shoot(cost, `loop-cost-${theme}-${width}.png`);
        // A flag's hover says its record.
        // The chart can start under the fold (the glance and the story stand above it): bring it into view first.
        await cost.scrollIntoViewIfNeeded();
        const flag = cost.locator('g[data-testid="marker-promote"] rect').first();
        const fb = await flag.boundingBox();
        await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
        const tip = cost.getByTestId("marker-tip");
        await tip.waitFor({ timeout: 5000 });
        check(/Promoted · run 21/.test((await tip.textContent()) ?? ""), `${at}: the flag's hover says ${await tip.textContent()}`);
        if (width === WIDTHS[0]) await shoot(cost, `loop-cost-${theme}-${width}-flag.png`);
        await page.mouse.move(0, 0);

        // The workflow card: the newest revision serves, on its check's numbers; no step carries a guard.
        const card = page.getByRole("region", { name: "Learned workflow" });
        // The chip's leading word only: its wording is asserted in learningLoop.test.ts and WorkflowReplay.test.tsx.
        const word = async () => ((await card.getByTestId("standing").locator("span").first().textContent()) ?? "").split(" · ")[0];
        check((await word()) === "Serving", `${at}: the standing says ${await word()}`);
        check((await card.locator("svg .verdict").count()) === 0, `${at}: a step on the graph carries a guard`);
        await shoot(card, `loop-workflow-${theme}-${width}.png`);
        // Scrubbed back one: the first compile, held on its check.
        await card.getByRole("button", { name: "Previous revision" }).click();
        check((await word()) === "Held", `${at}: revision 1 says ${await word()}`);

        // The feed: the refused draft in the checks' words.
        const feed = page.getByTestId("loop-feed");
        const errors = await feed.getByTestId("draft-errors").first().locator("li").allTextContents();
        check(errors.length === 3 && errors[2] === "Attempt 3: the draft is not JSON: Unexpected token } at 412", `${at}: the feed's draft errors are ${JSON.stringify(errors)}`);
        await shoot(feed, `loop-feed-${theme}-${width}.png`);
        // The corrections card: the owner's two lines, counted, each given whole to every later run.
        const corrections = page.getByRole("region", { name: "Corrections" });
        const said = (await corrections.textContent()) ?? "";
        check(said.includes("2 corrections. Every later run is given them whole before it starts.") && said.includes("Northwind Freight to 6400 Shipping."), `${at}: the corrections card says ${said}`);
        if (width === WIDTHS[0]) await shoot(corrections, `loop-corrections-${theme}-${width}.png`);

        const m = await page.evaluate(measure);
        for (const t of m.past) wrong.push(`${at}: ${t} runs past its card`);
        if (m.sideways) wrong.push(`${at}: the page scrolls sideways`);
      }
    }
    // Withheld: a run's cost unknown and one known only as at most; the summary has no ratio and the story says why.
    // The newest route on a URL answers it (Playwright runs matching routes newest first).
    await page.route(new RegExp(`/v2/agents/${enc}/learning/cost(\\?.*)?$`), (route) => route.fulfill({ json: { ...SAMPLE, agent: id, summary: { ...SAMPLE.summary, times_cheaper: null, withheld: { unknown: 1, at_most: 1 } } } }));
    await page.evaluate(() => localStorage.setItem("agentrun.theme", "light"));
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width < 600 ? 3200 : 2000 });
      await page.goto(`${base}/#/agents/${enc}/learning`);
      await page.reload();
      const story = page.getByTestId("loop-story");
      await story.getByText("No ratio yet").waitFor();
      const said = await story.getByTestId("stage-cheaper").textContent();
      check(/1 run's cost unknown, 1 known only as at most: how many times cheaper shows once every run's cost is known/.test(said ?? "") && !/\dx cheaper/.test(said ?? ""), `withheld ${width}px: the cheaper stage says ${said}`);
      await shoot(story, `loop-story-withheld-light-${width}.png`);
    }
    // Early: an agent with one correction and no workflow yet says how far it is from a compile.
    const early = await api("POST", "/agents", { definition: { version: 1, name: "Invoice sorter, new", instructions: "Answer with the ledger account.", harness: "pi", tools: [], skills: [], learning: true } });
    const eid = encodeURIComponent(early.body.agent_id);
    await page.route(new RegExp(`/v2/agents/${eid}/learning$`), async (route) => { const real = await (await route.fetch()).json(); route.fulfill({ json: { ...real, corrections: CORRECTIONS.split("\n")[0] + "\n" } }); });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => localStorage.setItem("agentrun.theme", t), theme);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1400 });
        await page.goto(`${base}/#/agents/${eid}/learning`);
        await page.reload();
        const story = page.getByTestId("loop-story");
        await story.waitFor();
        const given = await story.getByTestId("stage-corrections").getAttribute("data-state");
        check(given === "done", `${theme} ${width}px early: the corrections stage is ${given}`);
        const compile = await story.getByTestId("stage-compiled").textContent();
        // Compile at N (learning: true: compile_after 20): its completed runs alone count, never its corrections.
        check(/Not yet0 of 20 completed runs: a workflow compiles at 20, then is checked once on those runs' inputs against the agent's own answers$/.test(compile ?? "") && !/correction/.test(compile ?? ""), `${theme} ${width}px early: the compile stage says ${compile}`);
        await shoot(story, `loop-early-${theme}-${width}.png`);
      }
    }
    check(!wrong.length, wrong.join("\n"));
  },
};
