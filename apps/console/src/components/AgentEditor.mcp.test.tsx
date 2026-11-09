import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { AgentEditPage } from "./AgentsPage";
import { McpToolPicker } from "./McpToolPicker";
import { Timeline } from "./Timeline";
import { type Agent, toolOffers } from "@/lib/agentForm";
import { createClient } from "@/lib/client";
import type { McpServer } from "@/lib/mcp";
import type { TimelineRow } from "@/lib/v2";
import recorded from "@/fixtures/mcp.requests.json";

// The agent editor's Tools step on a server with saved MCP servers: a group per server lists its tools, ticking one
// grants `mcp:<server>/<tool>`, and a grant whose server is gone, or no longer lists the tool, says so.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CAPS = { harnesses: [{ id: "pi", available: true }, { id: "codex", available: true }], thinking: [], tools: toolOffers([{ name: "read", available: true }]), mcp: true, mcpHarnesses: ["pi", "claude-agent"] };
const definition = (tools: string[]) => ({ id: "calc", version: 1, name: "Calc", instructions: "Answer.", harness: "pi", skills: [], tools });
const agent = (tools: string[], harness = "pi"): Agent => ({ agent_id: "calc", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { ...definition(tools), harness } } as Agent);
const tool = (name: string, description: string) => ({ name, description, input_schema: { type: "object" } });
const FAKE: McpServer = { name: "fake", url: "http://127.0.0.1:4100/mcp", auth: { type: "none" }, credential: null, tools: [{ ...tool("add", "Add two numbers."), title: "Add" }, tool("delete_thing", "Delete a thing by id.")], protocol: "2026-07-28", listed_at: "2026-11-04T10:00:00Z", updated_at: "2026-11-04T10:00:00Z" };

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

