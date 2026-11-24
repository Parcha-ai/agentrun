// Settings → Computers' Running now, on a real server. A run on --faux's desktop looks at it once and holds its turn
// (faux-desktop-look-hold-ask) while its desktop is up: the page lists it with its agent, kind and provider and its
// status as every run list says it, and the row opens the run. Let go, the run asks its person and parks; --faux's
// launch keeps no desktop for the resume, so its computer reads released and the page says no run with a computer is
// going. Answered, the run ends, and nothing is listed still. A run with no computer is never a row.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check } from "../harness.mjs";

/** The folder the faux model waits on (its file `go` lets the run ask), made with the flow's server. */
let hold;

export default {
  name: "computers-running",
  signedIn: true,
  server: () => {
    hold = mkdtempSync(join(tmpdir(), "computers-running-"));
    return { faux: "faux-desktop-look-hold-ask.mjs", env: { FAUX_HOLD_DIR: hold } };
  },
  async run({ page, api, origin }) {
    const made = await api("POST", "/agents", { definition: { id: "desk", name: "Desk", instructions: "Look, then ask.", skills: [], tools: ["ask_person"], computer: { kind: "desktop", provider: "faux-desktop" } } });
    check(made.status === 201, `creating the agent answered ${made.status}: ${JSON.stringify(made.body)}`);

    // Nothing is going yet.
    await page.goto(`${origin}/#/settings/computers`);
    const section = page.locator('section[aria-label="Running now"]');
    const none = section.getByText("No run with a computer is going now.");
    await none.waitFor();

    const started = await api("POST", "/agents/desk/runs", { input: { content: "Look at the desktop." } });
    check(started.status === 202, `starting the run answered ${started.status}: ${JSON.stringify(started.body)}`);
    const runId = started.body.run_id;
    /** Until `done(read)` holds for GET `path`'s body, within 30 s; a run that fails first fails the flow. */
    const until = async (path, done, what) => {
      for (let i = 0; ; i += 1) {
        const read = (await api("GET", path)).body;
        if (done(read)) return read;
        const run = path === `/runs/${runId}` ? read : (await api("GET", `/runs/${runId}`)).body;
        check(i < 300 && run.status !== "failed", `${what}: ${JSON.stringify(read)}`);
        await page.waitForTimeout(100);
      }
    };

    // The run works with its desktop up: it is listed.
    const listed = await until("/computers/running", (read) => read.runs?.[0]?.computer?.state === "ready", "GET /computers/running never listed the run's desktop ready");
    check(listed.runs.length === 1 && listed.runs[0].run_id === runId && listed.runs[0].computer.kind === "desktop", `GET /computers/running lists the run's desktop, ready: ${JSON.stringify(listed)}`);

    // The page (read again on a reload, rather than waiting for its next read) lists it.
    await page.reload();
    const row = section.locator(`li[data-running="${runId}"]`);
    await row.waitFor();
    const words = (await row.innerText()).replace(/\s+/g, " ");
    check(words.includes("desk · Desktop · Faux desktop"), `the row says its agent, kind and provider: ${words}`);
    check(/Working/i.test(words), `the row says the run works: ${words}`);

    // The row opens the run.
    await row.getByRole("link").click();
    await page.waitForFunction((id) => location.hash === `#/runs/${id}`, runId);
    await page.getByRole("tab", { name: "Screen" }).waitFor();

    // Let go, the run asks and parks: its desktop is released, and nothing is going.
    writeFileSync(join(hold, "go"), "");
    const parked = await until(`/runs/${runId}`, (run) => run.status === "input_required", "the run did not come to input_required");
    check(parked.computer?.state === "released", `a parked run whose desktop was let go reads released: ${JSON.stringify(parked.computer)}`);
    check((await api("GET", "/computers/running")).body.runs?.length === 0, "a parked run whose desktop was let go is still listed");
    await page.goto(`${origin}/#/settings/computers`);
    await none.waitFor();

    // Answered, the run ends: nothing is going still.
    const answered = await api("POST", `/runs/${runId}/messages`, { content: "The first tab." });
    check(answered.status === 202, `answering the run answered ${answered.status}`);
    await until(`/runs/${runId}`, (run) => run.status === "completed", "the run did not come to completed");
    await page.reload();
    await none.waitFor();
    check(await section.locator("li[data-running]").count() === 0, "an ended run is still listed");
  },
};
