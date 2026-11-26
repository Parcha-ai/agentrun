import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolPicker } from "./ToolPicker";
import { toolOffers } from "@/lib/agentForm";
import type { McpServer } from "@/lib/mcp";

// The one Tools block the agent editor and Build's Tools step both draw: a filter over every card, the built-in tools, each
// saved MCP server's tools, and more groups an editor adds. These cases were the editor's filter tests, moved here.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tool = (name: string, description: string) => ({ name, description, input_schema: { type: "object" } });
const FAKE: McpServer = { name: "fake", url: "https://mcp.example.test/fake", auth: { type: "none" }, source: "url", toolkit: null, credential: null, tools: [tool("add", "Add two numbers."), tool("delete_thing", "Delete a thing by id.")] };
const OCTO: McpServer = { ...FAKE, name: "octo", tools: [tool("GITHUB_LIST_ISSUES", "List a repository's issues."), tool("GITHUB_CREATE_AN_ISSUE_COMMENT", "Comment on an issue.")] };
const offers = toolOffers([
  { name: "read", available: true, harnesses: ["pi"] },
  { name: "ask_person", available: true, harnesses: ["pi"] },
  { name: "run_step", available: true, harnesses: ["pi"], call_only: true },
]);

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

type Props = Partial<Parameters<typeof ToolPicker>[0]>;
/** The picker with its tools held in state, as a form holds them, so a tick shows. `changed` sees every change. */
function mount(props: Props & { start?: string[]; changed?: (tools: string[]) => void } = {}) {
  const { start = [], changed, ...rest } = props;
  function Held() {
    const [tools, setTools] = useState<string[]>(start);
    return createElement(ToolPicker, { offers, harness: "pi", place: undefined, places: null, mcp: true, servers: [FAKE, OCTO], mcpHarnesses: ["pi"], ...rest, runnerShell: rest.runnerShell ?? new Set(), tools, onChange: (next: string[]) => { changed?.(next); setTools(next); } });
  }
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(Held)));
}
const filter = () => host.querySelector('input[aria-label="Filter tools"]') as HTMLInputElement;
const type = (value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(filter(), value); filter().dispatchEvent(new Event("input", { bubbles: true })); });
const cards = () => [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"][value]')].map((b) => b.value);
const status = () => filter().closest("div")!.querySelector('[role="status"]')!.textContent;

describe("the tool picker's filter box", () => {
  it("hides the built-in and MCP cards its words miss, by tool or server name, says how many it keeps, and never unticks a card it hides", async () => {
    const changed = vi.fn();
    mount({ start: ["read", "mcp:fake/delete_thing"], changed });
    const all = ["ask_person", "read", "mcp:fake/add", "mcp:fake/delete_thing", "mcp:octo/GITHUB_LIST_ISSUES", "mcp:octo/GITHUB_CREATE_AN_ISSUE_COMMENT"];
    expect(cards()).toEqual(all);
    await type("issue");
    expect(cards()).toEqual(["mcp:octo/GITHUB_LIST_ISSUES", "mcp:octo/GITHUB_CREATE_AN_ISSUE_COMMENT"]);
    expect(host.querySelector('[aria-label="MCP server fake"]'), "a server with no tool kept is left out").toBeNull();
    expect(status()).toBe("2 of 6 shown");
    await type("octo comment");
    expect(cards(), "by server and tool words together").toEqual(["mcp:octo/GITHUB_CREATE_AN_ISSUE_COMMENT"]);
    await act(async () => { (host.querySelector('input[value="mcp:octo/GITHUB_CREATE_AN_ISSUE_COMMENT"]') as HTMLInputElement).click(); });
    await type("no-such-tool");
    expect(cards()).toEqual([]);
    expect(host.textContent).toContain("No tool matches “no-such-tool”.");
    // What the hidden cards held is what the tick kept: the tools the form holds are the two it began with and the one ticked.
    expect(changed).toHaveBeenLastCalledWith(["read", "mcp:fake/delete_thing", "mcp:octo/GITHUB_CREATE_AN_ISSUE_COMMENT"]);
    await type("");
    expect(cards()).toEqual(all);
    expect(status()).toBe("");
  });

  it("counts a grant it shows that no saved server answers for, or shown after the servers could not be read, as one it keeps", async () => {
    const cases: [McpServer[] | "failed", number][] = [[[FAKE], 5], ["failed", 4]];
    for (const [servers, total] of cases) {
      mount({ start: ["read", "mcp:gone/search", "mcp:fake/delete_thing"], servers });
      await type("gone");
      expect(cards().filter((v) => v.startsWith("mcp:")), String(servers)).toEqual(["mcp:gone/search"]);
      expect(status(), String(servers)).toBe(`1 of ${total} shown`);
      expect(host.textContent, String(servers)).not.toContain("No tool matches");
      act(() => root?.unmount()); root = undefined; document.body.innerHTML = "";
    }
  });

  it("filters and counts the extra groups an editor adds by the same words", async () => {
    const monid = (query: string) => ["monid:acme/search"].filter((g) => g.includes(query.trim()));
    mount({ start: ["monid:acme/search"], extra: { count: (q) => monid(q).length, render: (q) => createElement("li", { key: "monid", "data-extra": "" }, monid(q).join(",")) } });
    await type("acme");
    expect(host.querySelector("[data-extra]")!.textContent).toBe("monid:acme/search");
    expect(status()).toBe("1 of 7 shown");
    expect(host.textContent).not.toContain("No tool matches");
    await type("no-such-tool");
    expect(host.querySelector("[data-extra]")!.textContent).toBe("");
    expect(host.textContent).toContain("No tool matches");
  });
});

describe("the tool picker's cards", () => {
  it("offers a call-only tool to a workflow or to an agent that names it, never otherwise, and puts ask_person first", () => {
    mount();
    expect(cards()).not.toContain("run_step");
    expect(cards()[0]).toBe("ask_person");
    act(() => root?.unmount()); document.body.innerHTML = "";
    mount({ start: ["run_step"] });
    expect(cards()).toContain("run_step");
    act(() => root?.unmount()); document.body.innerHTML = "";
    mount({ workflow: true });
    expect(cards()).toContain("run_step");
    expect(host.querySelector('[aria-label="MCP server fake"]'), "a workflow's nodes bind no MCP tools").toBeNull();
  });

  it("shows no MCP group when MCP is off, and a failed read's retry reads again", async () => {
    mount({ mcp: false });
    expect(host.querySelector('[aria-label="MCP server fake"]')).toBeNull();
    act(() => root?.unmount()); document.body.innerHTML = "";
    const onRetry = vi.fn();
    mount({ servers: "failed", onRetry });
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Retry")!.click(); });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