describe("the Tools step's MCP servers", () => {
  it("ticks fake/add and saves mcp:fake/add: the request the server replay sends", async () => {
    const puts: { path: string; body: unknown }[] = [];
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
    const fetch = (async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        puts.push({ path, body });
        return json(200, { ...agent(body.definition.tools), revision: "r2", revisions: 2, definition: body.definition }, { etag: '"r2"' });
      }
      if (path === "/v2/agents/calc") return json(200, agent(["read"]), { etag: '"r1"' });
      if (path.startsWith("/v2/agents/calc/revisions")) return json(200, { revisions: [{ revision: "r1", version: 1, current: true, note: null, created_at: "2026-11-04T10:00:00Z", kind: "agentic", definition: definition(["read"]) }], next_cursor: null });
      if (path === "/v2/settings/mcp-servers") return json(200, { servers: [FAKE] });
      return json(404, { error: { code: "not_found", message: path, retryable: false } });
    }) as typeof globalThis.fetch;
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentEditPage, { v2: createClient({ fetch }), caps: CAPS, agentId: "calc", go: () => {} })));
    const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
    await settle();
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Tools & skills"))!.click(); });
    await settle();
    const group = host.querySelector('[aria-label="MCP server fake"]')!;
    expect(group.textContent).toContain("Add two numbers.");
    await act(async () => { (group.querySelector('input[value="mcp:fake/add"]') as HTMLInputElement).click(); });
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save revision")!.click(); });
    await settle();
    const grant = recorded.requests.find((r) => r.step === "grant fake/add")!;
    expect(puts).toEqual([{ path: grant.path, body: grant.body }]);
  });

  it("warns of a grant whose server was deleted, and of one its server no longer lists", () => {
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: agent(["read", "mcp:gone/search", "mcp:fake/paid", "mcp:fake/add"]), caps: CAPS, step: "tools", mcpServers: [FAKE] }));
    expect(html).toContain("mcp:gone/search");
    expect(html).toContain("The MCP server gone is not saved here any more");
    expect(html).toContain("fake no longer lists paid");
    expect(html).toMatch(/value="mcp:fake\/add"[^>]*checked=""|checked=""[^>]*value="mcp:fake\/add"/);
  });

  it("marks each tool its server's read says is not metered, and no other", () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(McpToolPicker, { servers: [{ ...FAKE, prices: { add: 0.01 }, not_metered: ["delete_thing"] }], tools: [], harness: "pi", onChange: () => {} })));
    const label = (grant: string) => host.querySelector(`input[value="${grant}"]`)!.closest("label")!.textContent ?? "";
    expect(label("mcp:fake/delete_thing")).toContain("not metered");
    expect(label("mcp:fake/add")).not.toContain("not metered");
  });

  it("offers nothing new on a harness that doesn't run MCP tools here, and a grant there says it won't run", () => {
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: agent(["read", "mcp:fake/add"], "codex"), caps: CAPS, step: "tools", mcpServers: [FAKE] }));
    expect(html).toContain("codex doesn&#x27;t run MCP tools on this server: pi and claude-agent do.");
    expect(html).toMatch(/value="mcp:fake\/delete_thing"[^>]*disabled=""|disabled=""[^>]*value="mcp:fake\/delete_thing"/);
    expect(html).not.toMatch(/value="mcp:fake\/add"[^>]*disabled=""|disabled=""[^>]*value="mcp:fake\/add"/);
    expect(html).toContain("Won&#x27;t run on codex.");
  });

  it("keeps the grants, with Retry, when the servers can't be read, and Retry reads them again", async () => {
    let reads = 0;
    const fetch = (async (url: string) => {
      const path = String(url);
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", etag: '"r1"' } });
      if (path === "/v2/agents/calc") return json(200, agent(["read", "mcp:fake/add"]));
      if (path.startsWith("/v2/agents/calc/revisions")) return json(200, { revisions: [], next_cursor: null });
      if (path === "/v2/settings/mcp-servers") return ++reads === 1 ? json(503, { error: { code: "unavailable", message: "busy", retryable: true } }) : json(200, { servers: [FAKE] });
      return json(404, { error: { code: "not_found", message: path, retryable: false } });
    }) as typeof globalThis.fetch;
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentEditPage, { v2: createClient({ fetch }), caps: CAPS, agentId: "calc", go: () => {} })));
    const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
    await settle();
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Tools & skills"))!.click(); });
    await settle();
    expect(host.textContent).toContain("The MCP servers could not be read.");
    expect((host.querySelector('input[value="mcp:fake/add"]') as HTMLInputElement).checked).toBe(true);
    expect(host.textContent).toContain("Can't check right now");
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Retry")!.click(); });
    await settle();
    expect(reads).toBe(2);
    expect(host.querySelector('[aria-label="MCP server fake"]')).not.toBeNull();
    expect((host.querySelector('input[value="mcp:fake/add"]') as HTMLInputElement).checked).toBe(true);
  });

  it("keeps the newest read of the servers: an older one that fails last never replaces it", async () => {
    const answers: ((r: Response) => void)[] = [];
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", etag: '"r1"' } });
    const fetch = (async (url: string) => {
      const path = String(url);
      if (path === "/v2/agents/calc") return json(200, agent(["read", "mcp:fake/add"]));
      if (path.startsWith("/v2/agents/calc/revisions")) return json(200, { revisions: [], next_cursor: null });
      if (path === "/v2/settings/mcp-servers") return new Promise<Response>((done) => answers.push(done));
      return json(404, { error: { code: "not_found", message: path, retryable: false } });
    }) as typeof globalThis.fetch;
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentEditPage, { v2: createClient({ fetch }), caps: CAPS, agentId: "calc", go: () => {} })));
    const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
    await settle();
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Tools & skills"))!.click(); });
    // A second read while the first is still out (the page given its client again reads them again).
    act(() => root!.render(createElement(AgentEditPage, { v2: createClient({ fetch }), caps: CAPS, agentId: "calc", go: () => {} })));
    await settle();
    expect(answers.length).toBe(2);
    await act(async () => { answers[1](json(200, { servers: [FAKE] })); });
    await settle();
    await act(async () => { answers[0](json(503, { error: { code: "unavailable", message: "busy", retryable: true } })); });
    await settle();
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Tools & skills"))!.click(); });
    await settle();
    expect(host.querySelector('[aria-label="MCP server fake"]')).not.toBeNull();
    expect(host.textContent).not.toContain("could not be read");
  });

  it("disables a tool whose grant the server refuses by name, and an existing grant of it can be removed", async () => {
    const long = "a".repeat(42); // mcp__fake__ and 42 characters: 53, past the 52 a wire name has
    const server = { ...FAKE, tools: [...FAKE.tools, tool(long, "A tool with a long name.")] };
    const html = renderToStaticMarkup(createElement(McpToolPicker, { servers: [server], tools: [], harness: "pi", onChange: () => {} }));
    expect(html).toMatch(new RegExp(`value="mcp:fake/${long}"[^>]*disabled=""|disabled=""[^>]*value="mcp:fake/${long}"`));
    expect(html).toContain("name too long to grant (53/52)");
    expect(html).not.toMatch(/value="mcp:fake\/add"[^>]*disabled=""|disabled=""[^>]*value="mcp:fake\/add"/);
    let now: string[] = [];
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(McpToolPicker, { servers: [server], tools: ["read", `mcp:fake/${long}`], harness: "pi", onChange: (t: string[]) => { now = t; } })));
    const box = host.querySelector(`input[value="mcp:fake/${long}"]`) as HTMLInputElement;
    expect([box.checked, box.disabled]).toEqual([true, false]);
    await act(async () => { box.click(); });
    expect(now).toEqual(["read"]);
  });

  it("disables, on claude-agent alone, a tool whose schema's root the Claude CLI drops it for", () => {
    const server = { ...FAKE, tools: [...FAKE.tools, { name: "either", description: "One shape or another.", input_schema: { type: "object", anyOf: [{ required: ["a"] }, { required: ["b"] }] } }] };
    const disabled = (harness: string) => /value="mcp:fake\/either"[^>]*disabled=""|disabled=""[^>]*value="mcp:fake\/either"/.test(renderToStaticMarkup(createElement(McpToolPicker, { servers: [server], tools: [], harness, onChange: () => {} })));
    expect(disabled("claude-agent")).toBe(true);
    expect(disabled("pi")).toBe(false);
    expect(renderToStaticMarkup(createElement(McpToolPicker, { servers: [server], tools: [], harness: "claude-agent", onChange: () => {} }))).toContain("claude-agent drops a tool whose schema&#x27;s root has anyOf");
  });

  it("takes a list whose file can't be read as a failed read: the grants can't be checked, never deleted", async () => {
    const fetch = (async (url: string) => {
      const path = String(url);
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", etag: '"r1"' } });
      if (path === "/v2/agents/calc") return json(200, agent(["read", "mcp:fake/add"]));
      if (path.startsWith("/v2/agents/calc/revisions")) return json(200, { revisions: [], next_cursor: null });
      if (path === "/v2/settings/mcp-servers") return json(200, { servers: [], file_unreadable: true });
      return json(404, { error: { code: "not_found", message: path, retryable: false } });
    }) as typeof globalThis.fetch;
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentEditPage, { v2: createClient({ fetch }), caps: CAPS, agentId: "calc", go: () => {} })));
    const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
    await settle();
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Tools & skills"))!.click(); });
    await settle();
    expect(host.textContent).toContain("The MCP servers could not be read.");
    expect(host.textContent).toContain("Can't check right now");
    expect(host.textContent).not.toContain("not saved here any more");
    expect([...host.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Retry")).toBe(true);
  });

  it("says nothing of MCP on a server without MCP servers", () => {
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: agent(["read"]), caps: { ...CAPS, mcp: false }, step: "tools" }));
    expect(html).not.toContain("MCP");
  });
});

