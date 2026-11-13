// A run whose answer ends in a JSON record (faux-json-answer: words, then a fenced json block): its Report reads the
// record as fields (a nested field's value shown in words, a long string wrapped inside the page), with "Show raw JSON"
// for the record pretty-printed. Nothing in the Report is wider than its box.
import { check } from "../harness.mjs";

export default {
  name: "report-json",
  signedIn: true,
  server: { faux: "faux-json-answer.mjs" },
  async run({ page, base, api }) {
    const made = await api("POST", "/agents", { definition: { id: "lead", name: "Lead", instructions: "Find the lead.", tools: [] } });
    check(made.status === 201, `creating the agent answered ${made.status}`);
    const started = await api("POST", "/agents/lead/runs", { input: { content: "A new inbound lead arrived." } });
    check(started.status === 202, `starting the run answered ${started.status}`);
    await page.goto(`${base}/#/runs/${encodeURIComponent(started.body.run_id)}`);
    await page.getByRole("tab", { name: "Report" }).click();
    const fields = page.getByLabel("The answer's fields");
    await fields.waitFor({ timeout: 45_000 });
    await fields.getByText("Dana Whitfield", { exact: true }).waitFor();
    await fields.getByText("what it does").waitFor();
    // Nothing in the Report runs past its box: every element's right edge is inside the report's.
    const overflow = await page.evaluate(() => {
      const box = document.querySelector('[aria-label="The answer\'s fields"]').getBoundingClientRect();
      return [...document.querySelectorAll('[aria-label="The answer\'s fields"] *')].filter((e) => e.getBoundingClientRect().right > box.right + 1).length;
    });
    check(overflow === 0, `${overflow} elements run past the report's edge`);
    await page.getByRole("button", { name: "Show raw JSON" }).click();
    const raw = page.getByLabel("The answer's JSON");
    await raw.waitFor();
    check((await raw.textContent())?.includes('"what_it_does"') === true, "the raw JSON lacks its keys");
    const rawWide = await raw.evaluate((e) => e.scrollWidth > e.clientWidth + 1);
    check(!rawWide, "the raw JSON is wider than its box");
  },
};
