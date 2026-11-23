// Settings → Computers' Running now, on a real server. A run on --faux's desktop looks at it once and asks its person
// (faux-desktop-look-ask), so it waits with its desktop up: the page lists it with its agent, kind, provider and state,
// says it waits for the person, and its link opens the run. Once the question is answered and the run has ended, the
// page says no run with a computer is going. A run with no computer is never a row.
import { check } from "../harness.mjs";

export default {
  name: "computers-running",
  signedIn: true,
  server: { faux: "faux-desktop-look-ask.mjs" },
  async run({ page, api, origin }) {
    const made = await api("POST", "/agents", { definition: { id: "desk", name: "Desk", instructions: "Look, then ask.", skills: [], tools: ["ask_person"], computer: { kind: "desktop", provider: "faux-desktop" } } });
    check(made.status === 201, `creating the agent answered ${made.status}: ${JSON.stringify(made.body)}`);

    // Nothing is going yet.
    await page.goto(`${origin}/#/settings/computers`);
    const section = page.locator('section[aria-label="Running now"]');
    await section.getByText("No run with a computer is going now.").waitFor();

    const started = await api("POST", "/agents/desk/runs", { input: { content: "Look at the desktop." } });
    check(started.status === 202, `starting the run answered ${started.status}: ${JSON.stringify(started.body)}`);
    const runId = started.body.run_id;
    // The run waits on its question, its desktop up.
    for (let i = 0; ; i += 1) {
      const run = (await api("GET", `/runs/${runId}`)).body;
      if (run.status === "input_required") break;
      check(i < 300 && run.status !== "failed", `the run did not come to its question: ${run.status}`);
      await page.waitForTimeout(100);
    }
    const listed = (await api("GET", "/computers/running")).body;
    check(listed.computers?.length === 1 && listed.computers[0].run_id === runId && listed.computers[0].computer.kind === "desktop", `GET /computers/running lists the run's desktop: ${JSON.stringify(listed)}`);

    // The page (read again on a reload, rather than waiting for its next read) lists it.
    await page.reload();
    const row = section.locator(`li[data-running="${runId}"]`);
    await row.waitFor();
    const words = (await row.innerText()).replace(/\s+/g, " ");
    check(words.includes("desk · Desktop · Faux desktop"), `the row says its agent, kind and provider: ${words}`);
    check(/Ready/i.test(words) && /Waiting for you/i.test(words), `the row says the desktop is ready and the run waits for its person: ${words}`);

    // Its link opens the run.
    await row.getByRole("link", { name: /^Open / }).click();
    await page.waitForFunction((id) => location.hash === `#/runs/${id}`, runId);
    await page.getByRole("tab", { name: "Screen" }).waitFor();

    // Answered, the run ends: nothing is going.
    const answered = await api("POST", `/runs/${runId}/messages`, { content: "The first tab." });
    check(answered.status === 202, `answering the run answered ${answered.status}`);
    for (let i = 0; ; i += 1) {
      const run = (await api("GET", `/runs/${runId}`)).body;
      if (run.status === "completed") break;
      check(i < 300 && run.status !== "failed", `the run did not end: ${run.status}`);
      await page.waitForTimeout(100);
    }
    await page.goto(`${origin}/#/settings/computers`);
    await section.getByText("No run with a computer is going now.").waitFor();
    check(await section.locator("li[data-running]").count() === 0, "an ended run is still listed");
  },
};
