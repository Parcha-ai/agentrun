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
  ? { available: false, reason: OFF, resolves: { pi: `unavailable: ${OFF}`, "claude-agent": `unavailable: ${OFF}`, codex: `unavailable: ${OFF}`, opencode: `unavailable: ${OFF}` } }
  : { available: true, resolves: { pi: pick === "parallel" ? "unavailable: PARALLEL_API_KEY is not set" : "exa-keyless", "claude-agent": "native", codex: "native", opencode: pick === "parallel" ? "unavailable: PARALLEL_API_KEY is not set" : "exa-keyless" } };
const choicesUnder = (settings: ToolSettings): ToolChoice[] => toolChoices([
  { name: "web_search", providers: ["auto", "native", "exa-keyless", "parallel", "off"], provider: settings.web_search?.provider ?? "auto", default_provider: "auto", ...searchUnder(settings.web_search?.provider) },
  { name: "web_fetch", providers: ["kernel", "parallel"], provider: settings.web_fetch?.provider ?? "kernel", default_provider: "kernel", resolves: { pi: "kernel", "claude-agent": "native", codex: "native", opencode: "kernel" } },
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
    expect(page.row("web_search").textContent).toContain("opencode: Exa keyless");
    expect(page.row("web_fetch").textContent).toContain("opencode: kernel fetch");
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

// A provider changed in another tab: the settings, read when the page opens, name it, while the capabilities still say
// what the old one resolved to. The row shows no resolution until capabilities read with that provider, and the page
// asks for that read as it opens.
describe("Settings → Tools, capabilities older than the settings", () => {
  it("shows 'reading…' beside a provider the capabilities were not read for, and asks for a fresh read on open", async () => {
    // The server's settings say off (changed in another tab); the capabilities, read earlier, say exa-keyless works.
    const stale = toolChoices([{ name: "web_search", providers: ["auto", "native", "exa-keyless", "parallel", "off"], provider: "exa-keyless", default_provider: "auto", available: true, resolves: { pi: "exa-keyless", "claude-agent": "native", codex: "native" } }]);
    const v2 = { toolSettings: async () => ({ web_search: { provider: "off" } }), saveToolSettings: async (b: ToolSettings) => b };
    let opened = 0;
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    // The fresh read is still under way.
    act(() => root!.render(createElement(ToolsPage, { v2: v2 as never, choices: stale, onSaved: () => {}, onOpen: () => { opened++; return new Promise<boolean>(() => {}); } } as never)));
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const row = host.querySelector('tr[data-tool="web_search"]')!;
    expect((row.querySelector("select") as HTMLSelectElement).value).toBe("off");
    expect(row.textContent).not.toContain("pi: Exa keyless");
    expect(row.textContent).toContain("reading…");
    expect(opened).toBe(1);
  });
});

describe("Settings → Tools, a capabilities read that fails", () => {
  it("never looks busy for ever: a failed read says so with a retry, which reads again", async () => {
    const stale = toolChoices([{ name: "web_search", providers: ["auto", "exa-keyless", "off"], provider: "exa-keyless", default_provider: "auto", available: true, resolves: { pi: "exa-keyless", "claude-agent": "native", codex: "native" } }]);
    const v2 = { toolSettings: async () => ({ web_search: { provider: "off" } }), saveToolSettings: async (b: ToolSettings) => b };
    let reads = 0;
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(ToolsPage, { v2: v2 as never, choices: stale, onSaved: () => {}, onOpen: async () => { reads++; return false; } } as never)));
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const row = () => host.querySelector('tr[data-tool="web_search"]')!;
    expect(row().textContent).not.toContain("reading…");
    expect(row().textContent).toContain("couldn't be read");
    await act(async () => { [...row().querySelectorAll("button")].find((b) => /Retry/.test(b.textContent ?? ""))!.click(); });
    expect(reads).toBe(2);
  });
});

describe("Settings → Tools, reads that land but still disagree", () => {
  it("offers Retry, which reads the settings and the capabilities again, once a finished read still leaves a mismatch", async () => {
    const stale = toolChoices([{ name: "web_search", providers: ["auto", "exa-keyless", "off"], provider: "exa-keyless", default_provider: "auto", available: true, resolves: { pi: "exa-keyless", "claude-agent": "native", codex: "native" } }]);
    let settingsReads = 0, capsReads = 0;
    const v2 = { toolSettings: async () => { settingsReads++; return { web_search: { provider: "off" } }; }, saveToolSettings: async (b: ToolSettings) => b };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    // Both reads land, but the capabilities still name the old provider (another tab changed it between the two reads).
    act(() => root!.render(createElement(ToolsPage, { v2: v2 as never, choices: stale, onSaved: () => {}, onOpen: async () => { capsReads++; return true; } } as never)));
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const row = () => host.querySelector('tr[data-tool="web_search"]')!;
    expect(row().textContent).not.toContain("reading…");
    expect(row().textContent).not.toContain("pi: Exa keyless");
    await act(async () => { [...row().querySelectorAll("button")].find((b) => /Retry/.test(b.textContent ?? ""))!.click(); });
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect([settingsReads, capsReads]).toEqual([2, 2]);
  });
});

