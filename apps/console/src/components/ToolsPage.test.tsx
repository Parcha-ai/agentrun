import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ToolsPage } from "./ToolsPage";
import { ClientError } from "@/lib/client";
import { type ToolChoice, toolChoices } from "@/lib/toolSettings";
import type { ToolSettings } from "@/lib/v2";

// Settings → Tools: this server's provider for each capability that has a choice, from the server's lists (the default
// first), a change saved at once, a pick unlike the default marked with a reset, and what each resolves to per harness.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

/** capabilities.tools' choices as the server lists them, under `settings` (its picks), each pick's resolution as given:
 *  web_search's providers end with `off`, which makes it unavailable, with the server's reason. */
const OFF = "web_search is turned off in settings";
const searchUnder = (pick = "auto") => pick === "off"
  ? { available: false, reason: OFF, resolves: { pi: `unavailable: ${OFF}`, "claude-agent": `unavailable: ${OFF}`, codex: `unavailable: ${OFF}` } }
  : { available: true, resolves: { pi: pick === "parallel" ? "unavailable: PARALLEL_API_KEY is not set" : "exa-keyless", "claude-agent": "native", codex: "native" } };
const choicesUnder = (settings: ToolSettings): ToolChoice[] => toolChoices([
  { name: "web_search", providers: ["auto", "native", "exa-keyless", "parallel", "off"], provider: settings.web_search?.provider ?? "auto", default_provider: "auto", ...searchUnder(settings.web_search?.provider) },
  { name: "web_fetch", providers: ["kernel", "parallel"], provider: settings.web_fetch?.provider ?? "kernel", default_provider: "kernel", resolves: { pi: "kernel", "claude-agent": "native", codex: "native" } },
]);

async function open(start: ToolSettings = {}, refuse?: () => ClientError) {
  // The server: its settings, each capability's provider in its answer (its default filled in).
  let held: ToolSettings = { ...start };
  const whole = (): ToolSettings => ({ web_search: { provider: held.web_search?.provider ?? "auto" }, web_fetch: { provider: held.web_fetch?.provider ?? "kernel" } });
  const puts: ToolSettings[] = [];
  let reads = 0;
  const v2 = {
    toolSettings: async () => whole(),
    saveToolSettings: async (body: ToolSettings) => { puts.push(body); if (refuse) throw refuse(); held = { ...body }; return whole(); },
  };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const render = () => act(() => root!.render(createElement(ToolsPage, { v2: v2 as never, choices: choicesUnder(held), onSaved: () => { reads++; render(); } })));
  render();
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const row = (tool: string) => host.querySelector<HTMLTableRowElement>(`tr[data-tool="${tool}"]`)!;
  const select = (tool: string) => row(tool).querySelector("select")!;
  const choose = async (tool: string, provider: string) => {
    await act(async () => { const s = select(tool); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(s, provider); s.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
  };
  const reset = async (tool: string) => { await act(async () => { row(tool).querySelector<HTMLButtonElement>("button")!.click(); }); await settle(); };
  return { host, puts, reads: () => reads, row, select, choose, reset };
}

describe("Settings → Tools", () => {
  it("lists each capability with a choice, its providers in the server's order, the default first and named so, the server's pick chosen", async () => {
    const page = await open({ web_search: { provider: "exa-keyless" } });
    expect([...page.host.querySelectorAll("tr[data-tool]")].map((r) => r.getAttribute("data-tool"))).toEqual(["web_search", "web_fetch"]);
    expect([...page.select("web_search").options].map((o) => o.textContent)).toEqual(["auto (default)", "native", "Exa keyless", "Parallel", "off"]);
    expect([...page.select("web_fetch").options].map((o) => o.textContent)).toEqual(["kernel fetch (default)", "Parallel"]);
    expect(page.select("web_search").value).toBe("exa-keyless");
    expect(page.select("web_fetch").value).toBe("kernel");
    // What each resolves to, per harness.
    expect(page.row("web_search").textContent).toContain("pi: Exa keyless");
    expect(page.row("web_search").textContent).toContain("claude-agent: native");
  });

  it("marks a pick unlike the default, with the default named and a reset; a default pick has neither", async () => {
    const page = await open({ web_search: { provider: "exa-keyless" } });
    expect(page.row("web_search").hasAttribute("data-set")).toBe(true);
    expect(page.row("web_search").textContent).toContain("default: auto");
    expect(page.row("web_search").querySelector("button")?.getAttribute("aria-label")).toBe("Reset web_search to its default");
    expect(page.row("web_fetch").hasAttribute("data-set")).toBe(false);
    expect(page.row("web_fetch").querySelector("button")).toBeNull();
  });

  it("saves a change at once: a PUT of the server's settings with the pick, then the capabilities read again", async () => {
    const page = await open({ web_search: { provider: "exa-keyless" } });
    await page.choose("web_fetch", "parallel");
    expect(page.puts).toEqual([{ web_search: { provider: "exa-keyless" }, web_fetch: { provider: "parallel" } }]);
    expect(page.reads()).toBe(1);
    expect(page.select("web_fetch").value).toBe("parallel");
    expect(page.row("web_fetch").hasAttribute("data-set")).toBe(true);
    // The capabilities read again say what the new pick resolves to.
    await page.choose("web_search", "parallel");
    expect(page.row("web_search").textContent).toContain("pi: unavailable: PARALLEL_API_KEY is not set");
  });

  it("off is one of the server's providers like any other: choosing it PUTs it, and the capabilities read again say web_search is unavailable, and why", async () => {
    const page = await open();
    await page.choose("web_search", "off");
    expect(page.puts).toEqual([{ web_search: { provider: "off" } }]);
    expect(page.select("web_search").value).toBe("off");
    expect(page.row("web_search").hasAttribute("data-set")).toBe(true);
    expect(page.row("web_search").textContent).toContain(`pi: unavailable: ${OFF}`);
  });

  it("Reset puts a row back to its default: a PUT that leaves it out, and the mark goes", async () => {
    const page = await open({ web_search: { provider: "exa-keyless" }, web_fetch: { provider: "parallel" } });
    await page.reset("web_search");
    expect(page.puts).toEqual([{ web_fetch: { provider: "parallel" } }]);
    expect(page.select("web_search").value).toBe("auto");
    expect(page.row("web_search").hasAttribute("data-set")).toBe(false);
  });

  it("a refused change says why on its row, and the pick shown stays the server's", async () => {
    const page = await open({}, () => Object.assign(new ClientError(422, "input_invalid", "invalid tool settings"), { fields: [{ field: "web_search.provider", reason: "not_offered", message: "not offered here" }] }));
    await page.choose("web_search", "native");
    expect(page.row("web_search").nextElementSibling?.textContent).toBe("not offered here");
    expect(page.select("web_search").value).toBe("auto");
  });
});
