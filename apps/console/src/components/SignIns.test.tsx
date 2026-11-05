import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SignIns } from "./SignIns";
import type { Agent } from "@/lib/agentForm";
import { ClientError } from "@/lib/client";

// The agent page's saved sign-ins: GET /v2/agents/{id}'s `sign_ins` (serve's SignInView: key, provider, state, held_by,
// verified_at, never a pointer), each with Forget (DELETE /v2/agents/{id}/sign-ins/{key}) after a confirm.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

type SignIn = { key: string; provider: string; state: "ready" | "held" | "unreadable"; held_by: string | null; verified_at: string | null };
const RUN = "01a1aa49-10ff-785c-9d1d-6f2fc8489901";
const agentWith = (signIns: SignIn[] | undefined, browser = "browserbase"): Agent => ({
  agent_id: "shopper", kind: "agentic", revision: "r1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Shopper", instructions: "Shop.", harness: "pi", skills: [], tools: ["browser"] },
  tools: [{ name: "browser", provider: "auto", provider_from: "default", default_provider: "auto", resolved: browser }],
  ...(signIns ? { sign_ins: signIns } : {}),
} as Agent);
const ready: SignIn = { key: "default", provider: "browserbase", state: "ready", held_by: null, verified_at: "2026-11-05T08:00:00.000Z" };

async function show(agent: Agent, forget: (id: string, key: string) => Promise<unknown> = async (_id, key) => ({ key, removed: [{ provider: "browserbase", at_vendor: "deleted" }] }), after: Agent = agentWith([])) {
  const calls: string[] = [];
  const agents: Agent[] = [];
  const v2 = {
    forgetSignIn: async (id: string, key: string) => { calls.push(`delete ${id} ${key}`); return forget(id, key); },
    getAgent: async (id: string) => { calls.push(`get ${id}`); return { agent: after, etag: '"r1"' }; },
  };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => { root!.render(createElement(SignIns, { agent, v2: v2 as never, onAgent: (a: Agent) => agents.push(a) })); });
  const section = () => host.querySelector('section[aria-label="Sign-ins"]') as HTMLElement | null;
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.getAttribute("aria-label") ?? b.textContent ?? "").trim()));
  const click = async (label: RegExp) => { const b = button(label); expect(b, String(label)).toBeTruthy(); await act(async () => { b!.click(); }); for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  return { host, section, button, click, calls, agents };
}

describe("the agent page's sign-ins", () => {
  it("lists each by its vendor, its state and when it was last verified, and nothing else of it", async () => {
    // A pointer the view never carries: were one sent, it is still never shown.
    const leaky = { ...ready, ref: "ctx_POINTER_abc123", profile: "profile-xyz", context_id: "cid-999" } as SignIn;
    const p = await show(agentWith([leaky, { key: "work", provider: "kernel", state: "ready", held_by: null, verified_at: null }]));
    const s = p.section()!;
    expect(s).toBeTruthy();
    const rows = [...s.querySelectorAll("li")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Browserbase");
    expect(rows[0].textContent).toMatch(/last verified/i);
    expect(rows[1].textContent).toContain("Kernel");
    expect(rows[1].textContent).toContain("not verified yet");
    for (const leak of ["ctx_POINTER_abc123", "profile-xyz", "cid-999"]) expect(s.innerHTML).not.toContain(leak);
  });

  it("one a run holds says so with a link to that run, and can't be forgotten until it ends", async () => {
    const p = await show(agentWith([{ ...ready, state: "held", held_by: RUN }]));
    const row = p.section()!.querySelector("li")!;
    expect(row.textContent).toMatch(/in use by/i);
    expect(row.querySelector(`a[href="#/runs/${RUN}"]`)).toBeTruthy();
    expect(p.button(/^Forget/)?.disabled).toBe(true);
  });

  it("an unreadable one says runs start signed out until it's forgotten, and offers Forget", async () => {
    const p = await show(agentWith([{ ...ready, state: "unreadable" }]));
    expect(p.section()!.textContent).toMatch(/runs start signed out until it's forgotten/i);
    expect(p.button(/^Forget/)?.disabled).toBe(false);
  });

  it("Forget asks first, then deletes it and reads the agent again", async () => {
    const p = await show(agentWith([ready]));
    await p.click(/^Forget/);
    expect(p.calls).toEqual([]);
    expect(p.section()!.textContent).toContain("The agent's next run with the browser starts signed out");
    await p.click(/^Yes, forget/);
    expect(p.calls).toEqual(["delete shopper default", "get shopper"]);
    expect(p.agents).toHaveLength(1);
  });

  it("a run that holds it (409 sign_in_held) is said plainly, with a link to that run", async () => {
    const p = await show(agentWith([ready]), async () => { throw Object.assign(new ClientError(409, "sign_in_held", "held", false), { details: { held_by: RUN } }); });
    await p.click(/^Forget/);
    await p.click(/^Yes, forget/);
    const s = p.section()!;
    expect(s.textContent).toContain("A run is using this sign-in; you can forget it when that run ends");
    expect(s.querySelector(`a[href="#/runs/${RUN}"]`)).toBeTruthy();
  });

  it("a vendor that didn't confirm the delete is said, with its message: forgotten here all the same", async () => {
    const p = await show(agentWith([ready]), async (_id, key) => ({ key, removed: [{ provider: "browserbase", at_vendor: "not_deleted", message: "Not deleted at browserbase: 503. This server no longer points to it." }] }));
    await p.click(/^Forget/);
    await p.click(/^Yes, forget/);
    expect(p.section()!.textContent).toContain("Forgotten here, but Browserbase didn't confirm the delete");
    expect(p.section()!.textContent).toContain("Not deleted at browserbase: 503. This server no longer points to it.");
  });

  it("is not there on a server that serves no sign_ins, nor with none saved for an agent with no vendor browser", async () => {
    expect((await show(agentWith(undefined))).section()).toBeNull();
    act(() => root?.unmount()); document.body.innerHTML = "";
    expect((await show(agentWith([], "unavailable: no browser key"))).section()).toBeNull();
  });

  it("with none saved for an agent with a vendor browser, says so in a line", async () => {
    const p = await show(agentWith([], "kernel"));
    expect(p.section()!.textContent).toContain("No saved sign-ins");
    expect(p.section()!.querySelector("li")).toBeNull();
  });
});
