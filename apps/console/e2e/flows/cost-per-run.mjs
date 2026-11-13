// The cost per run chart on an agent's Learning tab, in the browser at two widths and both themes: an agent with learning
// on, its GET /v2/agents/{id}/learning/cost answered with the console's invented sample (src/components/CostPerRun.sample.json:
// 80 runs of an invoice-sorter agent whose learned workflow takes over at run 21). The chart lays out inside its card at
// each width (no label past the plot's right edge), names the takeover and how many times cheaper, and a hover shows a
// run's readout. The execution mix sits beside the chart at desktop width and under it below, fits the card, and a hover on a block names its runs and counts. E2E_SHOTS=<dir>
// also saves each width and theme, before and during the hover.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "../harness.mjs";

const SAMPLE = JSON.parse(readFileSync(new URL("../../src/components/CostPerRun.sample.json", import.meta.url), "utf8"));
export const WIDTHS = [1440, 820];

/** The chart's card, measured where it is laid out: its box, the plot's, and every label's right edge. */
function measure() {
  const card = document.querySelector('[data-testid="cost-per-run"]');
  const svg = card?.querySelector('[tabindex="0"] > svg');
  const mix = card?.querySelector('[data-testid="execution-mix"] svg');
  if (!card || !svg || !mix) return null;
  const edge = card.getBoundingClientRect().right;
  const pastOf = (el) => {
    const box = el.getBoundingClientRect();
    return [...el.querySelectorAll("text")].map((t) => ({ text: t.textContent, rect: t.getBoundingClientRect() })).filter((t) => t.rect.right > Math.min(edge, box.right) + 0.5 || t.rect.left < box.left - 0.5).map((t) => t.text);
  };
  const plot = svg.getBoundingClientRect(), strip = mix.getBoundingClientRect();
  // Beside: the mix starts right of the plot; under: it starts below it. Never over it.
  const overlaps = strip.left < plot.right - 0.5 && strip.top < plot.bottom - 0.5;
  return { cardWidth: card.getBoundingClientRect().width, plotWidth: plot.width, past: [...pastOf(svg), ...pastOf(mix)], overlaps, beside: strip.left >= plot.right - 0.5 };
}

export default {
  name: "cost-per-run",
  signedIn: true,
  async run({ page, base, api }) {
    const made = await api("POST", "/agents", { definition: { version: 1, name: "Invoice sorter", description: "Sorts an invoice into its ledger account.", instructions: "Answer in one line.", harness: "pi", tools: [], skills: [], learning: true } });
    check(made.status === 201 || made.status === 200, `POST /v2/agents answered ${made.status}: ${JSON.stringify(made.body)}`);
    const id = made.body.agent_id;
    // The real read first: a fresh agent's series is empty, and says what to do.
    const fresh = await api("GET", `/agents/${encodeURIComponent(id)}/learning/cost`);
    check(fresh.status === 200 && fresh.body.runs.length === 0 && fresh.body.summary.takeover === null, `a fresh agent's cost read: ${fresh.status} ${JSON.stringify(fresh.body)}`);
    await page.route(new RegExp(`/v2/agents/${encodeURIComponent(id)}/learning/cost(\\?.*)?$`), (route) => route.fulfill({ json: { ...SAMPLE, agent: id } }));
    const shots = process.env.E2E_SHOTS;
    if (shots) mkdirSync(shots, { recursive: true });
    const wrong = [];
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => localStorage.setItem("agentrun.theme", t), theme);
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 1600 });
        await page.goto(`${base}/#/agents/${encodeURIComponent(id)}/learning`);
        await page.reload();
        const card = page.getByTestId("cost-per-run");
        await card.getByText("Workflow took over, run 21").waitFor().catch(async (e) => { if (shots) await page.screenshot({ path: join(shots, "failed.png"), fullPage: true }); throw e; });
        await page.evaluate(() => document.fonts.ready);
        check(await page.evaluate((t) => document.documentElement.classList.contains(t), theme), `${theme} ${width}px: the page is not in the ${theme} theme`);
        const headline = await card.locator("h3 + p").textContent();
        check(/before learning, .* after takeover: 7x cheaper/.test(headline ?? ""), `${theme} ${width}px: the headline says ${headline}`);
        const m = await page.evaluate(measure);
        check(m, `${theme} ${width}px: no chart`);
        if (m.plotWidth > m.cardWidth + 0.5) wrong.push(`${theme} ${width}px: the plot is ${m.plotWidth}px in a ${m.cardWidth}px card`);
        for (const t of m.past) wrong.push(`${theme} ${width}px: "${t}" runs past the plot`);
        if (m.overlaps) wrong.push(`${theme} ${width}px: the mix overlaps the chart`);
        if (m.beside !== (width >= 1440)) wrong.push(`${theme} ${width}px: the mix is ${m.beside ? "beside" : "under"} the chart`);
        // A hover two thirds of the way along: a run after the takeover, by the learned workflow.
        if (shots) await card.screenshot({ path: join(shots, `cost-per-run-${theme}-${width}.png`) });
        const plot = card.locator('[tabindex="0"] > svg');
        await plot.scrollIntoViewIfNeeded();
        const box = await plot.boundingBox();
        await page.mouse.move(box.x + box.width * 0.66, box.y + box.height * 0.5);
        const tip = card.locator('[tabindex="0"] > .shadow-float');
        await tip.waitFor({ timeout: 5000 }).catch(async (e) => { if (shots) await page.screenshot({ path: join(shots, "failed.png"), fullPage: true }); throw e; });
        const said = await tip.textContent();
        check(/^Run \d+\$[\d.]+ all-in/.test(said ?? "") && /Learned revision [0-9a-f]{7}/.test(said ?? ""), `${theme} ${width}px: the hover says ${said}`);
        if (shots) await card.screenshot({ path: join(shots, `cost-per-run-${theme}-${width}-hover.png`) });
        await page.mouse.move(0, 0);
        // The execution mix: inside the card, and a block's hover names its runs and what each path took.
        const mix = card.getByTestId("execution-mix");
        const strip = mix.locator("svg");
        await strip.scrollIntoViewIfNeeded();
        const [mixBox, cardBox] = [await strip.boundingBox(), await card.boundingBox()];
        if (mixBox.x + mixBox.width > cardBox.x + cardBox.width + 0.5) wrong.push(`${theme} ${width}px: the mix is past the card`);
        await page.mouse.move(mixBox.x + mixBox.width * 0.3, mixBox.y + mixBox.height * 0.5);
        const block = mix.locator(".shadow-float");
        await block.waitFor({ timeout: 5000 });
        const blockSaid = await block.textContent();
        check(/^Runs \d+ to \d+(By the agent|Handed back|Learned workflow) \d+ \(\d+%\)/.test(blockSaid ?? ""), `${theme} ${width}px: the mix's hover says ${blockSaid}`);
        await page.mouse.move(0, 0);
      }
    }
    check(wrong.length === 0, `the cost per run chart:\n${wrong.join("\n")}`);
  },
};
