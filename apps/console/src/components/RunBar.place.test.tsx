import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunBar } from "./RunBar";
import type { Agent } from "@/lib/agentForm";
import { ClientError } from "@/lib/client";
import { servedAgent } from "@/test/agent";

// A run runs where its agent's definition says: the start names no place, for an agent in a box too, and a start the
// server refuses for a box it lacks says so, and that the fix is where the agent runs, in its settings.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const agent = (place?: Agent["definition"]["place"]): Agent => servedAgent({
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
  it("offers no place for an agent in a box: no \"Run on the server instead\", and the start sends its input alone", async () => {
    const m = mount(agent({ mode: "sandbox", box: "docker" }));
    expect(m.toggle()).toBeNull();
    expect(m.host.textContent).not.toContain("Run on the server instead");
    m.write("hi");
    await m.run();
    expect(m.starts).toEqual([{ input: { content: "hi" } }]);
  });

  it("a start refused for a box this server lacks says so, and points to where the agent runs, in its settings", async () => {
    const refusal = Object.assign(new ClientError(409, "agent_not_runnable", "fixture: the docker box is not set up here"), { details: { box: "docker" } });
    const m = mount(agent({ mode: "sandbox", box: "docker" }), refusal);
    m.write("hi");
    await m.run();
    const alert = m.host.querySelector('[role="alert"]')!.textContent!;
    expect(alert).toContain("fixture: the docker box is not set up here");
    expect(alert).toContain("This server can't run the docker box this agent runs in: change where it runs in its settings.");
    expect(alert).not.toContain("Run on the server instead");
  });
});