describe("a call to an MCP server's tool on the timeline", () => {
  it("reads a call set to ask as waiting on your approval, never failed, and an unpriced call as not metered", () => {
    const at = "2026-11-05T10:00:00Z";
    const rows = [
      { id: "r1", seq: 1, kind: "tool_use", summary: "fake · add", text: null, timestamp: at, tool_name: "mcp__fake__add", tool_use_id: "c1", tool_status: "success", tool_result_preview: "Waiting for your approval" },
      { id: "r2", seq: 2, kind: "tool_approval_requested", summary: "Waiting for your approval: mcp:fake/add", text: null, timestamp: at, tool_name: "mcp__fake__add", tool_use_id: "c1" },
      { id: "r3", seq: 3, kind: "phase", summary: "Not metered: mcp__fake__add has no price set, so it is outside the run's cost", text: null, timestamp: at, tool_name: "mcp__fake__add", tool_use_id: "c1" },
      { id: "r4", seq: 4, kind: "usage", summary: "Cost: $0.00 for 1 request; 1 tool call not metered", text: null, timestamp: at, tool_name: null, usage: { usd: 0, requests: 1, not_metered: 1 } },
    ] as unknown as TimelineRow[];
    const html = renderToStaticMarkup(createElement(Timeline, { rows, live: false }));
    expect(html).toContain("fake · add");
    expect(html).toContain("Your approval");
    expect(html).not.toContain(">Error<");
    expect(html).toContain("Not metered: mcp__fake__add has no price set");
    expect(html).toContain("1 tool call not metered");
  });

  it("is labelled <server> · <tool>", () => {
    const row = { id: "r1", seq: 1, kind: "tool_use", summary: "fake · add", text: null, timestamp: "2026-11-04T10:00:00Z", tool_name: "mcp__fake__add", tool_status: "success" } as TimelineRow;
    const html = renderToStaticMarkup(createElement(Timeline, { rows: [row], live: false }));
    expect(html).not.toContain("mcp__fake__add");
    expect(html).toContain("fake · add");
  });
});
