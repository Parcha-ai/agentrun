// The agent cards' footers, measured in the browser at four widths (three columns, two, two narrow, one): every chip's
// words on one line, a card's chips on one row whenever that row fits in its footer, nothing in a footer past its card's
// right edge, and every whole action control the same height with rounded outer corners. A class
// list says what was asked of the layout; only the laid-out boxes say what came of it. Six agents made through the API,
// their list read through the page with counts no fresh server has (11 revisions, 4 runs with 3 live, 17 runs and one
// learned item waiting), as an agent that has been used for a while reads. E2E_SHOTS=<dir> also saves each width's page.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { check, serverAnswer } from "../harness.mjs";

export const WIDTHS = [1440, 1150, 820, 390];

const AGENTS = [
  { name: "mcp-test", description: "", revisions: 1, runs: { count: 1, live: 0 } },
  { name: "Browser test", description: "", revisions: 1, runs: { count: 4, live: 3 } },
  { name: "Market monitor", description: "Every Monday, a short digest of what changed at the companies you watch (launches, pricing, notable hires, funding and news), each item dated, linked and with a line on why it matters.", revisions: 1, runs: { count: 4, live: 0 } },
  { name: "KYB due diligence (medium risk appetite)", description: "Business due diligence on one company: who it is from primary registries, who owns and runs it, sanctions and adverse media, and a verdict.", revisions: 1, runs: { count: 2, live: 0 } },
  { name: "Release notes: pallets/click", description: "Turns the pull requests merged since the last release into user-facing release notes and leaves them as a draft issue.", revisions: 1, runs: { count: 1, live: 0 } },
  { name: "Hello, AgentRun", description: "A first agent: writes hello.md and answers in one line.", revisions: 11, runs: { count: 17, live: 0 }, pending: 1 },
];

