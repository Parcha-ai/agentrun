// The Replay button on the Learning tab's workflow card, in the browser at 1440 and 390 px: an agent with learning on and one
// active learned workflow of three invented revisions (its GET .../learning and .../revisions answered with them, its
// GET .../promotions with the first serving and the third held on its check). The newest, held revision offers Replay (a
// check on the inputs of the agent's own runs); the click posts the replay (the server's own words answered: 202), the
// card shows the replay's progress from the GET, then one sentence of the decision and the check's score. A second replay
// is refused 409 replay_conflict and the card shows the server's words. The serving revision offers no Replay.
// E2E_SHOTS=<dir> also saves each width.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { check, markExample, serverAnswer } from "../harness.mjs";

export const WIDTHS = [1440, 390];
const step = (label, instructions) => ({ node: "extract", label, instructions, out: "Answer", as: label });
const flow = (steps) => ({ v: 2, name: "invoice-sorter", schemas: { Answer: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } } }, input: { schemaId: "Answer" }, output: { schemaId: "Answer", path: "answer" }, root: { node: "chain", steps } });
const SORT = step("classify", "Sort the invoice into a ledger account.");
const DIGESTS = ["1", "2", "3"].map((n) => n.repeat(16));
const REVISIONS = [
  [{ run: "run_aaaaaaaa01" }, [SORT]],
  [{ run: "run_aaaaaaaa02" }, [SORT, step("check total", "Check the total against the lines.")]],
  [{ user: true }, [step("classify", "Sort the invoice into a ledger account by vendor."), step("check total", "Check the total against the lines.")]],
].map(([by, steps], i) => ({ commit: String(i + 1).repeat(40), at: new Date(Date.UTC(2026, 10, 3 + i, 14, 10)).toISOString(), by, reason: `Revision ${i + 1}, as the run or a person wrote it.`, text: JSON.stringify(flow(steps)), digest: DIGESTS[i] }));
const REPLAY = { replay: "rp_e2e0000001", workflow: "invoice-sorter", digest: DIGESTS[2], inputs: 6 };
const replay = (over) => ({ ...REPLAY, status: "running", outcomes: { answered: 0, handed_back: 0, failed: 0, skipped_write: 0 }, score: { n: 0, agree: 0, agent_acc: 0, wf_acc: 0, delta: 0, handed_back: 0 }, cost_usd: null, ...over });
/** A check's record as the server keeps it (a promotion record's `check`): the bar it ran at and its numbers. */
const promo = (digest, at, decided, reason, n, agreed) => ({ workflow: "invoice-sorter", digest, at, decided, reason, check: { compile_after: n, agree_min: 0.8, alone_min: 0.7, attempt: 1, n, agreed, alone: n, of: [], outcomes: { answered: n, handed_back: 0, failed: 0, skipped_write: 0 } } });
const HELD = "checked on 6 of the agent's inputs: answered 6 alone (100.0%, the bar 70.0%), and 4 of those said what the agent said (66.7%, the bar 80.0%): held";

