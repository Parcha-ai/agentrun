import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentPage } from "./AgentPage";
import { FilePicker, useAttachments } from "./FilePicker";
import { RunBar } from "./RunBar";
import { RunDetail } from "./RunDetail";
import { RunHeader } from "./RunHeader";
import { agentFixture, runFixture } from "@/fixtures";
import type { Agent } from "@/lib/agentForm";

// On a phone (< 640 px, Tailwind's max-sm), the chrome above an agent's or a run's content is cut down: the agent page's
// header, run box and tabs took ~70% of a 390x844 screen, the run page's ~42%. Each change is a max-sm variant, so 640 px
// and up keep their classes. jsdom applies no media query: these pin the variants and the structure (what stays named,
// what stays reachable); the walk measures the real boxes at 390x844 and 1280x900.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });
const classes = (el: Element | null | undefined) => (el?.getAttribute("class") ?? "").split(/\s+/);
const mount = (el: React.ReactElement) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
};
const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); expect(ok()).toBe(true); };
/** Every class that is not a max-sm variant: what 640 px and up render. */
const wide = (el: Element | null | undefined) => classes(el).filter((c) => c && !c.startsWith("max-sm:"));

async function agentPage(agent: Agent = agentFixture("invoice-checker")) {
  const v2 = { getAgent: async () => ({ agent }), statsOver: async () => { throw new Error("no stats"); }, listAgentRuns: async () => ({ runs: [], next_cursor: null }) };
  const host = mount(createElement(AgentPage, { v2: v2 as never, agentId: agent.agent_id, efforts: ["low", "high"], go: () => {} }));
  await until(() => !!host.querySelector("h1"));
  return host;
}