/** Every card's footer, measured where it is laid out: what each check reads, by card name. */
function measure() {
  const px = (n) => Math.round(n * 10) / 10;
  return [...document.querySelectorAll('[data-testid="agent-card-footer"]')].map((footer) => {
    const card = footer.closest("li");
    const name = card.querySelector(".font-semibold")?.textContent ?? "?";
    const edge = card.getBoundingClientRect().right;
    // Chips are measured separately from the Run/Edit dropdowns and Runs action. Their words' lines are the line
    // boxes their text makes; a run count inside the Runs action is not another status chip.
    const own = (el) => [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    const held = [...footer.querySelectorAll('[data-testid="agent-card-chips"] > *')].filter(own);
    const chips = held.map((chip) => {
      const range = document.createRange();
      range.selectNodeContents(chip);
      const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
      const box = chip.getBoundingClientRect();
      return { text: chip.textContent, lines: lines.size, top: Math.round(box.top), width: box.width, height: px(box.height), clipped: chip.scrollWidth > chip.clientWidth + 1 };
    });
    // Whether its chips, side by side with their gaps, fit in one row of the footer.
    const gap = held.length ? parseFloat(getComputedStyle(held[0].parentElement).columnGap) || 0 : 0;
    const row = chips.reduce((sum, c) => sum + c.width, 0) + gap * (chips.length - 1);
    const fits = row <= footer.clientWidth;
    const past = [footer, ...footer.querySelectorAll("*")].map((el) => ({ el, right: el.getBoundingClientRect().right }))
      .filter(({ right }) => right > edge + 0.5).map(({ el, right }) => `${el.getAttribute("aria-label") ?? el.textContent ?? el.tagName} by ${px(right - edge)}px`);
    const controls = [...footer.querySelector('[data-testid="agent-card-actions"]').children].map((control) => {
      const r = control.getBoundingClientRect();
      const style = getComputedStyle(control);
      return { label: control.getAttribute("aria-label"), width: px(r.width), height: px(r.height),
        radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius].map(parseFloat),
        buttons: [...control.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")) };
    });
    return { name, chips, past, controls, fits, rows: new Set(chips.map((c) => c.top)).size };
  });
}

export default {
  name: "agent-card-footer",
  signedIn: true,
  async run({ page, base, api }) {
    for (const a of AGENTS) {
      const made = await api("POST", "/agents", { definition: { version: 1, name: a.name, description: a.description, instructions: "Answer in one line.", harness: "pi", tools: [], skills: [] } });
      check(made.status === 201 || made.status === 200, `POST /v2/agents (${a.name}) answered ${made.status}: ${JSON.stringify(made.body)}`);
    }
    // The server's own list, with the counts a used agent has.
    const byName = new Map(AGENTS.map((a) => [a.name, a]));
    await page.route(/\/v2\/agents(\?.*)?$/, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const real = await serverAnswer(route);
      const body = await real.json();
      for (const agent of body.agents ?? []) {
        const used = byName.get(agent.definition?.name);
        if (!used) continue;
        Object.assign(agent, { revisions: used.revisions, runs: used.runs }, used.pending ? { learning: { pending: used.pending } } : {});
      }
      await route.fulfill({ response: real, json: body });
    });
    const shots = process.env.E2E_SHOTS;
    if (shots) mkdirSync(shots, { recursive: true });
    const wrong = [];
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${base}/#/agents`);
      await page.getByText(`${AGENTS.length} agents`).waitFor();
      await page.getByRole("button", { name: /learned item waits/ }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      if (shots) await page.screenshot({ path: join(shots, `agents-${width}.png`), fullPage: true });
      const cards = await page.evaluate(measure);
      check(cards.length === AGENTS.length, `${width}px: ${cards.length} card footers, not ${AGENTS.length}`);
      check(cards.some((c) => c.chips.some((chip) => /4 runs · 3 live/i.test(chip.text))), `${width}px: no card says 4 runs · 3 live`);
      check(cards.some((c) => c.chips.some((chip) => /Learning · 1/i.test(chip.text))), `${width}px: no card says Learning · 1`);
      // A single-line chip's height: the shortest chip's (every chip is one line high when its words are on one line).
      const single = Math.min(...cards.flatMap((c) => c.chips.map((chip) => chip.height)));
      for (const c of cards) {
        for (const chip of c.chips) {
          if (chip.lines !== 1) wrong.push(`${width}px ${c.name}: "${chip.text}" takes ${chip.lines} lines`);
          if (chip.height !== single) wrong.push(`${width}px ${c.name}: "${chip.text}" is ${chip.height}px high, a one-line chip ${single}px`);
          if (chip.clipped) wrong.push(`${width}px ${c.name}: "${chip.text}" is cut off inside its chip`);
        }
        if (c.fits && c.rows > 1) wrong.push(`${width}px ${c.name}: its chips fit on one row of the footer but take ${c.rows}`);
        for (const p of c.past) wrong.push(`${width}px ${c.name}: ${p} past the card's right edge`);
        check(c.controls.length === 4, `${width}px ${c.name}: ${c.controls.length} whole action controls, not 4`);
        const [run, edit, runs, archive] = c.controls;
        check(run.label === `Run ${c.name} options` && run.buttons.includes(`Choose coding agent for Run ${c.name}`), `${width}px ${c.name}: missing Run coding-agent dropdown`);
        check(edit.label === `Edit ${c.name} options` && edit.buttons.includes(`Choose coding agent for Edit ${c.name}`), `${width}px ${c.name}: missing Edit coding-agent dropdown`);
        check(runs.label === `Runs of ${c.name}` && archive.label === `Archive ${c.name}`, `${width}px ${c.name}: missing Runs or Archive action`);
        for (const control of c.controls) {
          if (control.height !== 32) wrong.push(`${width}px ${c.name}: ${control.label} is ${control.height}px high, expected 32px`);
          if (control.radii.some((radius) => radius !== 8)) wrong.push(`${width}px ${c.name}: ${control.label} outer corners are ${control.radii.join(", ")}px, expected 8px`);
        }
      }
    }
    check(wrong.length === 0, `the agent cards' footers:\n${wrong.join("\n")}`);
  },
};