describe("Settings → Tools, a Retry's read and a save", () => {
  it("a settings read that was under way when a save landed never puts the older settings back", async () => {
    const stale = toolChoices([{ name: "web_search", providers: ["auto", "exa-keyless", "parallel", "off"], provider: "exa-keyless", default_provider: "auto", available: true, resolves: { pi: "exa-keyless", "claude-agent": "native", codex: "native" } }]);
    let release!: () => void;
    let reads = 0;
    const v2 = {
      // The first read answers at once; the Retry's read is held, and answers with what was saved before the change.
      toolSettings: async () => { if (++reads === 2) await new Promise<void>((r) => { release = r; }); return { web_search: { provider: "off" } }; },
      saveToolSettings: async (b: ToolSettings) => b,
    };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(ToolsPage, { v2: v2 as never, choices: stale, onSaved: () => {}, onOpen: async () => true } as never)));
    const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
    await settle();
    const row = () => host.querySelector('tr[data-tool="web_search"]')!;
    await act(async () => { [...row().querySelectorAll("button")].find((b) => /Retry/.test(b.textContent ?? ""))!.click(); });
    // While that read is out, the person picks Parallel; the save lands.
    await act(async () => { const s = row().querySelector("select")!; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(s, "parallel"); s.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(row().querySelector("select")!.value).toBe("parallel");
    // The older read answers last.
    await act(async () => { release(); });
    await settle();
    expect(row().querySelector("select")!.value).toBe("parallel");
  });
});

describe("Settings → Tools, a settings read that fails once the page shows them", () => {
  const stale = () => toolChoices([{ name: "web_search", providers: ["auto", "exa-keyless", "parallel", "off"], provider: "exa-keyless", default_provider: "auto", available: true, resolves: { pi: "exa-keyless", "claude-agent": "native", codex: "native" } }]);
  async function shown() {
    let reads = 0;
    const puts: ToolSettings[] = [];
    const state = { fail: false };
    const v2 = {
      toolSettings: async () => { reads++; if (state.fail) throw new Error("connection reset"); return { web_search: { provider: "off" } }; },
      saveToolSettings: async (b: ToolSettings) => { puts.push(b); return b; },
    };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    // The settings land, but the capabilities still name the old provider: the row offers Retry.
    act(() => root!.render(createElement(ToolsPage, { v2: v2 as never, choices: stale(), onSaved: () => {}, onOpen: async () => true } as never)));
    const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
    await settle();
    const row = () => host.querySelector('tr[data-tool="web_search"]')!;
    const alert = () => [...host.querySelectorAll('[role="alert"]')].find((a) => /could not be read/.test(a.textContent ?? ""));
    const click = async (within: Element, label: RegExp) => { await act(async () => { [...within.querySelectorAll("button")].find((b) => label.test(b.textContent ?? ""))!.click(); }); await settle(); };
    // The row's Retry, with the settings read failing.
    state.fail = true;
    await click(row(), /Retry/);
    return { host, row, alert, click, settle, state, puts, reads: () => reads };
  }
  it("says so beside the table it keeps, with Try again, which reads again; once a read lands, the words go", async () => {
    const page = await shown();
    expect(page.reads()).toBe(2);
    expect(page.alert()?.textContent).toContain("The tool settings could not be read again: network: connection reset");
    expect(page.row().querySelector("select")!.value).toBe("off");
    page.state.fail = false;
    await page.click(page.alert()!, /Try again/);
    expect(page.reads()).toBe(3);
    expect(page.alert()).toBeUndefined();
  });
  it("a save while the settings can't be read saves nothing and says so, keeping the change; Try again saves it once a read lands, and the words go", async () => {
    const page = await shown();
    expect(page.alert()).toBeDefined();
    await act(async () => { const s = page.row().querySelector("select")!; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(s, "parallel"); s.dispatchEvent(new Event("change", { bubbles: true })); });
    await page.settle();
    // A save is a read-modify-write of the whole map: with no map read now, an older one would drop a key set meanwhile.
    expect(page.puts).toEqual([]);
    const refused = [...page.host.querySelectorAll('[role="alert"]')].find((a) => /nothing was saved/.test(a.textContent ?? ""));
    expect(refused?.textContent).toContain("Couldn't read the current settings, so nothing was saved. Try again.");
    expect(page.row().querySelector("select")!.value).toBe("parallel");
    page.state.fail = false;
    await page.click(refused!, /^Try again$/);
    expect(page.puts).toEqual([{ web_search: { provider: "parallel" } }]);
    expect(page.row().querySelector("select")!.value).toBe("parallel");
    expect(page.alert()).toBeUndefined();
    expect([...page.host.querySelectorAll('[role="alert"]')].some((a) => /nothing was saved/.test(a.textContent ?? ""))).toBe(false);
  });
});
