// The owner's bill on an agent's Learning tab, in the browser at two widths and both themes: an agent with learning on,
// its GET /v2/agents/{id}/learning/cost answered with the console's invented sample (src/components/CostPerRun.sample.json:
// 80 runs of an invoice-sorter agent whose learned workflow serves from run 21) and a bill over it; its promotions, its
// audit ledger and its workflow's revisions answered to match. The bill's card draws both lines on one dollar axis
// inside its width (no label past the plot), with a legend, the break-even marker and a table; the audit line says the
// hold window and all time; the serving workflow lists its nodes with their tiers. No equal-cache figure anywhere.
// E2E_SHOTS=<dir> also saves the bill, the audit line and the serving workflow at each width and theme.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { check, markExample } from "../harness.mjs";

const SAMPLE = JSON.parse(readFileSync(new URL("../../src/components/CostPerRun.sample.json", import.meta.url), "utf8"));
export const WIDTHS = [1440, 390];
const DIGEST = "1a48d30b3f762d29";
const WORKFLOW = "sort-invoice";
/** The check's spend ($1.20 of replay runs), carried by its first 20 served runs, $0.06 each. */
const CHECK = { spend: 1.2, k: 20 };

/** The sample's bill, as the server's billOf reads it: every run that does a job, all in, cumulative, its served runs
 *  carrying their check's share; against the mean of the agent's own runs before the promotion, times the runs. */
function billOf(runs) {
  const promoted = runs.find((r) => r.path !== "agent");
  const before = runs.filter((r) => r.n < promoted.n && r.path === "agent");
  const mean = Math.round((before.reduce((s, r) => s + r.cost_usd, 0) / before.length) * 1e6) / 1e6;
  let sum = 0, served = 0;
  const points = runs.map((r, i) => {
    const share = r.path !== "agent" && served < CHECK.k ? (served++, CHECK.spend / CHECK.k) : 0;
    sum += r.total_usd + share;
    return { n: i + 1, run_id: r.run_id, actual_usd: Math.round(sum * 1e6) / 1e6, agent_usd: Math.round(mean * (i + 1) * 1e6) / 1e6 };
  });
  const from = promoted.n - 1;
  const over = points.findLastIndex((p, i) => i >= from && p.actual_usd > p.agent_usd);
  const even = over + 1 < points.length ? points[Math.max(over + 1, from)] : null;
  return {
    baseline: { runs: before.length, mean_usd: mean }, promoted: { n: promoted.n, run_id: promoted.run_id, at: promoted.started_at },
    points, break_even: even && { n: even.n, run_id: even.run_id }, gap_usd: even ? null : Math.round((points.at(-1).actual_usd - points.at(-1).agent_usd) * 1e6) / 1e6,
    withheld: 0, booked_usd: points.at(-1).actual_usd,
    revisions: [{ workflow: WORKFLOW, digest: DIGEST, spend_usd: CHECK.spend, k: CHECK.k, state: "serving", served: CHECK.k, attributed_usd: CHECK.spend, unattributed_usd: 0 }], unattributed_usd: 0,
  };
}

const TEXT = JSON.stringify({ v: 2, name: WORKFLOW, input: { schemaId: "Invoice" }, output: { schemaId: "Account", path: "account" }, root: { node: "chain", steps: [
  { node: "extract", label: "fields", tier: "fast", instructions: "Copy the vendor, the total and the line items.", state: { content: "{content}" }, out: "Fields", as: "fields" },
  { node: "decide", label: "account", instructions: "Pick the ledger account for these fields.", state: { fields: "{fields}" }, out: "Account", as: "account" },
  { node: "escalate", label: "unsure", when: { predicate: "field_equals", path: "account.code", value: "unknown" }, kind: "needs_review", stage: "account", summary: "No account fits." },
] } });

