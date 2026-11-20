// The API playground's two panes, side by side, measured in a real browser (jsdom lays nothing out): the line under the
// Request header and the line under the Code/Response header are one line across the divider, and so are the line above
// the Request footer (Send request) and the line above the other pane's footer: the code's note, or Open this run once a
// run has started. Each bar used to take its own height from its own controls, so the lines stepped at the divider.
import { check } from "../harness.mjs";

/** Where each pane rules its header and footer lines, in px from the top of the window. */
function lines() {
  const request = document.querySelector('section[aria-label="Request"]');
  const other = document.querySelector('section[aria-label="Code and response"]');
  const open = [...other.querySelectorAll("button")].find((b) => b.textContent.trim() === "Open this run");
  const foot = open ?? other.querySelector("footer");
  const y = (el, edge) => Math.round(el.getBoundingClientRect()[edge] * 10) / 10;
  return {
    header: [y(request.querySelector("header"), "bottom"), y(other.querySelector("header"), "bottom")],
    footer: [y(request.querySelector("footer"), "top"), y(foot, "top")],
  };
}

const same = ([a, b]) => Math.abs(a - b) < 1;

export default {
  name: "playground-pane-lines",
  signedIn: true,
  async run({ page, base, api }) {
    const made = await api("POST", "/agents", { definition: { id: "screener", name: "Screener", instructions: "Answer the question.", skills: [], tools: [] } });
    check(made.status === 201, `creating the agent answered ${made.status}: ${JSON.stringify(made.body)}`);
    for (const width of [1600, 1440, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${base}/#/playground?agent=screener`);
      await page.getByRole("button", { name: "Send request", exact: true }).waitFor();
      await page.locator('section[aria-label="Request"] textarea').first().fill("Is Northwind Freight Ltd registered?");
      await page.evaluate(() => document.fonts.ready);
      // The page keeps its pane across widths: the code is the pane before a run starts.
      await page.locator('section[aria-label="Code and response"]').getByRole("button", { name: "Code", exact: true }).click();
      const code = await page.evaluate(lines);
      check(same(code.header), `${width} px, code: the header lines are at ${code.header.join(" and ")}`);
      check(same(code.footer), `${width} px, code: the footer lines are at ${code.footer.join(" and ")}`);
      await page.getByRole("button", { name: "Send request", exact: true }).click();
      await page.getByRole("button", { name: "Open this run", exact: true }).waitFor({ timeout: 45_000 });
      const response = await page.evaluate(lines);
      check(same(response.header), `${width} px, response: the header lines are at ${response.header.join(" and ")}`);
      check(same(response.footer), `${width} px, response: the footer lines are at ${response.footer.join(" and ")}`);
    }
  },
};
