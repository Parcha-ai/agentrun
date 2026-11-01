import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { AgentEditPage } from "./AgentsPage";
import { type Agent, toolOffers } from "@/lib/agentForm";
import { createClient } from "@/lib/client";

// The demo: a new agent created with its default tools saves, because capabilities mark the workflow's call-only tools
// (pdf_pages, llm) and the editor never offers or ticks them. The server refuses either in an agent's tools.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** `capabilities.tools` as the server lists them (its summaries left out). */
const TOOLS = [
  { name: "read", nodes: true, calls: false, available: true, harnesses: ["pi", "claude-agent", "codex"] },
  { name: "write", nodes: true, calls: false, available: true, harnesses: ["pi", "claude-agent", "codex"] },
  { name: "edit", nodes: true, calls: false, available: true, harnesses: ["pi", "claude-agent", "codex"] },
  { name: "ask_person", nodes: false, calls: false, available: true, harnesses: ["pi"] },
  { name: "fetch_page", nodes: true, calls: true, available: true, harnesses: ["pi", "claude-agent", "codex"] },
  { name: "web_fetch", nodes: true, calls: true, available: true, harnesses: ["pi", "claude-agent", "codex"] },
  { name: "browser", nodes: true, calls: false, available: false, missing: ["BROWSERBASE_API_KEY"], harnesses: ["pi"] },
  { name: "pdf_pages", nodes: false, calls: true, call_only: true, available: true, harnesses: ["pi"] },
  { name: "llm", nodes: false, calls: true, call_only: true, available: true, harnesses: ["pi"] },
];
// As the console builds them from GET /v2/capabilities (App.tsx).
const CAPS = { harnesses: [{ id: "pi", available: true }, { id: "claude-agent", available: true }, { id: "codex", available: true }], tools: toolOffers(TOOLS), thinking: [] };
const CALL_ONLY = ["pdf_pages", "llm"];

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

describe("demo: a new agent with its default tools", () => {
  it("is created: the POST names none of the workflow's call-only tools", async () => {
    const posts: { definition: { tools: string[] } }[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      const path = new URL(String(url), "http://serve.test").pathname;
      if (path === "/v2/agents" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        posts.push(body);
        return new Response(JSON.stringify({ agent_id: "a1", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: body.definition }), { status: 201, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: { code: "not_found", message: path, retryable: false } }), { status: 404, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    let went = "";
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentEditPage, { v2: createClient({ fetch }), caps: CAPS, agentId: null, go: (h: string) => { went = h; } })));
    const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
    };
    await type(host.querySelector('input[placeholder="e.g., Invoice checker"]')!, "Reader");
    await type(host.querySelector("textarea")!, "Read the page it is given.");
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Create")!.click(); });
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(posts).toHaveLength(1);
    expect(posts[0].definition.tools).toEqual(["read", "write", "edit", "ask_person", "fetch_page", "web_fetch"]);
    expect(went).toContain("a1");
  });
});

describe("the Tools step and call-only tools", () => {
  const agent = (tools: string[]): Agent => ({ agent_id: "calc", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Calc", instructions: "Answer.", harness: "pi", skills: [], tools } });
  it("offers no call-only tool, to a new agent or an existing one", () => {
    for (const a of [null, agent(["read"])]) {
      const html = renderToStaticMarkup(createElement(AgentEditor, { agent: a, caps: CAPS, step: "tools" }));
      for (const name of CALL_ONLY) expect(html, `${name}, ${a ? "existing" : "new"}`).not.toContain(`value="${name}"`);
      expect(html).toContain('value="web_fetch"');
    }
  });
  it("an existing agent that names one shows it as workflow-only, ticked so it can be unticked, never dropped silently", () => {
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: agent(["read", "pdf_pages"]), caps: CAPS, step: "tools" }));
    const box = html.match(/<label[^>]*>(?:(?!<\/label>).)*value="pdf_pages"(?:(?!<\/label>).)*<\/label>/)?.[0] ?? "";
    expect(box).toContain('checked=""');
    expect(box).toContain("Workflow-only");
    expect(html).not.toContain('value="llm"');
  });
});
