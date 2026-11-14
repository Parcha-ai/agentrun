// The learned-workflow replay on an agent's Learning tab, in the browser at three widths and both themes: an agent with
// learning on and one active learned workflow, its GET /v2/agents/{id}/learning answered with that workflow listed and its
// GET .../learning/workflows/{name}/revisions with four invented revisions of an invoice-sorter workflow (a first step, a
// check step added, the first step's instructions rewritten, a ledger step added). The tab opens on the newest revision with
// its NEW node tagged in words; the slider's arrow key goes back one revision and its EDITED node is tagged; Play from the
// first revision runs to the newest; the page never scrolls sideways, at phone width included. E2E_SHOTS=<dir> also saves
// each width and theme.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { check, markExample, serverAnswer } from "../harness.mjs";

export const WIDTHS = [1440, 820, 390];
const step = (label, instructions) => ({ node: "extract", label, instructions, out: "Answer", as: label });
const flow = (steps) => ({ v: 2, name: "invoice-sorter", schemas: { Answer: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } } }, input: { schemaId: "Answer" }, output: { schemaId: "Answer", path: "answer" }, root: { node: "chain", steps } });
const SORT = step("classify", "Sort the invoice into a ledger account.");
const REVISIONS = [
  [{ run: "run_aaaaaaaa01" }, [SORT]],
  [{ run: "run_aaaaaaaa02" }, [SORT, step("check total", "Check the total against the lines.")]],
  [{ run: "run_aaaaaaaa03" }, [step("classify", "Sort the invoice into a ledger account by vendor."), step("check total", "Check the total against the lines.")]],
  [{ user: true }, [step("classify", "Sort the invoice into a ledger account by vendor."), step("check total", "Check the total against the lines."), step("file it", "Name the ledger account.")]],
].map(([by, steps], i) => ({ commit: String(i + 1).repeat(40), at: new Date(Date.UTC(2026, 10, 3 + i, 14, 10)).toISOString(), by, reason: `Revision ${i + 1}, as the grader or a person said it.`, text: JSON.stringify(flow(steps)), digest: String(i + 1).repeat(16) }));

async function playToTheNewest(card, page, at) {
  await card.getByRole("button", { name: "Play the replay" }).focus();
  await page.keyboard.press("Enter");
  await card.getByText("Revision 4 of 4").waitFor({ timeout: 12_000 });
  check(await card.getByRole("button", { name: "Play the replay" }).isVisible(), `${at}: the replay did not stop on the newest revision`);
}
const tags = (page) => page.evaluate(() => [...document.querySelectorAll('[aria-label="Learned workflow"] svg .tag')].map((t) => `${t.closest("g")?.getAttribute("data-path")}:${t.textContent}`));

export default {
  name: "workflow-replay",
  signedIn: true,
  async run({ page, base, api }) {
    const made = await api("POST", "/agents", { definition: { version: 1, name: "Invoice sorter", description: "Sorts an invoice into its ledger account.", instructions: "Answer in one line.", harness: "pi", tools: [], skills: [], learning: true } });
    check(made.status === 201 || made.status === 200, `POST /v2/agents answered ${made.status}: ${JSON.stringify(made.body)}`);
    const id = made.body.agent_id;
    const item = { name: "invoice-sorter", file: "workflows/invoice-sorter/workflow.json", readme: "workflows/invoice-sorter/README.md", description: "Sorts an invoice into its ledger account", status: "active", run: null, bytes: 900, etag: '"a"' };
    // The real view, with the learned workflow listed in it (a fresh agent's folder holds none).
    await page.route(new RegExp(`/v2/agents/${encodeURIComponent(id)}/learning$`), async (route) => { const real = await serverAnswer(route); await route.fulfill({ json: { ...(await real.json()), workflows: [item] } }); });
    await page.route(new RegExp(`/v2/agents/${encodeURIComponent(id)}/learning/workflows/invoice-sorter/revisions(\\?.*)?$`), (route) => route.fulfill({ json: { name: "invoice-sorter", revisions: REVISIONS, total: REVISIONS.length, truncated: false } }));
    const shots = process.env.E2E_SHOTS;
    if (shots) mkdirSync(shots, { recursive: true });
    const shoot = async (box, name) => { if (shots) { await markExample(box); await box.screenshot({ path: join(shots, name) }); } };
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => localStorage.setItem("agentrun.theme", t), theme);
      for (const width of WIDTHS) {
        const at = `${theme} ${width}px`;
        await page.setViewportSize({ width, height: 1100 });
        await page.goto(`${base}/#/agents/${encodeURIComponent(id)}/learning`);
        await page.reload();
        const card = page.getByRole("region", { name: "Learned workflow" });
        await card.getByText("Revision 4 of 4").waitFor().catch(async (e) => { if (shots) await page.screenshot({ path: join(shots, "workflow-replay-failed.png"), fullPage: true }); throw e; });
        await page.evaluate(() => document.fonts.ready);
        check(await page.evaluate((t) => document.documentElement.classList.contains(t), theme), `${at}: the page is not in the ${theme} theme`);
        check((await tags(page)).join() === "/root/steps/2:NEW", `${at}: the newest revision's tags are ${(await tags(page)).join()}`);
        const line = card.getByTestId("replay-line");
        check((await line.textContent()) === 'Added 1 node ("file it")', `${at}: the newest line says ${await line.textContent()}`);
        await shoot(card, `workflow-replay-${theme}-${width}-newest.png`);
        // The slider by the keyboard: one arrow back is the revision that rewrote the first step.
        const slider = card.getByRole("slider", { name: "Revision" });
        await slider.focus();
        await page.keyboard.press("ArrowLeft");
        check((await line.textContent()) === 'Edited "classify"', `${at}: one arrow back says ${await line.textContent()}`);
        check((await tags(page)).join() === "/root/steps/0:EDITED", `${at}: the edited revision's tags are ${(await tags(page)).join()}`);
        check(/^Revision 3 of 4, Nov 5/.test((await slider.getAttribute("aria-valuetext")) ?? ""), `${at}: the slider says ${await slider.getAttribute("aria-valuetext")}`);
        await shoot(card, `workflow-replay-${theme}-${width}-edited.png`);
        // Home goes to the first revision; Play, by the keyboard, from there to the newest (at the widest and the narrowest
        // width only: it waits out each step).
        await slider.press("Home");
        check((await line.textContent()) === "First version: 1 node", `${at}: Home says ${await line.textContent()}`);
        if (width !== 820) await playToTheNewest(card, page, at);
        const wide = await page.evaluate(() => ({ page: document.scrollingElement.scrollWidth, view: window.innerWidth }));
        check(wide.page <= wide.view, `${at}: the page scrolls sideways (${wide.page}px in ${wide.view}px)`);
      }
    }
  },
};
