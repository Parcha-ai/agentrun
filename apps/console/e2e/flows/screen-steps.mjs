// The Screen tab's live screen with the run's steps beside it, measured in a real browser (jsdom lays nothing out). A run
// browses (pi-browser's fake browser: no vendor, no key) and asks the person, so it waits with its session open and its
// page framed. The run's steps so far are listed with it:
//  - on a window 1440 px wide they sit beside the frame, no taller than it, and the frame is no narrower than the
//    reading column it had alone (some 830 px): the panel is wider by the list;
//  - on a window 1920 px wide the frame is no wider than 900 px: it keeps its size and does not grow with the window,
//    where a frame taller than the page shows would need scrolling to watch;
//  - at 1100 px they sit under the frame, in a short box of their own;
//  - at 390 px nothing scrolls sideways;
//  - the frame is the same element at every width: the viewer is never loaded again by a change of layout.
// The viewer's link holds its token: it is never read out, printed or compared as text.
import { check } from "../harness.mjs";

/** The frame and the list, as laid out now. */
const measure = () => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) }; };
  const list = document.querySelector('[role="region"][aria-label="The run\'s steps"]');
  return {
    frame: box(document.querySelector('iframe[title="The run\'s screen"]')),
    list: box(list),
    steps: [...list.querySelectorAll("li")].map((li) => li.textContent ?? ""),
    sideways: document.documentElement.scrollWidth - innerWidth,
  };
};

export default {
  name: "screen-steps",
  signedIn: true,
  server: {
    faux: "faux-browse-ask.mjs",
    fauxBrowser: "faux-browser.mjs",
    // The browser tool is offered when its vendor's keys are set; the fake browser never sends them anywhere.
    env: { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" },
  },
  async run({ page, api, origin }) {
    const agent = await api("POST", "/agents", { definition: { id: "watch", name: "watch", instructions: "Browse, then ask.", tools: ["browser", "ask_person"] } });
    check(agent.status === 201, `creating the agent answered ${agent.status}`);
    const started = await api("POST", "/agents/watch/runs", { input: { content: "Browse the example page." } });
    check(started.status === 202, `starting the run answered ${started.status}`);
    const runId = started.body.run_id;

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${origin}/#/runs/${encodeURIComponent(runId)}`);
    await page.getByRole("tab", { name: "Screen" }).click({ timeout: 45_000 });
    const frame = page.locator('iframe[title="The run\'s screen"]');
    await frame.waitFor({ timeout: 45_000 });
    await page.locator('[role="region"][aria-label="The run\'s steps"] li').first().waitFor();
    // The frame as an element, to tell a new one from the same one.
    await frame.evaluate((el) => { el.dataset.e2e = "first"; });

    // 1440 px: beside the frame, no taller than it, the frame as wide as it was alone.
    const wide = await page.evaluate(measure);
    check(wide.steps.some((s) => s.includes("Browse the example page.")), `the list has the run's first step: ${JSON.stringify(wide.steps)}`);
    check(wide.list.left >= wide.frame.right - 1, `at 1440 px the steps are beside the frame: frame ${JSON.stringify(wide.frame)}, list ${JSON.stringify(wide.list)}`);
    check(wide.list.bottom <= wide.frame.bottom + 1, `at 1440 px the steps are no taller than the frame: frame ends ${wide.frame.bottom}, list ends ${wide.list.bottom}`);
    check(wide.frame.width >= 820, `at 1440 px the frame keeps the width it had alone: ${wide.frame.width} px`);
    check(wide.sideways <= 0, `at 1440 px the page scrolls sideways by ${wide.sideways} px`);

    // 1920 px: still beside, and the frame has not grown with the window.
    await page.setViewportSize({ width: 1920, height: 1080 });
    const large = await page.evaluate(measure);
    check(large.list.left >= large.frame.right - 1, `at 1920 px the steps are beside the frame: frame ${JSON.stringify(large.frame)}, list ${JSON.stringify(large.list)}`);
    check(large.frame.width >= 820 && large.frame.width <= 900, `at 1920 px the frame keeps its size: ${large.frame.width} px wide`);

    // 1100 px: under the frame, in a short box.
    await page.setViewportSize({ width: 1100, height: 900 });
    const narrow = await page.evaluate(measure);
    check(narrow.list.top >= narrow.frame.bottom - 1, `at 1100 px the steps are under the frame: frame ${JSON.stringify(narrow.frame)}, list ${JSON.stringify(narrow.list)}`);
    check(narrow.list.height <= 289, `at 1100 px the steps scroll in a short box: ${narrow.list.height} px tall`);
    check(narrow.sideways <= 0, `at 1100 px the page scrolls sideways by ${narrow.sideways} px`);

    // 390 px: nothing scrolls sideways.
    await page.setViewportSize({ width: 390, height: 844 });
    const phone = await page.evaluate(measure);
    check(phone.sideways <= 0, `at 390 px the page scrolls sideways by ${phone.sideways} px`);
    check(phone.list.width <= 390 && phone.frame.width <= 390, `at 390 px the frame (${phone.frame.width} px) and the steps (${phone.list.width} px) fit the window`);

    check(await frame.evaluate((el) => el.dataset.e2e) === "first", "the frame is the same element at every width");

    // The run ends (a follow-up answers its question): the frame goes, and its steps with it.
    const answered = await api("POST", `/runs/${encodeURIComponent(runId)}/messages`, { content: "Yes, that is all." });
    check(answered.status === 202, `answering the run answered ${answered.status}`);
    await page.getByText("The browser closed when the run ended.").waitFor({ timeout: 45_000 });
    check(await page.locator('[role="region"][aria-label="The run\'s steps"]').count() === 0, "an ended run's closed screen has no steps beside it");
  },
};
