// The agent's ask, answered from the run page with Done: the run's model asks for the person in its browser
// (faux-browse-handoff: a snapshot, then browser_request_handoff, then a question naming the hand-off's result), so the
// run reads input_required with the ask as pending (kind "browser"). The page moves to the Screen tab, and the card above
// it says what to do and how it will know; Done posts the one hand-back (POST …/computer/hand-back, every kind's) once,
// and the run goes on to its question with the hand-off's result "done".
import { check } from "../harness.mjs";

const AGENT = "asker";

export default {
  name: "ask-done",
  signedIn: true,
  server: {
    faux: "faux-browse-handoff.mjs",
    fauxBrowser: "faux-browser.mjs",
    // The browser tool is offered with a vendor's variables set; the fake backend never reads their values.
    env: { BROWSERBASE_API_KEY: "not-a-secret", BROWSERBASE_PROJECT_ID: "e2e-project" },
  },
  async run({ page, base, api }) {
    const made = await api("POST", "/agents", { definition: { id: AGENT, name: "Ask", instructions: "Browse.", tools: ["browser", "ask_person"] } });
    check(made.status === 201, `creating the agent answered ${made.status}`);
    const started = await api("POST", `/agents/${AGENT}/runs`, { input: { content: "Browse the example page." } });
    check(started.status === 202, `starting the run answered ${started.status}`);
    const runId = started.body.run_id;
    const runPath = `/v2/runs/${encodeURIComponent(runId)}`;
    const runRead = (kind) => page.waitForResponse(async (r) => {
      if (r.request().method() !== "GET" || new URL(r.url()).pathname !== runPath || !r.ok()) return false;
      return (await r.json().catch(() => null))?.pending?.kind === kind;
    });

    const asked = runRead("browser");
    await page.goto(`${base}/#/runs/${encodeURIComponent(runId)}`);
    const pending = (await (await asked).json()).pending;
    const card = page.getByRole("region", { name: "Waiting for you at the computer" });
    await card.getByText("Waiting for you · browser").waitFor();
    await card.getByText(`The agent asks you to: ${pending.instruction}`).waitFor();
    await card.getByText(`Done when: ${pending.completion_condition}`).waitFor();
    await page.getByRole("tab", { name: "Screen", selected: true }).waitFor();

    // Done answers it, once, at the one hand-back: the run goes on to its question with the hand-off's result.
    let posts = 0;
    const route = `${runPath}/computer/hand-back`;
    page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === route) posts += 1; });
    const moved = runRead("question");
    await card.getByRole("button", { name: "Done" }).click();
    const question = (await (await moved).json()).pending.question ?? "";
    const result = JSON.parse(question.replace(/^Hand-off: /, ""));
    check(result.ok === true && result.outcome === "done", `the hand-off's result: ${question}`);
    check(posts === 1, `Done posted ${posts} times to the hand-back`);
    await card.waitFor({ state: "detached" });
  },
};
