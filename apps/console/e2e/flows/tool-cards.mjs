// The agent editor's Tools & skills grid in Chromium, as Manuel saw it on beta.33 with Linear connected: an MCP server's
// tools printed their whole description (cards 60 lines tall) and the grid was ragged. Every card, a built-in tool's or
// an MCP server's, is one fixed height; a long description is clamped and More opens that card alone; a 2000-character
// unbroken string never widens a card. The MCP server list is this flow's own (routed), so no MCP server has to run.
import { check } from "../harness.mjs";

const LONG = "Create attachment (deprecated): Deprecated fallback for tiny files only. Accepts base64 file content, verifies SHA-256 checksum, and uploads it through the MCP worker. Prefer `prepare_attachment_upload` plus direct PUT plus `create_attachment_from_upload`. ".repeat(6);
const UNBROKEN = "QUJD".repeat(500);
const SERVER = {
  name: "linear", url: "https://mcp.linear.example/mcp", auth: { type: "none" }, credential: null, not_metered: ["create_attachment", "get_team", "upload_blob", "list_comments", "list_repository_collaborator_ids", "wide_example"],
  tools: [
    { name: "create_attachment", description: LONG },
    { name: "get_team", description: "Get a team by id." },
    { name: "upload_blob", description: `Example: ${UNBROKEN}` },
    { name: "list_comments", description: LONG },
    // 32 characters, no more than a count of characters would let pass, but cut beside the checkbox and "not metered" in
    // the e2e browser's columns: the card must still say it whole.
    { name: "list_repository_collaborator_ids", description: "List collaborators." },
    // 130 wide unbroken characters, under a count of 140, but past the card's three lines: More and a title all the same.
    { name: "wide_example", description: "W".repeat(130) },
  ],
};

