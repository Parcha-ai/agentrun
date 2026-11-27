// The app-trigger form's Event field in Chromium (QA #162: its filter sat in a box of its own above the Event dropdown). The
// field is its own search: typing in it opens its list right under it, filtered by an event's name, slug or description;
// pressing an event picks it, its words fill the field, and its config follows. The saved Composio server and its events
// are routed, so no Composio has to answer. The list is as wide as its field from the moment it opens: every width it has
// had on the page is read, since a list first drawn at its minimum width and widened a frame later reads right or wrong
// afterwards by when it is read.
import { check } from "../harness.mjs";

const SERVER = { name: "gh", url: "https://backend.composio.test/v3/mcp/srv_1/mcp", auth: { type: "headers", headers: ["x-api-key"] }, source: "composio", toolkit: "github", credential: "sealed", tools: [], protocol: "2026-07-28", listed_at: "2026-11-04T10:00:00Z", updated_at: "2026-11-04T10:00:00Z" };
const event = (slug, name, description) => ({ slug, name, description, polled: false, config: { type: "object", required: ["owner"], properties: { owner: { type: "string", title: "Owner" } } } });
const EVENTS = [
  event("GITHUB_ISSUE_ADDED_EVENT", "Issue Added Event", "Triggered when a new issue is added to the repository."),
  event("GITHUB_STAR_ADDED_EVENT", "Star Added", "Triggered when a star is added to the repository."),
  event("GITHUB_BRANCH_CHANGED_TRIGGER", "Branch Changed", "Triggers when a branch changes: head_sha, protected."),
  ...Array.from({ length: 40 }, (_, i) => event(`GITHUB_OTHER_${i}_EVENT`, `Other Event ${String(i).padStart(2, "0")}`, "Another event.")),
];

/** Notes every width a picker's list has on the page, from when it is put there (window.__listWidths). */
const watchLists = () => {
  const widths = (window.__listWidths = []);
  const note = () => { for (const list of document.querySelectorAll("[data-picker-list]")) widths.push(Math.round(list.getBoundingClientRect().width)); };
  new MutationObserver(note).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class"] });
};
/** The list open under `field` has been its field's width, and no other, since it opened. */
async function sameWidth(page, field, what) {
  const [widths, box] = [await page.evaluate(() => [...new Set(window.__listWidths)]), await field.boundingBox()];
  check(box && widths.length > 0 && widths.every((w) => Math.abs(w - box.width) <= 1), `${what} was drawn ${widths.join(" px, then ")} px wide under a field ${box && Math.round(box.width)} px wide`);
}

export default {
  name: "event-search",
  signedIn: true,
  async run({ page, base }) {
    await page.route("**/v2/settings/mcp-servers", (route) => route.fulfill({ json: { servers: [SERVER] } }));
    await page.route("**/v2/settings/mcp-servers/gh/composio/events", (route) => route.fulfill({ json: { events: EVENTS } }));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${base}/#/triggers/new-composio`);
    await page.getByRole("button", { name: "Composio server" }).click();
    await page.getByRole("option", { name: "gh (github)" }).click();
    const field = page.getByRole("combobox", { name: "Event" });
    await field.waitFor();
    check(await page.getByLabel("Filter events").count() === 0, "a filter box of its own is still beside the Event field");
    await page.evaluate(watchLists);
    await field.click();
    await field.pressSequentially("head_sha");
    const list = page.getByRole("listbox");
    await list.waitFor();
    const shown = await list.getByRole("option").allTextContents();
    check(JSON.stringify(shown) === JSON.stringify(["Branch Changed"]), `typing head_sha listed ${JSON.stringify(shown)}`);
    // The list opens right under its field, as wide as it.
    const [f, l] = [await field.boundingBox(), await list.boundingBox()];
    check(f && l && Math.abs(l.y - (f.y + f.height)) <= 4 && Math.abs(l.x - f.x) <= 1 && Math.abs(l.width - f.width) <= 1, `the list is not right under its field: field ${JSON.stringify(f)}, list ${JSON.stringify(l)}`);
    await sameWidth(page, field, "the Event list");
    await list.getByRole("option", { name: "Branch Changed" }).click();
    check(await list.isHidden(), "the list stayed open after a pick");
    check(await field.inputValue() === "Branch Changed", `the field reads ${await field.inputValue()} after the pick`);
    await page.locator('[name="config-owner"]').waitFor();
    // A search that matches nothing says so in the list; Escape puts the picked event's words back.
    await field.fill("nothing-like-it");
    check(await page.getByText("No event matches “nothing-like-it”").isVisible(), "a search that matches nothing does not say so");
    await field.press("Escape");
    check(await field.inputValue() === "Branch Changed", `Escape left the field reading ${await field.inputValue()}`);
    // The keyboard picks too: type, arrow down, Enter; Enter does not send the form.
    await field.fill("star");
    await field.press("ArrowDown");
    await field.press("Enter");
    check(await field.inputValue() === "Star Added", `the keyboard pick left the field reading ${await field.inputValue()}`);
    check(page.url().endsWith("#/triggers/new-composio"), `Enter left the form: ${page.url()}`);
  },
};
