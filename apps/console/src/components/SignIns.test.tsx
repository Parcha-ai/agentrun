import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SignIns } from "./SignIns";
import type { Agent } from "@/lib/agentForm";
import type { SignIn, SignInForgotten } from "@/lib/v2";
import { ClientError } from "@/lib/client";

// The agent page's saved sign-ins: GET /v2/agents/{id}'s `sign_ins` (serve's SignInView: key, provider, state, held_by,
// verified_at, never a pointer), one row per vendor. The server keeps one per agent per vendor, all under the key
// `default` (sign-ins.ts SIGN_IN_KEY), and forgets by KEY: DELETE /v2/agents/{id}/sign-ins/{key} removes every vendor's
// sign-in under it, and refuses (409 sign_in_held) while a run holds any of them. So Forget is one per key, and its
// confirm names every vendor it forgets.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

// The served shapes (the generated types, through v2's aliases).
type Removed = SignInForgotten;
const RUN = "01a1aa49-10ff-785c-9d1d-6f2fc8489901";
const agentWith = (signIns: SignIn[] | undefined, browser = "browserbase"): Agent => ({
  agent_id: "shopper", kind: "agentic", revision: "r1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Shopper", instructions: "Shop.", harness: "pi", skills: [], tools: ["browser"] },
  tools: [{ name: "browser", provider: "auto", provider_from: "default", default_provider: "auto", resolved: browser, permission: "allow", permission_from: "default", default_permission: "allow", permissions: ["allow", "ask", "deny"] }],
  ...(signIns ? { sign_ins: signIns } : {}),
} as Agent);
const bb: SignIn = { key: "default", provider: "browserbase", state: "ready", held_by: null, verified_at: "2026-11-05T08:00:00.000Z" };
const kernel: SignIn = { key: "default", provider: "kernel", state: "ready", held_by: null, verified_at: null };
const deletedAll = (list: SignIn[]) => async (_id: string, key: string): Promise<Removed> => ({ key, removed: list.filter((s) => s.key === key).map((s) => ({ provider: s.provider, at_vendor: "deleted" as const })) });

async function show(agent: Agent, forget: (id: string, key: string) => Promise<unknown> = deletedAll(agent.sign_ins ?? []), after: Agent | (() => Promise<never>) = agentWith([])) {
  const calls: string[] = [];
  const v2 = {
    forgetSignIn: async (id: string, key: string) => { calls.push(`delete ${id} ${key}`); return forget(id, key); },
    getAgent: async (id: string) => { calls.push(`get ${id}`); return typeof after === "function" ? after() : { agent: after, etag: '"r1"' }; },
  };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  // The page holds the agent: a fresh read replaces it, as AgentPage's setAgent does.
  const render = (a: Agent) => root!.render(createElement(SignIns, { agent: a, v2: v2 as never, onAgent: (next: Agent) => render(next) }));
  await act(async () => { render(agent); });
  const section = () => host.querySelector('section[aria-label="Sign-ins"]') as HTMLElement | null;
  const rows = () => [...host.querySelectorAll("[data-sign-in]")] as HTMLElement[];
  const forgets = () => [...host.querySelectorAll("button")].filter((b) => /^Forget/.test(b.getAttribute("aria-label") ?? "")) as HTMLButtonElement[];
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.getAttribute("aria-label") ?? b.textContent ?? "").trim()));
  const click = async (b: Element | undefined) => { expect(b).toBeTruthy(); await act(async () => { (b as HTMLElement).click(); }); for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  return { host, section, rows, forgets, button, click, calls };
}