describe("the agent page's header on a phone", () => {
  it("the back button sits in the name row, its word read but not shown; Edit keeps its name with its word hidden", async () => {
    const host = await agentPage();
    const header = host.querySelector("header")!;
    const back = [...header.querySelectorAll("button")].find((b) => b.textContent?.includes("Agents"))!;
    expect(back).toBeDefined();
    expect(back.closest("[data-phone-row]")).not.toBeNull();
    expect(back.closest("[data-phone-row]")!.querySelector("h1")).not.toBeNull();
    expect(classes(back.closest("[data-phone-row]"))).toEqual(expect.arrayContaining(["max-sm:flex-row", "max-sm:items-center"]));
    expect(classes([...back.querySelectorAll("span")].find((s) => s.textContent === "Agents"))).toContain("max-sm:sr-only");
    const edit = [...header.querySelectorAll("button")].find((b) => b.textContent?.includes("Edit"))!;
    expect(classes([...edit.querySelectorAll("span")].find((s) => s.textContent === "Edit"))).toContain("max-sm:sr-only");
    expect(classes(header)).toContain("max-sm:py-3");
  });

  it("the revision's facts fold into one line that opens them; 640 px and up show the list as before", async () => {
    const host = await agentPage();
    const list = host.querySelector('dl[aria-label="Current revision"]')!;
    const toggle = host.querySelector('button[aria-controls="agent-facts"]')!;
    expect(toggle).not.toBeNull();
    expect(classes(toggle)).toContain("sm:hidden");
    expect(list.id).toBe("agent-facts");
    // Folded: hidden below 640 only; every fact is still in the list, and the line names the first ones.
    expect(classes(list)).toContain("max-sm:hidden");
    expect(wide(list)).not.toContain("hidden");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const facts = [...list.querySelectorAll("dd")].map((d) => d.textContent);
    expect(facts.length).toBeGreaterThan(1);
    expect(toggle.textContent).toContain(facts[0]!);
    act(() => (toggle as HTMLButtonElement).click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(classes(list)).not.toContain("max-sm:hidden");
  });

  it("the tabs keep one row: no wrap, less padding below 640", async () => {
    const host = await agentPage();
    const tab = host.querySelector('[role="tab"]')!;
    expect(classes(tab)).toEqual(expect.arrayContaining(["whitespace-nowrap", "max-sm:px-2.5", "max-sm:py-2"]));
    expect(classes(tab.parentElement)).not.toContain("flex-wrap");
  });
});

describe("the run box on a phone", () => {
  const agent: Agent = agentFixture("invoice-checker");
  function bar() {
    return mount(createElement(RunBar, { agent, efforts: ["low", "high"], v2: { startRun: async () => ({ run: { run_id: "r" }, status: 202 }) } as never, go: () => {} }));
  }
  it("the message box is one line high, the effort's second line is hidden, and Attach joins Effort and Run in one row", () => {
    const host = bar();
    expect(classes(host.querySelector("textarea"))).toContain("max-sm:h-10");
    expect(classes([...host.querySelectorAll("span")].find((s) => s.textContent === "How hard the model thinks"))).toContain("max-sm:hidden");
    const section = host.querySelector('section[aria-label="Start a run"]')!;
    const row = section.querySelector("[data-phone-row]")!;
    expect(classes(row)).toEqual(expect.arrayContaining(["max-sm:flex", "max-sm:flex-wrap", "max-sm:items-center"]));
    // The textarea and the controls come out of their own box below 640, so the file button can sit beside Run.
    expect(classes(row.firstElementChild)).toContain("max-sm:contents");
    expect(classes(host.querySelector("textarea"))).toEqual(expect.arrayContaining(["max-sm:basis-full", "max-sm:order-first"]));
    const files = section.querySelector('[role="group"][aria-label="Files for the run"]')!;
    expect(row.contains(files)).toBe(true);
    expect(classes(files)).toEqual(expect.arrayContaining(["max-sm:border-0", "max-sm:p-0"]));
    // The picker still picks: its button (named Attach files) and its input.
    const attach = [...files.querySelectorAll("button")].find((b) => b.textContent?.includes("Attach files"))!;
    expect(attach).toBeDefined();
    expect(files.querySelector('input[type="file"][aria-label="Pick files"]')).not.toBeNull();
    expect(classes([...files.querySelectorAll("span")].find((s) => s.textContent?.startsWith("or drop them here")))).toContain("max-sm:hidden");
  });

  it("a workflow's JSON input keeps its height", () => {
    const wf = agentFixture("lead-scorer");
    const host = mount(createElement(RunBar, { agent: wf, efforts: [], v2: {} as never, go: () => {} }));
    expect(classes(host.querySelector("textarea"))).not.toContain("max-sm:h-10");
  });

  it("the Playground's picker is the full drop box at every width", () => {
    function Picker() { const attachments = useAttachments({ upload: (async () => { throw new Error("no"); }) as never, remove: async () => {} }); return createElement(FilePicker, { attachments }); }
    const host = mount(createElement(Picker));
    const files = host.querySelector('[role="group"][aria-label="Files for the run"]')!;
    expect(classes(files).some((c) => c.startsWith("max-sm:"))).toBe(false);
  });
});

describe("the run page's header on a phone", () => {
  const { run } = runFixture("run.completed.idle.1");
  it("tighter, a two-line title, and the actions in the facts' row", () => {
    const host = mount(createElement(RunHeader, { run, agentName: "Invoice checker", actions: { onArchive: () => {} } }));
    const header = host.querySelector("header")!;
    expect(classes(header)).toContain("max-sm:py-3");
    expect(classes(header.querySelector("h1"))).toEqual(expect.arrayContaining(["max-sm:text-lg", "max-sm:line-clamp-2"]));
    expect(wide(header.querySelector("h1"))).toContain("text-2xl");
    // The title's column and the facts' box step aside below 640: the facts and the actions share one wrapping row.
    const row = header.querySelector("[data-phone-row]")!;
    expect(classes(row)).toEqual(expect.arrayContaining(["max-sm:flex-row", "max-sm:flex-wrap", "max-sm:items-center"]));
    expect(wide(row)).toEqual(expect.arrayContaining(["flex-col", "sm:flex-row"]));
    const archive = [...header.querySelectorAll("button")].find((b) => b.textContent?.includes("Archive"))!;
    expect(row.contains(archive)).toBe(true);
    const column = header.querySelector("h1")!.parentElement!;
    expect(classes(column)).toContain("max-sm:contents");
    expect(classes(header.querySelector("h1"))).toContain("max-sm:basis-full");
  });

  it("the run page's tabs keep one row", () => {
    const fx = runFixture("run.completed.idle.1");
    const host = mount(createElement(RunDetail, { run: fx.run, agentName: "Invoice checker", messages: { modes: [] } as never, harnessSteers: false, rows: fx.page.rows, files: [] }));
    const tab = host.querySelector('[role="tab"]')!;
    expect(classes(tab)).toEqual(expect.arrayContaining(["whitespace-nowrap", "max-sm:px-2.5", "max-sm:py-2"]));
  });
});