export default {
  name: "replay-button",
  signedIn: true,
  // The page reports the 409 this flow answers itself (the second replay); it checks that it is the only error (below).
  allowsErrors: true,
  async run({ page, base, api, errors }) {
    const made = await api("POST", "/agents", { definition: { version: 1, name: "Invoice sorter", description: "Sorts an invoice into its ledger account.", instructions: "Answer in one line.", harness: "pi", tools: [], skills: [], learning: true } });
    check(made.status === 201 || made.status === 200, `POST /v2/agents answered ${made.status}: ${JSON.stringify(made.body)}`);
    const id = made.body.agent_id;
    const at = `/v2/agents/${encodeURIComponent(id)}`;
    const item = { name: "invoice-sorter", file: "workflows/invoice-sorter/workflow.json", readme: "workflows/invoice-sorter/README.md", description: "Sorts an invoice into its ledger account", status: "active", run: null, bytes: 900, etag: '"a"' };
    await page.route(new RegExp(`${at}/learning$`), async (route) => { const real = await serverAnswer(route); await route.fulfill({ json: { ...(await real.json()), workflows: [item] } }); });
    await page.route(new RegExp(`${at}/learning/workflows/invoice-sorter/revisions(\\?.*)?$`), (route) => route.fulfill({ json: { name: "invoice-sorter", revisions: REVISIONS, total: REVISIONS.length, truncated: false } }));
    await page.route(new RegExp(`${at}/learning/promotions$`), (route) => route.fulfill({ json: {
      promotions: [promo(DIGESTS[0], "2026-11-03T15:00:00.000Z", "promote", "checked on 6 of the agent's inputs: answered 6 alone (100.0%, the bar 70.0%), and 6 of those said what the agent said (100.0%, the bar 80.0%): promoted", 6, 6), promo(DIGESTS[2], "2026-11-05T15:00:00.000Z", "hold", HELD, 6, 4)],
      serving: [{ workflow: "invoice-sorter", digest: DIGESTS[0], replaying: null }],
    } }));
    // The replay: POST answers 202, then a read says running (the card's progress), then the next (POLL_MS later) done and
    // held; a second POST is refused 409.
    let posts = 0, reads = 0;
    await page.route(new RegExp(`${at}/learning/workflows/invoice-sorter/revisions/${DIGESTS[2]}/replays(/.*)?$`), (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        posts += 1;
        if (posts > 1) return route.fulfill({ status: 409, json: { error: { code: "replay_conflict", message: `invoice-sorter at ${DIGESTS[2]} has no input to replay on: none of the runs it was last checked on has an input it fits. Nothing was started.`, retryable: false } } });
        return route.fulfill({ status: 202, json: { replay: REPLAY.replay, inputs: REPLAY.inputs } });
      }
      reads += 1;
      return route.fulfill({ json: reads < 2
        ? replay({ outcomes: { answered: reads, handed_back: 0, failed: 0, skipped_write: 0 } })
        : replay({ status: "done", decided: "hold", reason: HELD, outcomes: { answered: 6, handed_back: 0, failed: 0, skipped_write: 0 }, score: { n: 6, agree: 4, agent_acc: 1, wf_acc: 0.6667, delta: -0.3333, handed_back: 0 } }) });
    });
    const shots = process.env.E2E_SHOTS;
    if (shots) mkdirSync(shots, { recursive: true });
    const shoot = async (box, name) => { if (shots) { await markExample(box); await box.screenshot({ path: join(shots, name) }); } };
    for (const width of WIDTHS) {
      posts = 0; reads = 0;
      const where = `${width}px`;
      await page.setViewportSize({ width, height: 1100 });
      await page.goto(`${base}/#/agents/${encodeURIComponent(id)}/learning`);
      await page.reload();
      const card = page.getByRole("region", { name: "Learned workflow" });
      await card.getByText("Revision 3 of 3").waitFor();
      await page.evaluate(() => document.fonts.ready);
      const button = card.getByRole("button", { name: "Check revision 3333333 on the inputs of the agent's own runs" });
      check(await button.isVisible(), `${where}: the held revision offers no Replay`);
      check((await button.textContent()) === "Replay", `${where}: the button says ${await button.textContent()}`);
      await shoot(card, `replay-button-${width}-offered.png`);
      await button.click();
      const progress = card.getByTestId("replay-progress");
      await progress.waitFor();
      await shoot(card, `replay-button-${width}-running.png`);
      const decision = card.getByTestId("replay-decision");
      await decision.waitFor({ timeout: 15_000 });
      const said = await decision.textContent();
      // The decision's sentence, then the score's line inside it (asserted whole below).
      check(said.startsWith("Still held. Checked on 6 of the agent's inputs: answered 6 alone (100.0%, the bar 70.0%), and 4 of those said what the agent said (66.7%, the bar 80.0%): held"), `${where}: the decision says ${said}`);
      check((await card.getByTestId("replay-score").textContent()) === "Workflow 67% vs agent 100% on 6 inputs of the agent's own runs, 4 said what the agent said, 0 handed back", `${where}: the score says ${await card.getByTestId("replay-score").textContent()}`);
      await shoot(card, `replay-button-${width}-decided.png`);
      // Again: the server refuses a second, and the card shows its words.
      await card.getByRole("button", { name: "Check revision 3333333 on the inputs of the agent's own runs" }).click();
      const refused = card.getByTestId("replay-refused");
      await refused.waitFor();
      check((await refused.textContent()).includes("has no input to replay on: none of the runs it was last checked on has an input it fits") && (await refused.textContent()).includes("replay_conflict"), `${where}: the refusal says ${await refused.textContent()}`);
      await shoot(card, `replay-button-${width}-refused.png`);
      // The serving revision offers none.
      const slider = card.getByRole("slider", { name: "Revision" });
      await slider.focus();
      await page.keyboard.press("Home");
      check((await card.getByRole("button", { name: /^Check revision/ }).count()) === 0, `${where}: the serving revision offers Replay`);
      const wide = await page.evaluate(() => ({ page: document.scrollingElement.scrollWidth, view: window.innerWidth }));
      check(wide.page <= wide.view, `${where}: the page scrolls sideways (${wide.page}px in ${wide.view}px)`);
    }
    const others = errors.filter((e) => !/Failed to load resource: the server responded with a status of 409/.test(e));
    check(others.length === 0, `the page reported errors other than the 409s answered here: ${errors.join(" | ")}`);
  },
};
