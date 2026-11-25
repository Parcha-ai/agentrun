// The agent editor's Tools & skills step, scrolled with a mouse wheel in Chromium (QA #21, beta.57: "scrolling moves the whole
// page instead of the list"). On a desktop window the editor's toolbar and its steps stay put and the step's own body
// scrolls: a wheel over a tool card moves the step's list, never the page (main, the console's one page scroller) nor
// the document. Many MCP tools (routed, so no MCP server has to run) make the list longer than any window. Six windows,
// desktop to phone: the report did not reproduce on beta.57 or later at any of them, so this pins the layout as it is.
import { check, serverAnswer } from "../harness.mjs";

const SERVER = {
  name: "many", url: "https://mcp.many.example/mcp", auth: { type: "none" }, credential: null, not_metered: [],
  tools: Array.from({ length: 60 }, (_, i) => ({ name: `tool_${String(i).padStart(2, "0")}`, description: `Tool number ${i}, one of many.` })),
};

export default {
  name: "tools-step-scroll",
  signedIn: true,
  async run({ page, base, api }) {
    await page.route("**/v2/settings/mcp-servers", (route) => route.fulfill({ json: { servers: [SERVER] } }));
    await page.route("**/v2/capabilities", async (route) => {
      const response = await serverAnswer(route);
      const caps = await response.json();
      await route.fulfill({ response, json: { ...caps, features: { ...caps.features, mcp_client: { ...(caps.features?.mcp_client ?? {}), harnesses: ["pi"] } } } });
    });
    const made = await api("POST", "/agents", { definition: { version: 1, name: "Scroll the tools", instructions: "Answer in one line.", harness: "pi", tools: [], skills: [] } });
    check(made.status === 201 || made.status === 200, `POST /v2/agents answered ${made.status}: ${JSON.stringify(made.body)}`);
    for (const [width, height] of [[1280, 720], [1500, 900], [1024, 640], [390, 844], [768, 1024], [820, 600]]) {
      const at = `${width}x${height}`;
      await page.setViewportSize({ width, height });
      await page.goto(`${base}/#/agents/${encodeURIComponent(made.body.agent_id)}/edit`);
      await page.reload();
      await page.locator("ol").first().getByRole("button", { name: /Tools & skills/ }).click();
      await page.locator('[data-tool-card="mcp:many/tool_10"]').waitFor();
      // A card in view: the first one.
      const card = page.locator("[data-tool-card]").first();
      const where = () => page.evaluate(() => {
        const step = [...document.querySelectorAll("section")].find((s) => s.querySelector("h2")?.textContent === "Tools & skills");
        const main = document.querySelector("main");
        return { step: step?.scrollTop ?? null, stepScrolls: step ? step.scrollHeight > step.clientHeight : null, main: main?.scrollTop ?? null, page: document.scrollingElement?.scrollTop ?? null, title: document.querySelector("h1")?.getBoundingClientRect().top ?? null };
      });
      const before = await where();
      check(before.stepScrolls === true, `${at}: the Tools step's body holds no more than it shows, so this flow tests nothing: ${JSON.stringify(before)}`);
      const box = await card.boundingBox();
      check(box && box.y >= 0 && box.y + 20 <= height, `${at}: the first tool card is not in view: ${JSON.stringify(box)}`);
      await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 20));
      await page.mouse.wheel(0, 600);
      // Wait for the step's list to move, up to 5 s: a slow worker scrolls late, never wrong. The checks below then say
      // what moved instead when it did not.
      await page.waitForFunction((from) => {
        const step = [...document.querySelectorAll("section")].find((s) => s.querySelector("h2")?.textContent === "Tools & skills");
        return (step?.scrollTop ?? 0) > from;
      }, before.step, { timeout: 5000 }).catch(() => {});
      const after = await where();
      check(after.step > before.step, `${at}: a wheel over a tool card did not scroll the step's list: ${JSON.stringify({ before, after })}`);
      check(after.main === before.main && after.page === before.page, `${at}: a wheel over a tool card scrolled the page: ${JSON.stringify({ before, after })}`);
      check(after.title === before.title, `${at}: the editor's title moved: ${JSON.stringify({ before, after })}`);
    }
  },
};