export default {
  name: "learning-bill",
  signedIn: true,
  async run({ page, base, api }) {
    const made = await api("POST", "/agents", { definition: { version: 1, name: "Invoice sorter", description: "Sorts an invoice into its ledger account.", instructions: "Answer in one line.", harness: "pi", tools: [], skills: [], learning: true } });
    check(made.status === 201 || made.status === 200, `POST /v2/agents answered ${made.status}: ${JSON.stringify(made.body)}`);
    const id = made.body.agent_id;
    // The real read first: a fresh agent's bill has no point.
    const fresh = await api("GET", `/agents/${encodeURIComponent(id)}/learning/cost`);
    check(fresh.status === 200 && fresh.body.bill?.points.length === 0 && fresh.body.bill.break_even === null, `a fresh agent's bill: ${fresh.status} ${JSON.stringify(fresh.body.bill)}`);
    const bill = billOf(SAMPLE.runs);
    check(bill.break_even !== null, `the sample's bill breaks even: ${JSON.stringify(bill.points.slice(-3))}`);
    const promotedAt = bill.promoted.at;
    const audits = Array.from({ length: 30 }, (_, i) => ({ run: SAMPLE.runs[21 + i * 2]?.run_id ?? `run_${i}`, shadow_run: `audit.run_${i}`, workflow: WORKFLOW, digest: DIGEST, promoted_at: promotedAt, source: "shadow", agreed: i !== 7 && i !== 19, served_cost: 0.08, shadow_cost: 0.8, at: promotedAt }));
    const promotions = {
      agent: id,
      promotions: [{ workflow: WORKFLOW, digest: DIGEST, at: promotedAt, decided: "promote", reason: "checked on 20 inputs", check: { compile_after: 20, agree_min: 0.9, alone_min: 0.8, attempt: 1, n: 20, agreed: 19, alone: 19, of: [], cost_usd: CHECK.spend }, runs: [], commit: "c".repeat(40) }],
      serving: [{ workflow: WORKFLOW, digest: DIGEST, replaying: null, state: "serving", check: { n: 20, agreed: 19, alone: 19, attempt: 1 }, audit: { window: 20, disagree: 3, rows: 20, disagreed: 1 }, audits_off: null, not_auditable: 0 }],
    };
    const revisions = { name: WORKFLOW, revisions: [{ commit: "c".repeat(40), at: promotedAt, by: { run: SAMPLE.runs[19].run_id }, reason: "compiled from 20 runs", text: TEXT, digest: DIGEST }], total: 1, truncated: false };
    const agentPath = `/v2/agents/${encodeURIComponent(id)}/learning`;
    await page.route(new RegExp(`${agentPath}/cost(\\?.*)?$`), (route) => route.fulfill({ json: { ...SAMPLE, agent: id, unknown_path_runs: 0, bill } }));
    await page.route(new RegExp(`${agentPath}/promotions$`), (route) => route.fulfill({ json: promotions }));
    await page.route(new RegExp(`${agentPath}/audits$`), (route) => route.fulfill({ json: { agent: id, audits } }));
    await page.route(new RegExp(`${agentPath}/workflows/[^/]+/revisions(\\?.*)?$`), (route) => route.fulfill({ json: revisions }));
    const shots = process.env.E2E_SHOTS;
    if (shots) mkdirSync(shots, { recursive: true });
    const wrong = [];
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => localStorage.setItem("agentrun.theme", t), theme);
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 1600 });
        await page.goto(`${base}/#/agents/${encodeURIComponent(id)}/learning`);
        await page.reload();
        const card = page.getByTestId("learning-bill");
        await card.getByText(`Break-even at run ${bill.break_even.n}`).waitFor().catch(async (e) => { if (shots) await page.screenshot({ path: join(shots, "failed.png"), fullPage: true }); throw e; });
        await page.evaluate(() => document.fonts.ready);
        check(await page.evaluate((t) => document.documentElement.classList.contains(t), theme), `${theme} ${width}px: the page is not in the ${theme} theme`);
        // The chart draws at 720px, then at its card's width once its ResizeObserver answered: measure after that.
        await page.waitForFunction(() => {
          const c = document.querySelector('[data-testid="learning-bill"]');
          const svg = c?.querySelector('[tabindex="0"] > svg');
          return !!c && !!svg && svg.getBoundingClientRect().width <= c.getBoundingClientRect().width + 0.5;
        }, null, { timeout: 5_000 }).catch(() => {});
        const m = await card.evaluate((c) => {
          const svg = c.querySelector('[tabindex="0"] > svg');
          const edge = Math.min(c.getBoundingClientRect().right, svg.getBoundingClientRect().right);
          const left = svg.getBoundingClientRect().left;
          return {
            card: c.getBoundingClientRect().width, plot: svg.getBoundingClientRect().width,
            past: [...svg.querySelectorAll("text")].filter((t) => t.getBoundingClientRect().right > edge + 0.5 || t.getBoundingClientRect().left < left - 0.5).map((t) => t.textContent),
            lines: ["bill-actual", "bill-agent"].filter((t) => c.querySelector(`[data-testid="${t}"]`)?.getAttribute("d")?.startsWith("M")),
            axes: c.querySelectorAll('[data-testid="bill-y-axis"]').length,
            marker: c.querySelector('[data-testid="bill-break-even"]')?.textContent ?? null,
            legend: c.querySelector('[data-testid="bill-legend"]')?.textContent ?? null,
          };
        });
        if (m.plot > m.card + 0.5) wrong.push(`${theme} ${width}px: the plot is ${m.plot}px in a ${m.card}px card`);
        for (const t of m.past) wrong.push(`${theme} ${width}px: "${t}" runs past the plot`);
        if (m.lines.length !== 2) wrong.push(`${theme} ${width}px: the lines drawn are ${m.lines.join(", ")}`);
        if (m.axes !== 1) wrong.push(`${theme} ${width}px: ${m.axes} y axes`);
        if (m.marker !== `Break-even, run ${bill.break_even.n}`) wrong.push(`${theme} ${width}px: the marker says ${m.marker}`);
        if (!/Your bill, booked/.test(m.legend ?? "") || !/The agent for all of it/.test(m.legend ?? "")) wrong.push(`${theme} ${width}px: the legend says ${m.legend}`);
        // The table view: a row per point.
        await card.locator("details > summary").click();
        const rows = await card.locator("details tbody tr").count();
        if (rows !== bill.points.length) wrong.push(`${theme} ${width}px: the table has ${rows} rows of ${bill.points.length}`);
        await card.locator("details > summary").click();
        // The audit line and the serving workflow.
        const audit = await page.getByTestId("learning-audits").textContent();
        check(/Last 20 audits: 19 agreed/.test(audit ?? "") && /All time: 28 of 30 agreed/.test(audit ?? ""), `${theme} ${width}px: the audit line says ${audit}`);
        const serving = page.getByTestId("serving-workflow");
        const nodes = await serving.locator("tbody tr").allTextContents();
        check(nodes.length === 3 && /fast/.test(nodes[0]) && /agent model/.test(nodes[1]) && /when account\.code = "unknown"/.test(nodes[2]), `${theme} ${width}px: the serving workflow's nodes: ${JSON.stringify(nodes)}`);
        check(/Checked on 20 inputs: 19 answered alone \(bar 80%\), 19 of them agreed \(bar 90%\)/.test(await serving.textContent() ?? ""), `${theme} ${width}px: the check words`);
        const tab = await page.locator("body").textContent();
        if (/equal[- ]cache/i.test(tab ?? "")) wrong.push(`${theme} ${width}px: an equal-cache figure is on the tab`);
        // A hover on the plot names a run's two figures.
        await card.scrollIntoViewIfNeeded();
        const plot = card.locator('[tabindex="0"] > svg');
        const box = await plot.boundingBox();
        await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.5);
        const tip = card.locator('[tabindex="0"] > .shadow-float');
        await tip.waitFor({ timeout: 5000 });
        const said = await tip.textContent();
        check(/^Run \d+Your bill \$[\d.]+The agent for all of it \$[\d.]+$/.test(said ?? ""), `${theme} ${width}px: the hover says ${said}`);
        if (shots) {
          await markExample(card);
          await card.screenshot({ path: join(shots, `learning-bill-${theme}-${width}-hover.png`) });
          await page.mouse.move(0, 0);
          await card.screenshot({ path: join(shots, `learning-bill-${theme}-${width}.png`) });
          await page.getByTestId("learning-audits").screenshot({ path: join(shots, `learning-audits-${theme}-${width}.png`) });
          await serving.screenshot({ path: join(shots, `serving-workflow-${theme}-${width}.png`) });
        }
        await page.mouse.move(0, 0);
      }
    }
    check(wrong.length === 0, `the bill:\n${wrong.join("\n")}`);
  },
};
