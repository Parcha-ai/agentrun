import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunBar } from "./RunBar";
import type { Agent } from "@/lib/agentForm";
import { ClientError } from "@/lib/client";

// A sandbox agent's run can be started on the server instead (the request narrows its place to the runner); a start
// the server refuses for a box it lacks says so in words, with that way out.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const agent = (place?: unknown): Agent => ({
  agent_id: "boxed", kind: "agentic", revision: "rv1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Boxed", instructions: "Probe.", harness: "pi", skills: [], tools: ["read"], ...(place ? { place } : {}) },
});

function mount(a: Agent, refuse?: ClientError) {
  const starts: Record<string, unknown>[] = [];
  const v2 = { startRun: async (_id: string, body: Record<string, unknown>) => { starts.push(body); if (refuse) throw refuse; return { run: { run_id: "r1" }, status: 202 }; } };
  const went: string[] = [];
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(RunBar, { agent: a, efforts: [], v2: v2 as never, go: (h: string) => went.push(h) })));
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  const write = (text: string) => act(() => { const t = host.querySelector("textarea")!; set.call(t, text); t.dispatchEvent(new Event("input", { bubbles: true })); });
  const run = () => act(async () => { [...host.querySelectorAll("button")].find((b) => /^Run$/.test((b.textContent ?? "").trim()))!.click(); });
  const toggle = () => host.querySelector('input[type="checkbox"][name="on-server"]') as HTMLInputElement | null;
  return { host, starts, went, write, run, toggle };
}

describe("RunBar, a run of a sandbox agent", () => {
  it("offers \"Run on the server instead\" only for an agent in a box; ticked, the start narrows its place", async () => {
    expect(mount(agent()).toggle()).toBeNull();
    act(() => root!.unmount()); document.body.innerHTML = "";
    const m = mount(agent({ mode: "sandbox", box: "docker" }));
    expect(m.toggle()).not.toBeNull();
    m.write("hi");
    await m.run();
    expect(m.starts.at(-1)).toEqual({ input: { content: "hi" } });
    act(() => m.toggle()!.click());
    await m.run();
    expect(m.starts.at(-1)).toEqual({ input: { content: "hi" }, place: "runner" });
  });

  it("a start refused for a box this server lacks says so in words, with the way to run it on the server", async () => {
    const refusal = Object.assign(new ClientError(409, "agent_not_runnable", "fixture: the docker box is not set up here"), { details: { box: "docker" } });
    const m = mount(agent({ mode: "sandbox", box: "docker" }), refusal);
    m.write("hi");
    await m.run();
    const alert = m.host.querySelector('[role="alert"]')!.textContent!;
    expect(alert).toContain("fixture: the docker box is not set up here");
    expect(alert).toContain("This server can't run the docker box this agent runs in. Tick \"Run on the server instead\" to run it without the box.");
  });
});
