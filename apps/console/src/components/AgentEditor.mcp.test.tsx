import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { AgentEditPage } from "./AgentsPage";
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

  it("says nothing of MCP on a server without MCP servers", () => {
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: agent(["read"]), caps: { ...CAPS, mcp: false }, step: "tools" }));
    expect(html).not.toContain("MCP");
  });
});

describe("a call to an MCP server's tool on the timeline", () => {
  it("is labelled <server> · <tool>", () => {
    const row = { id: "r1", seq: 1, kind: "tool_use", summary: "fake · add", text: null, timestamp: "2026-11-04T10:00:00Z", tool_name: "mcp__fake__add", tool_status: "success" } as TimelineRow;
    const html = renderToStaticMarkup(createElement(Timeline, { rows: [row], live: false }));
    expect(html).not.toContain("mcp__fake__add");
    expect(html).toContain("fake · add");
  });
});
