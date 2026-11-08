// Take over the agent's browser and hand it back, in the viewer the run page frames (Watch live). The run's browser is
// pi-browser's fake backend (the serve tests' fauxBrowser), and its model asks for the person in the browser
// (faux-browse-handoff: a snapshot, then browser_request_handoff, then a question naming the hand-off's result). In the
// framed viewer, Take over holds the browser for the owner, and Hand back gives it back; with the agent's ask pending,
// handing back answers it "done", so the run goes on to its question. The timeline says who had the browser.
import { check } from "../harness.mjs";

const AGENT = "drive";

export default {
  name: "take-over",
  signedIn: true,
  server: {
    faux: "faux-browse-handoff.mjs",
    fakes: { fauxBrowser: "faux-browser.mjs" },
    // The browser tool is offered with a vendor's variables set; the fake backend never reads their values.
    env: { BROWSERBASE_API_KEY: "not-a-secret", BROWSERBASE_PROJECT_ID: "e2e-project" },
  },
  async run({ page, base, api }) {
    const made = await api("POST", "/agents", { definition: { id: AGENT, name: "Drive", instructions: "Browse.", tools: ["browser", "ask_person"] } });
    check(made.status === 201, `creating the agent answered ${made.status}`);
    const started = await api("POST", `/agents/${AGENT}/runs`, { input: { content: "Browse the example page." } });
    check(started.status === 202, `starting the run answered ${started.status}`);
    const runId = started.body.run_id;
    const runPath = `/v2/runs/${encodeURIComponent(runId)}`;

    // The run page: its browser is live once the agent opens a page, and the tab says Watch live.
    await page.goto(`${base}/#/runs/${encodeURIComponent(runId)}`);
    const tab = page.getByRole("tab", { name: "Watch live" });
    await tab.waitFor();
    await tab.click();
    const viewer = page.frameLocator('section[aria-label="Browser"] iframe');
    const hands = viewer.locator("#hands");
    await hands.waitFor();
    check((await hands.innerText()) === "Take over", `the viewer's button reads ${await hands.innerText()}`);

    // Take over: the viewer holds the browser for the owner.
    await hands.click();
    await viewer.getByText("you have the browser", { exact: true }).waitFor();
    check((await hands.innerText()) === "Hand back", `holding, the viewer's button reads ${await hands.innerText()}`);

    // Hand back: the browser goes back to the agent, and the ask it was waiting on is answered "done": the run's next
    // read (the page's own poll) has its question, the hand-off's result, in place of the browser ask.
    const moved = page.waitForResponse(async (r) => {
      if (r.request().method() !== "GET" || new URL(r.url()).pathname !== runPath || !r.ok()) return false;
      return (await r.json().catch(() => null))?.pending?.kind === "question";
    });
    await hands.click();
    await viewer.locator("#hands", { hasText: "Take over" }).waitFor();
    const pending = (await (await moved).json()).pending;
    // The question carries the hand-off tool's result as the model got it: {"ok":true,"outcome":"done",…}.
    const result = JSON.parse((pending.question ?? "").replace(/^Hand-off: /, ""));
    check(result.ok === true && result.outcome === "done", `the hand-off's result: ${pending.question}`);

    const rows = (await api("GET", `${runPath.replace(/^\/v2/, "")}/timeline`)).body?.rows ?? [];
    const said = rows.map((row) => row.summary);
    check(said.includes("You took over the browser"), `the timeline never says the owner took the browser: ${JSON.stringify(said)}`);
    check(said.includes("You handed the browser back"), `the timeline never says the owner handed it back: ${JSON.stringify(said)}`);
  },
};
