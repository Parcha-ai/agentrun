import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
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
});