describe("the agent page's sign-ins", () => {
  it("one row per vendor: its name, its state and when it was last verified, and nothing else of it", async () => {
    // A pointer the view never carries: were one sent, it is still never shown.
    const leaky = { ...bb, ref: "ctx_POINTER_abc123", profile: "profile-xyz", context_id: "cid-999" } as SignIn;
    const p = await show(agentWith([leaky, kernel]));
    expect(p.rows()).toHaveLength(2);
    expect(p.rows()[0].textContent).toContain("Browserbase");
    expect(p.rows()[0].textContent).toMatch(/last verified/i);
    expect(p.rows()[1].textContent).toContain("Kernel");
    expect(p.rows()[1].textContent).toContain("not verified yet");
    for (const leak of ["ctx_POINTER_abc123", "profile-xyz", "cid-999"]) expect(p.section()!.innerHTML).not.toContain(leak);
  });

  it("two vendors under one key have one Forget, whose confirm names both; it deletes once, and both rows go", async () => {
    const p = await show(agentWith([bb, kernel]));
    expect(p.forgets()).toHaveLength(1);
    await p.click(p.forgets()[0]);
    expect(p.calls).toEqual([]);
    expect(p.section()!.textContent).toContain("Forget the saved sign-ins for Browserbase and Kernel? The agent's next run with the browser starts signed out.");
    await p.click(p.button(/^Yes, forget/));
    expect(p.calls).toEqual(["delete shopper default", "get shopper"]);
    expect(p.rows()).toHaveLength(0);
  });

  it("one vendor's Forget sits on its row, and its confirm names it", async () => {
    const p = await show(agentWith([bb]));
    expect(p.forgets()).toHaveLength(1);
    expect(p.rows()[0].contains(p.forgets()[0])).toBe(true);
    await p.click(p.forgets()[0]);
    expect(p.section()!.textContent).toContain("Forget the Browserbase sign-in? The agent's next run with the browser starts signed out.");
  });

  it("a run holding any sign-in under the key disables its Forget; the held row links that run", async () => {
    const p = await show(agentWith([{ ...bb, state: "held", held_by: RUN }, kernel]));
    expect(p.forgets()).toHaveLength(1);
    expect(p.forgets()[0].disabled).toBe(true);
    expect(p.rows()[0].textContent).toMatch(/in use by run/i);
    expect(p.rows()[0].querySelector(`a[href="#/runs/${RUN}"]`)).toBeTruthy();
  });

  it("an unreadable one says runs start signed out until it's forgotten, and can be forgotten", async () => {
    const p = await show(agentWith([{ ...kernel, state: "unreadable" }]));
    expect(p.rows()[0].textContent).toMatch(/runs start signed out until it's forgotten/i);
    expect(p.forgets()[0].disabled).toBe(false);
  });

  it("names each vendor's result: a delete quietly, one it didn't confirm with its message", async () => {
    const p = await show(agentWith([bb, kernel]), async (_id, key) => ({ key, removed: [{ provider: "browserbase", at_vendor: "deleted" }, { provider: "kernel", at_vendor: "not_deleted", message: "Not deleted at kernel: 503. This server no longer points to it." }] }));
    await p.click(p.forgets()[0]);
    await p.click(p.button(/^Yes, forget/));
    const text = p.section()!.textContent ?? "";
    expect(text).toContain("Forgotten here, but Kernel didn't confirm the delete. Not deleted at kernel: 503. This server no longer points to it.");
    expect(text).not.toMatch(/Browserbase didn't confirm/);
  });

  it("a run that takes it meanwhile (409 sign_in_held) is said plainly, with a link to that run, and the row stays", async () => {
    const p = await show(agentWith([kernel]), async () => { throw Object.assign(new ClientError(409, "sign_in_held", "held", false), { details: { held_by: RUN } }); });
    await p.click(p.forgets()[0]);
    await p.click(p.button(/^Yes, forget/));
    expect(p.section()!.textContent).toContain("A run is using this sign-in; you can forget it when that run ends");
    expect(p.section()!.querySelector(`a[href="#/runs/${RUN}"]`)).toBeTruthy();
    expect(p.rows()).toHaveLength(1);
  });

  it("a vendor's not-deleted warning stays after its last sign-in is forgotten, even for an agent with no vendor browser now", async () => {
    const gone = "unavailable: no browser key";
    const notDeleted = async (_id: string, key: string): Promise<Removed> => ({ key, removed: [{ provider: "kernel", at_vendor: "not_deleted", message: "Kernel said 503." }] });
    const p = await show(agentWith([kernel], gone), notDeleted, agentWith([], gone));
    await p.click(p.forgets()[0]);
    await p.click(p.button(/^Yes, forget/));
    expect(p.section()?.textContent).toContain("Kernel didn't confirm the delete");
  });

  it("a forget that went through says so even when the agent can't be read again: the row goes, no \"Not forgotten\"", async () => {
    const p = await show(agentWith([bb]), deletedAll([bb]), async () => { throw new ClientError(500, "internal", "the read failed", true); });
    await p.click(p.forgets()[0]);
    await p.click(p.button(/^Yes, forget/));
    expect(p.section()?.textContent).not.toContain("Not forgotten");
    expect(p.rows()).toHaveLength(0);
    expect(p.section()?.textContent).toContain("Forgotten.");
  });

  it("is not there with none saved for an agent with no vendor browser", async () => {
    expect((await show(agentWith([], "unavailable: no browser key"))).section()).toBeNull();
  });

  it("an agent read with no sign_ins list is read as none saved (the server always serves it): a vendor browser's line", async () => {
    const p = await show(agentWith(undefined, "kernel"));
    expect(p.section()!.textContent).toContain("No saved sign-ins");
    expect(p.rows()).toHaveLength(0);
  });

  it("with none saved for an agent with a vendor browser, says so in a line", async () => {
    const p = await show(agentWith([], "kernel"));
    expect(p.section()!.textContent).toContain("No saved sign-ins");
    expect(p.rows()).toHaveLength(0);
  });
});
