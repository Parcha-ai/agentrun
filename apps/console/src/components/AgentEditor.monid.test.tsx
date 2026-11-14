import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentPage } from "./AgentPage";
import { AgentEditPage } from "./AgentsPage";
import { toolOffers } from "@/lib/agentForm";
import { createClient } from "@/lib/client";

// The agent editor's Tools step grants monid endpoints by name: `monid:<provider>/<endpoint>`, or `monid:<provider>/*`
// for every endpoint of a provider that monid prices per call. The grant is typed into the monid row and saved in the
// agent's tools, where the server pins it against monid's listing.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CAPS = { harnesses: [{ id: "pi", available: true }], thinking: [], tools: toolOffers([{ name: "read", available: true, harnesses: ["pi", "claude-agent", "codex", "opencode"] }]) };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
/** Types `text` into the input, as a person does (React reads the value through its own setter). */
const type = async (input: HTMLInputElement, text: string) => {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text); input.dispatchEvent(new Event("input", { bubbles: true })); });
};
const button = (host: HTMLElement, text: string | RegExp) => [...host.querySelectorAll("button")].find((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? "")))!;

describe("the Tools step's monid row", () => {
  it("a grant typed into the row reaches the create's tools", async () => {
    const posts: { path: string; body: { definition: { tools: string[] } } }[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === "POST" && path === "/v2/agents") {
        const body = JSON.parse(String(init.body));
        posts.push({ path, body });
        return json(201, { agent_id: "searcher", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: body.definition, warnings: [] });
      }
      return json(404, { error: { code: "not_found", message: path, retryable: false } });
    }) as typeof globalThis.fetch;
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentEditPage, { v2: createClient({ fetch }), caps: CAPS, agentId: null, go: () => {} })));
    await settle();
    await type(host.querySelector("#agent-name") as HTMLInputElement, "Searcher");
    await act(async () => { button(host, /Tools & skills/).click(); });
    const row = host.querySelector('[aria-label="monid endpoints"]') as HTMLElement;
    expect(row).not.toBeNull();
    await type(row.querySelector('input[aria-label="monid grant"]') as HTMLInputElement, "monid:keenable/v1/search");
    await act(async () => { button(row, "Grant").click(); });
    await act(async () => { button(host, "Create").click(); });
    await settle();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.definition.tools).toEqual(["read", "monid:keenable/v1/search"]);
  });

  // The words the server answered on main (a local walk of #2765, saves only): a wildcard's left-out endpoint, and a
  // named grant monid prices by usage.
  const LEFT_OUT = "monid:exa/search is left out of monid:exa/*: monid:exa/search cannot be granted: monid prices it partly by usage (TIERED), so what one call costs is known only after it has run, and monid does not bound it (a run's maxCost checks only monid's estimate, which a call priced by usage can pass). A run's cap could not be kept: grant endpoints monid prices per call.";
  const REFUSED = "monid:ahrefs/keywords-explorer/related-terms cannot be granted: monid prices it per result (PER_RESULT), so what one call costs is known only after it has run, and monid does not bound it (a run's maxCost checks only monid's estimate, which a call priced by usage can pass). A run's cap could not be kept: grant endpoints monid prices per call.";

  /** An agent's edit page on a fake server: the agent with `tools`, and each PUT answered by `answer` (the saved agent by default). */
  const editPage = async (tools: string[], answer?: (body: { definition: { tools: string[] } }) => Response) => {
    const definition = (t: string[]) => ({ id: "searcher", version: 1, name: "Searcher", instructions: "Search.", harness: "pi", skills: [], tools: t });
    const agent = (t: string[]) => ({ agent_id: "searcher", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: definition(t) });
    const puts: { definition: { tools: string[] } }[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        return answer?.(body) ?? json(200, { ...agent(body.definition.tools), revision: "r2", revisions: 2, definition: body.definition, warnings: [] }, { etag: '"r2"' });
      }
      if (path === "/v2/agents/searcher") return json(200, agent(tools), { etag: '"r1"' });
      if (path.startsWith("/v2/agents/searcher/revisions")) return json(200, { revisions: [{ revision: "r1", version: 1, current: true, note: null, created_at: "2026-11-14T10:00:00Z", kind: "agentic", definition: definition(tools) }], next_cursor: null });
      return json(404, { error: { code: "not_found", message: path, retryable: false } });
    }) as typeof globalThis.fetch;
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentEditPage, { v2: createClient({ fetch }), caps: CAPS, agentId: "searcher", go: () => {} })));
    await settle();
    await act(async () => { button(host, /Tools & skills/).click(); });
    const row = () => host.querySelector('[aria-label="monid endpoints"]') as HTMLElement;
    const card = (grant: string) => row().querySelector(`input[type="checkbox"][value="${grant}"]`) as HTMLInputElement | null;
    const grant = async (name: string) => { await type(row().querySelector('input[aria-label="monid grant"]') as HTMLInputElement, name); await act(async () => { button(row(), "Grant").click(); }); };
    const save = async () => { await act(async () => { button(host, "Save revision").click(); }); await settle(); };
    return { host, puts, row, card, grant, save };
  };

  it("shows the agent's grants on edit, keeps them through an edit of something else, and unticking one takes it away", async () => {
    const page = await editPage(["read", "monid:keenable/v1/search", "monid:exa/*"]);
    expect(page.card("monid:keenable/v1/search")?.checked).toBe(true);
    expect(page.card("monid:exa/*")?.checked).toBe(true);
    // The built-in tools' cards never show a monid grant: the row does.
    expect(page.host.querySelectorAll('input[value="monid:keenable/v1/search"]')).toHaveLength(1);
    await act(async () => { button(page.host, /Context/).click(); });
    const instructions = page.host.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(instructions, "Search the web."); instructions.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.save();
    expect(page.puts.at(-1)!.definition.tools).toEqual(["read", "monid:keenable/v1/search", "monid:exa/*"]);
    await act(async () => { button(page.host, /Tools & skills/).click(); });
    await act(async () => { page.card("monid:exa/*")!.click(); });
    // Unticked, it stays on the row, to tick again.
    expect(page.card("monid:exa/*")?.checked).toBe(false);
    await page.save();
    expect(page.puts.at(-1)!.definition.tools).toEqual(["read", "monid:keenable/v1/search"]);
  });

  it("a saved grant unticked and saved keeps its card, unticked, and ticking it again puts it back in the next save", async () => {
    const page = await editPage(["read", "monid:keenable/v1/search", "monid:exa/*"]);
    await act(async () => { page.card("monid:exa/*")!.click(); });
    await page.save();
    expect(page.puts.at(-1)!.definition.tools).toEqual(["read", "monid:keenable/v1/search"]);
    // The saved revision no longer names it; the card stays, to tick again without typing the name.
    expect(page.card("monid:exa/*")?.checked).toBe(false);
    await act(async () => { page.card("monid:exa/*")!.click(); });
    await page.save();
    expect(page.puts.at(-1)!.definition.tools).toEqual(["read", "monid:keenable/v1/search", "monid:exa/*"]);
  });

  it("a new grant unticked keeps its card through a step change and back, and ticking it again puts it back in the save", async () => {
    const page = await editPage(["read"]);
    await page.grant("monid:exa/*");
    await act(async () => { page.card("monid:exa/*")!.click(); });
    await act(async () => { button(page.host, /Context/).click(); });
    await act(async () => { button(page.host, /Tools & skills/).click(); });
    expect(page.card("monid:exa/*")?.checked).toBe(false);
    await act(async () => { page.card("monid:exa/*")!.click(); });
    await page.save();
    expect(page.puts.at(-1)!.definition.tools).toEqual(["read", "monid:exa/*"]);
  });

  it("refuses a name outside monid's grammar before a save, in the server's words, and adds monid: when it was left off", async () => {
    const page = await editPage(["read"]);
    await page.grant("monid:Exa/*");
    expect(page.row().textContent).toContain("monid:Exa/* is not a monid endpoint's name: monid:<provider>/<endpoint> or monid:<provider>/*");
    expect(page.card("monid:Exa/*")).toBeNull();
    await page.grant("keenable/v1/search");
    expect(page.card("monid:keenable/v1/search")?.checked).toBe(true);
    await page.save();
    expect(page.puts.at(-1)!.definition.tools).toEqual(["read", "monid:keenable/v1/search"]);
  });

  it("after a save, shows the answer's warnings on the row and above the form, in the server's words", async () => {
    const page = await editPage(["read"], (body) => json(200, { agent_id: "searcher", kind: "agentic", revision: "r2", revisions: 2, archived_at: null, definition: body.definition, warnings: [{ field: "definition.tools[1]", reason: "not_an_option", message: LEFT_OUT }] }, { etag: '"r2"' }));
    await page.grant("monid:exa/*");
    await page.save();
    expect(page.puts.at(-1)!.definition.tools).toEqual(["read", "monid:exa/*"]);
    expect(page.row().querySelector('[aria-label="monid save warnings"]')?.textContent).toBe(LEFT_OUT);
    const banner = page.host.querySelector('[aria-label="Save warnings"]')!;
    expect(banner.textContent).toContain(LEFT_OUT);
    expect(banner.textContent).toContain("What the server said of its monid grants");
    // An endpoint left out of a grant does not keep the revision from running.
    expect(banner.textContent).not.toContain("A run of this revision is refused");
  });

  it("a save the server refuses at a grant shows its words on the row, once", async () => {
    const page = await editPage(["read"], () => json(422, { error: { code: "input_invalid", message: REFUSED, retryable: false, fields: [{ field: "definition.tools[1]", reason: "not_an_option", message: REFUSED }] } }));
    await page.grant("monid:ahrefs/keywords-explorer/related-terms");
    await page.save();
    expect(page.row().querySelector('[aria-label="monid grants refused"]')?.textContent).toBe(REFUSED);
    // On the row, and in the footer's line under Save; not again under the Tools field.
    expect(page.host.textContent!.split(REFUSED).length - 1).toBe(2);
    expect(page.card("monid:ahrefs/keywords-explorer/related-terms")?.closest("label")?.textContent).toContain("The save was refused here");
  });

  it("a create whose answer has warnings shows them on the agent's page it opens, in the server's words", async () => {
    // The client keeps a create's warnings for the page that opens next (a read carries none).
    let made: Record<string, unknown> | undefined;
    const fetch = (async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === "POST" && path === "/v2/agents") {
        made = { agent_id: "wide", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: JSON.parse(String(init.body)).definition };
        return json(201, { ...made, warnings: [{ field: "definition.tools[1]", reason: "not_an_option", message: LEFT_OUT }] });
      }
      if (path === "/v2/agents/wide" && made) return json(200, made, { etag: '"r1"' });
      if (path.startsWith("/v2/agents/wide/runs")) return json(200, { runs: [], next_cursor: null });
      return json(404, { error: { code: "not_found", message: path, retryable: false } });
    }) as typeof globalThis.fetch;
    const v2 = createClient({ fetch });
    await v2.createAgent({ definition: { version: 1, name: "Wide", instructions: "Search.", harness: "pi", skills: [], tools: ["read", "monid:exa/*"] } });
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentPage, { v2, agentId: "wide", go: () => {} })));
    await settle();
    const said = host.querySelector('[aria-label="Save warnings"]');
    expect(said?.textContent).toContain(LEFT_OUT);
    expect(said?.textContent).toContain("definition.tools[1]");
  });
});
