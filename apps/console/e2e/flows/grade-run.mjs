// Grade a run wrong from its page, with words: an agent that learns answers on the faux learning model
// (packages/serve/test/fixtures/faux-learn.mjs), its run ends, and its page's Grade control takes Wrong, the reviewer's
// words and the correct answer. The server answers the grade with a look-back round (`feedback: look_back`); the control
// says the agent is looking back, then that it looked back once the run has ended again; the Timeline shows the grade's
// words as "Your grade" and the round's learning row, which kept the reviewer's note (faux-learn keeps a "Review: "
// message as reviewed.md). Reading the page again shows the grade read back, with Grade again. E2E_SHOTS=<dir> saves the
// control and the Timeline at two widths.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { check } from "../harness.mjs";

const WORDS = "Review: the account is 6400 Shipping. Northwind is a freight vendor, not office supplies.";
const EXPECTED = '{"account": "6400"}';
const WIDTHS = [1440, 390];
const UNDER_WAY = new Set(["seeded", "reflecting", "proposed"]);

export default {
  name: "grade-run",
  signedIn: true,
  server: { faux: "faux-learn.mjs" },
  async run({ page, base, api }) {
    const shots = process.env.E2E_SHOTS;
    if (shots) mkdirSync(shots, { recursive: true });
    const shoot = async (box, name) => { if (shots) { await box.scrollIntoViewIfNeeded(); await box.screenshot({ path: join(shots, name) }); } };
    const settled = async (runId) => {
      for (let i = 0; i < 300; i++) {
        const r = (await api("GET", `/runs/${encodeURIComponent(runId)}`)).body;
        if (["completed", "failed", "cancelled"].includes(r.status) && !UNDER_WAY.has(r.learning?.state)) return r;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`run ${runId} did not settle`);
    };

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 1400 });
      // An agent of its own each width: what one round kept, the next agent's look-back would find already known.
      const made = await api("POST", "/agents", { definition: { version: 1, name: `Invoice sorter ${width}`, instructions: "Answer with the ledger account.", skills: [], tools: [], learning: true } });
      check(made.status === 201, `creating the agent answered ${made.status}: ${JSON.stringify(made.body)}`);
      const started = await api("POST", `/agents/${encodeURIComponent(made.body.agent_id)}/runs`, { input: { content: "Invoice 17 from Northwind Freight, $240." } });
      check(started.status === 202, `the start answered ${started.status}: ${JSON.stringify(started.body)}`);
      const runId = started.body.run_id;
      const first = await settled(runId);
      check(first.status === "completed", `the run ended ${first.status}`);

      await page.goto(`${base}/#/runs/${encodeURIComponent(runId)}`);
      const grade = page.getByRole("region", { name: "Grade" });
      await grade.getByText("Was the answer right?").waitFor({ timeout: 15_000 });
      await shoot(grade, `grade-choose-${width}.png`);

      // Wrong: the form, with the hint while the words are empty.
      await grade.getByRole("button", { name: "Wrong", exact: true }).click();
      await grade.getByText("A look-back needs words.").waitFor();
      await grade.getByRole("textbox", { name: "What was wrong?" }).fill(WORDS);
      await grade.getByRole("textbox", { name: /Correct answer/ }).fill(EXPECTED);
      check(!(await grade.getByText("A look-back needs words.").isVisible()), `${width}px: the hint stays with words typed`);
      await shoot(grade, `grade-wrong-form-${width}.png`);
      const put = page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === `/v2/runs/${encodeURIComponent(runId)}/grade`);
      await grade.getByRole("button", { name: "Send grade" }).click();
      const answered = await put;
      check(answered.ok(), `the grade answered ${answered.status()}: ${await answered.text()}`);
      const body = await answered.json();
      check(body.correct === false && body.feedback === "look_back", `${width}px: the grade's answer is ${JSON.stringify(body)}`);
      const sent = JSON.parse(answered.request().postData() ?? "{}");
      check(sent.label === WORDS && sent.expected?.account === "6400" && sent.correct === false, `${width}px: the grade sent ${JSON.stringify(sent)}`);
      await grade.getByText("Graded wrong").waitFor();

      // Files and back: the Grade control comes back with the grade it sent, never the choice again.
      const tabSwitch = async () => {
        await page.getByRole("tab", { name: /^Files/ }).click();
        await grade.waitFor({ state: "detached" });
        await page.getByRole("tab", { name: "Report", exact: true }).click();
        await grade.getByText("Graded wrong").waitFor();
        check(!(await grade.getByText("Was the answer right?").isVisible()), `${width}px: the choice is back after a tab switch`);
      };
      await tabSwitch();

      // The round ends: the run ended again and its learning settled.
      await settled(runId);
      await grade.getByText("The agent looked back on your words.").waitFor({ timeout: 30_000 });
      check(!(await grade.getByText("Reviewing", { exact: true }).isVisible()), `${width}px: still reviewing after the round ended`);
      await shoot(grade, `grade-reviewed-${width}.png`);
      // And once it ended: the round's outcome is still said.
      await tabSwitch();
      await grade.getByText("The agent looked back on your words.").waitFor();

      // The Timeline: the grade's words as "Your grade", and the round's learning row.
      await grade.getByRole("button", { name: "Open the Timeline" }).click();
      const words = page.getByText(WORDS, { exact: true }).first();
      await words.waitFor({ timeout: 15_000 });
      const row = words.locator("xpath=ancestor::li[1]");
      check(/Your grade/.test((await row.textContent()) ?? ""), `${width}px: the grade's row reads ${await row.textContent()}`);
      const learning = (await api("GET", `/runs/${encodeURIComponent(runId)}/learning`)).body;
      check(learning.graded?.correct === false && learning.learned?.some((n) => n.file === "reviewed.md"), `${width}px: the run's learning after the round: ${JSON.stringify(learning)}`);
      await shoot(page.locator("main"), `grade-timeline-${width}.png`);

      // Read again: the grade read back, with Grade again.
      await page.reload();
      const again = page.getByRole("region", { name: "Grade" });
      await again.getByText("Graded wrong").waitFor({ timeout: 15_000 });
      await again.getByRole("button", { name: "Grade again" }).waitFor();
      check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), `${width}px: the page scrolls sideways`);
    }
  },
};