export default {
  name: "tool-cards",
  signedIn: true,
  async run({ page, base, api }) {
    // The saved MCP servers, and an MCP client on this server for pi, so the Tools step lists Linear's tools.
    await page.route("**/v2/settings/mcp-servers", (route) => route.fulfill({ json: { servers: [SERVER] } }));
    await page.route("**/v2/capabilities", async (route) => {
      const response = await route.fetch();
      const caps = await response.json();
      await route.fulfill({ response, json: { ...caps, features: { ...caps.features, mcp_client: { ...(caps.features?.mcp_client ?? {}), harnesses: ["pi"] } } } });
    });
    // New agents start in the coding-agent handoff. Existing agents still expose the local editor.
    const made = await api("POST", "/agents", { definition: { version: 1, name: "Tool card layout", instructions: "Answer in one line.", harness: "pi", tools: [], skills: [] } });
    check(made.status === 201 || made.status === 200, `POST /v2/agents answered ${made.status}: ${JSON.stringify(made.body)}`);
    check(typeof made.body.agent_id === "string", "created agent has no id");
    await page.goto(`${base}/#/agents/${encodeURIComponent(made.body.agent_id)}/edit`);
    await page.locator("ol").first().getByRole("button", { name: /Tools & skills/ }).click();
    const mcp = (tool) => page.locator(`[data-tool-card="mcp:linear/${tool}"]`);
    await mcp("create_attachment").waitFor();
    const box = async (loc) => { const b = await loc.boundingBox(); check(b, "a card has no box"); return b; };

    // One height for every card, a built-in tool's and an MCP server's, short description or long.
    const cards = page.locator("[data-tool-card]");
    const heights = await cards.evaluateAll((all) => all.map((c) => [c.getAttribute("data-tool-card"), Math.round(c.getBoundingClientRect().height)]));
    check(heights.length >= 5, `only ${heights.length} tool cards`);
    check(new Set(heights.map(([, h]) => h)).size === 1, `the cards are not one height: ${JSON.stringify(heights)}`);

    // The 2000-character unbroken string: its card is as wide as a short one's, and nothing in the step scrolls sideways.
    const short = await box(mcp("get_team"));
    const blob = await box(mcp("upload_blob"));
    check(Math.abs(blob.width - short.width) < 1, `the unbroken string widened its card: ${blob.width} against ${short.width}`);
    const sideways = await page.evaluate(() => [...document.querySelectorAll("main, main *")].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== "hidden" && getComputedStyle(e).overflowX !== "clip" && e.closest("[data-tool-card]")).length);
    check(sideways === 0, `${sideways} elements in the tool cards are wider than their box`);

    // A name cut on its line, whatever its length, is whole in its title and offers More; one not cut has no title.
    const names = await cards.evaluateAll((all) => all.map((c) => {
      const name = c.querySelector("input[type=checkbox] + span");
      return { card: c.getAttribute("data-tool-card"), cut: name.scrollWidth > name.clientWidth + 1, widths: [name.clientWidth, name.scrollWidth, c.clientWidth], title: name.getAttribute("title"), text: name.textContent, more: [...c.querySelectorAll("button")].some((b) => b.textContent === "More") };
    }));
    const wrong = names.filter((n) => (n.cut ? n.title !== n.text || !n.more : n.title !== null));
    check(wrong.length === 0, `names whose title or More doesn't match whether they're cut: ${JSON.stringify(wrong)}`);
    // So with a description clamped on its three lines: whole in its title, with More; one not clamped has no title.
    const lines = await cards.evaluateAll((all) => all.flatMap((c) => {
      const line = c.querySelector("[data-line].line-clamp-3");
      return line ? [{ card: c.getAttribute("data-tool-card"), cut: line.scrollHeight > line.clientHeight + 1, title: line.getAttribute("title"), text: line.textContent, more: [...c.querySelectorAll("button")].some((b) => b.textContent === "More") }] : [];
    }));
    const wrongLines = lines.filter((n) => (n.cut ? n.title !== n.text || !n.more : n.title !== null)).map(({ card, cut, title, more }) => ({ card, cut, titled: title !== null, more }));
    check(wrongLines.length === 0, `descriptions whose title or More doesn't match whether they're clamped: ${JSON.stringify(wrongLines)}`);
    check(lines.find((n) => n.card === "mcp:linear/wide_example")?.cut, "the 130-character wide description isn't clamped here: the case this checks didn't happen");
    const collaborators = names.find((n) => n.card === "mcp:linear/list_repository_collaborator_ids");
    check(collaborators?.cut, `list_repository_collaborator_ids isn't cut here (${JSON.stringify(collaborators)}): the case this checks didn't happen`);

    // More opens that card alone: it grows, the others keep their height; still no wider. Less closes it.
    const listBefore = await box(mcp("list_comments"));
    await mcp("create_attachment").getByRole("button", { name: "More", exact: true }).click();
    const opened = await box(mcp("create_attachment"));
    check(opened.height > short.height + 40, `More didn't open the card: ${opened.height}`);
    check(Math.abs((await box(mcp("list_comments"))).height - listBefore.height) < 1, "More opened another card too");
    check((await box(mcp("get_team"))).height === short.height, "More changed a short card's height");
    await mcp("create_attachment").getByRole("button", { name: "Less", exact: true }).click();
    check(Math.abs((await box(mcp("create_attachment"))).height - short.height) < 1, "Less didn't close the card");
    await mcp("upload_blob").getByRole("button", { name: "More", exact: true }).click();
    const blobOpen = await box(mcp("upload_blob"));
    check(Math.abs(blobOpen.width - short.width) < 1, `the unbroken string widened its open card: ${blobOpen.width} against ${short.width}`);
    // Open, the whole string is shown: it wraps inside the card, never past its edge (nothing in it reaches further right).
    const past = await mcp("upload_blob").evaluate((card) => {
      const edge = card.getBoundingClientRect().right;
      return [card, ...card.querySelectorAll("*")].filter((e) => e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > edge + 1).length;
    });
    check(past === 0, `${past} elements of the open card reach past its edge`);
  },
};
