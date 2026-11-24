// The Connect agent page's tabs (This server, Another machine, Existing application), measured in the browser where the
// page can hold the tabs and a button on one line (1280), where it cannot (820), and on a phone (390). The tabs and a
// coding-agent hand-off are both inline boxes: side by side with no row around them they shared one line, touched, and
// stood at two heights on the text's baseline. A class list says what was asked of the layout; only the laid-out boxes
// say what came of it. So on every tab, at every width: no control stands on the tabs' line, the tab's first box starts
// a page's gap under the tabs, each hand-off is a toolbar's control inside its section, and the page does not scroll
// sideways. A hand-off that heads a section (This server, Another machine) is level with the section's title at the row's
// right end, or under the title from its left edge where the row cannot hold both.
// E2E_SHOTS=<dir> also saves each tab at each width.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { check } from "../harness.mjs";

export const WIDTHS = [1280, 820, 390];
const TABS = [
  { tab: "This server", heading: "Discover on this server", heads: true },
  { tab: "Another machine", heading: "Connect remote agents", heads: true },
  { tab: "Existing application", heading: "Observe your existing agent", heads: false },
];
/** Between a page's panels (`space-y-6`), and a toolbar's control (`h-control-sm`): docs/console-design-system.md. */
const PAGE_GAP = 24, CONTROL_SM = 32;

/** The tabs' line and every hand-off on the page, measured where they are laid out. */
function measure() {
  const px = (n) => Math.round(n * 10) / 10;
  const page = document.querySelector('section[aria-label="Connect agent"]');
  const tabs = page.querySelector('[role="radiogroup"][aria-label="Connection method"]');
  const line = tabs.getBoundingClientRect();
  const name = (el) => (el.getAttribute("aria-label") ?? el.textContent ?? el.tagName).trim();
  // A hand-off is one control, its whole group, not the two buttons inside it.
  const controls = [...page.querySelectorAll('button, a[href], input, textarea, [role="group"]')].filter((el) => !tabs.contains(el) && !el.parentElement.closest('[role="group"]'));
  const beside = controls.filter((el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.top < line.bottom && r.bottom > line.top; }).map(name);
  const handoffs = [...page.querySelectorAll('[role="group"][aria-label$=" options"]')].map((el) => {
    const r = el.getBoundingClientRect();
    const section = el.closest("section");
    const s = section.getBoundingClientRect(), style = getComputedStyle(section);
    const inner = { left: s.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft), right: s.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight) };
    const row = el.parentElement, title = row.querySelector(":scope > h2")?.getBoundingClientRect();
    return {
      label: name(el), section: section.getAttribute("aria-label"), height: px(r.height), past: px(Math.max(inner.left - r.left, r.right - inner.right)),
      // With its section's title: whether the row holds both, and where the hand-off stands by the title.
      ...(title ? { fits: title.width + (parseFloat(getComputedStyle(row).columnGap) || 0) + r.width <= row.clientWidth, sameRow: r.top < title.bottom && r.bottom > title.top,
        offCentre: px(Math.abs((r.top + r.bottom) / 2 - (title.top + title.bottom) / 2)), fromRight: px(inner.right - r.right), fromLeft: px(r.left - title.left), under: px(r.top - title.bottom) } : {}),
    };
  });
  const main = document.querySelector("main");
  return { beside, under: px(tabs.nextElementSibling.getBoundingClientRect().top - line.bottom), handoffs, sideways: Math.max(document.documentElement.scrollWidth - innerWidth, main.scrollWidth - main.clientWidth) };
}

export default {
  name: "connect-agent-tabs",
  signedIn: true,
  async run({ page, base }) {
    const shots = process.env.E2E_SHOTS;
    if (shots) mkdirSync(shots, { recursive: true });
    const wrong = [];
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${base}/#/agents/connect`);
      for (const { tab, heading, heads } of TABS) {
        const at = `${width}px, ${tab}`;
        await page.getByRole("radiogroup", { name: "Connection method" }).getByText(tab, { exact: true }).click();
        await page.getByRole("heading", { name: heading }).waitFor();
        await page.evaluate(() => document.fonts.ready);
        if (shots) await page.screenshot({ path: join(shots, `connect-${width}-${tab.toLowerCase().replaceAll(" ", "-")}.png`), fullPage: true });
        const m = await page.evaluate(measure);
        if (m.beside.length) wrong.push(`${at}: on the tabs' line: ${m.beside.join(", ")}`);
        if (m.under !== PAGE_GAP) wrong.push(`${at}: the tab's first box starts ${m.under}px under the tabs, not ${PAGE_GAP}px`);
        if (m.sideways > 0) wrong.push(`${at}: the page scrolls sideways by ${m.sideways}px`);
        check(m.handoffs.length > 0, `${at}: no coding-agent hand-off`);
        for (const h of m.handoffs) {
          if (h.height !== CONTROL_SM) wrong.push(`${at}: ${h.label} is ${h.height}px high, not ${CONTROL_SM}px`);
          if (h.past > 0.5) wrong.push(`${at}: ${h.label} is ${h.past}px past the inside of its section (${h.section})`);
        }
        if (!heads) continue;
        const head = m.handoffs.find((h) => h.fits !== undefined);
        if (!head) wrong.push(`${at}: no hand-off beside a section's title`);
        else if (head.fits !== head.sameRow) wrong.push(`${at}: ${head.label} and its section's title ${head.fits ? "fit one row but take two" : "share a row that cannot hold both"}`);
        else if (head.sameRow && (head.offCentre > 0.5 || Math.abs(head.fromRight) > 0.5)) wrong.push(`${at}: ${head.label} is ${head.offCentre}px off its title's centre and ${head.fromRight}px from the row's right end`);
        else if (!head.sameRow && (Math.abs(head.fromLeft) > 0.5 || head.under < 0)) wrong.push(`${at}: ${head.label} wrapped ${head.fromLeft}px from its title's left edge, ${head.under}px under it`);
      }
    }
    check(wrong.length === 0, `the Connect agent page's tabs:\n${wrong.join("\n")}`);
  },
};
