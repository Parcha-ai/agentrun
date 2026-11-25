import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeLoginRow } from "./ClaudeLoginRow";
import { canSignOut, LOGIN_ROW, SIGN_OUT_ASK, SIGNED_OUT_HERE } from "@/lib/claudeLogin";
import { createClient } from "@/lib/client";
import type { ClaudeLoginSignOut, ClaudeLoginView } from "@/lib/v2";

// The Claude login row's Sign out: offered while AgentRun's own login is signed in, never on this machine's own login
// (the person's, which the server refuses to sign out). It asks first, calls POST /v2/settings/claude-login/sign-out,
// and the row then reads off and says it signed out; Turn on after it finds no login and offers the CLI's sign-in. Where
// the CLI didn't confirm its own sign-out, the server's words show.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMMAND = "CLAUDE_CONFIG_DIR=/data/claude-login CLAUDE_SECURESTORAGE_CONFIG_DIR=/data/claude-login ANTHROPIC_CONFIG_DIR=/data/claude-login/anthropic claude auth login";
const OFF: ClaudeLoginView = { state: "off", place: "agentrun", command: COMMAND, can_start: true, folder: "/data/claude-login", machine: { folder: "/u/p/.claude", source: "default" } };
const SIGNED_IN: ClaudeLoginView = { ...OFF, state: "signed_in", account: { method: "claude.ai", email: "person@example.com", plan: "max" } };
const UNCONFIRMED = "Signed out here: AgentRun's copy of the login is removed. Claude Code's own sign-out didn't confirm.";

type Call = { method: string; path: string; body?: unknown };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function server(read: () => ClaudeLoginView, write: (call: Call) => ClaudeLoginView | ClaudeLoginSignOut | Response) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", path: String(url), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
    calls.push(call);
    const answer = call.method === "GET" ? read() : write(call);
    return answer instanceof Response ? answer : json(200, answer);
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls };
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

async function open(v2: ReturnType<typeof createClient>, onChange?: () => void) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement("ul", null, createElement(ClaudeLoginRow, { v2, writable: true, onChange }))));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const buttons = (label: RegExp) => [...host.querySelectorAll("button")].filter((b) => label.test((b.textContent ?? "").trim()));
  const click = async (button: HTMLButtonElement | undefined) => { await act(async () => { button!.click(); }); await settle(); };
  const row = () => host.querySelector<HTMLElement>(`[aria-label="${LOGIN_ROW}"]`);
  return { host, buttons, click, row };
}

describe("Settings → Model keys, Claude Code's login on this machine: Sign out", () => {
  it("is offered only while AgentRun's own login is signed in: never on this machine's own login, never signed out, off or refused", () => {
    expect(canSignOut(SIGNED_IN)).toBe(true);
    expect(canSignOut({ ...SIGNED_IN, place: "machine" })).toBe(false);
    for (const state of ["off", "signed_out", "no_cli", "unknown", "refused", "other_machine"] as const) expect(canSignOut({ ...SIGNED_IN, state }), state).toBe(false);
  });

  it("on this machine's own login, signed in: no Sign out, Turn off alone", async () => {
    const { v2 } = server(() => ({ ...SIGNED_IN, place: "machine" }), () => OFF);
    const page = await open(v2);
    expect(page.row()!.textContent).toContain("Signed in as person@example.com (Max)");
    expect(page.buttons(/^Turn off$/)).toHaveLength(1);
    expect(page.buttons(/^Sign out$/)).toHaveLength(0);
  });

  it("asks first, calls the sign-out, and the row then reads off and says it signed out; Turn on after it finds no login and offers the CLI's sign-in", async () => {
    let view: ClaudeLoginView = SIGNED_IN;
    const changed: number[] = [];
    const { v2, calls } = server(() => view, (call) => {
      if (call.path === "/v2/settings/claude-login/sign-out") return { confirmed: true, login: (view = OFF) };
      return (view = { ...OFF, state: "signed_out" });
    });
    const page = await open(v2, () => changed.push(1));
    const [signOut] = page.buttons(/^Sign out$/);
    expect(signOut, "Sign out is offered while AgentRun's own login is signed in").toBeDefined();
    await page.click(signOut);
    // Asked first: nothing is sent until the person says so, and Keep leaves it as it was.
    expect(page.row()!.textContent).toContain(SIGN_OUT_ASK);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    await page.click(page.buttons(/^Keep$/)[0]);
    expect(page.row()!.textContent).not.toContain(SIGN_OUT_ASK);
    await page.click(page.buttons(/^Sign out$/)[0]);
    await page.click(page.buttons(/^Sign out$/).at(-1));
    expect(calls.filter((c) => c.method !== "GET")).toEqual([{ method: "POST", path: "/v2/settings/claude-login/sign-out" }]);
    expect(changed).toEqual([1]);
    const text = page.row()!.textContent ?? "";
    expect(text).toContain(SIGNED_OUT_HERE);
    expect(text).not.toContain("Signed in as");
    expect(page.buttons(/^Sign out$/)).toHaveLength(0);
    expect(page.buttons(/^Turn on$/)).toHaveLength(1);
    // Turn on: no login, so the CLI's sign-in is offered; the sign-out's words go.
    await act(async () => { page.row()!.querySelector<HTMLInputElement>('input[name="only_me"]')!.click(); });
    await page.click(page.buttons(/^Turn on$/)[0]);
    expect(page.row()!.textContent).toContain("Not signed in.");
    expect(page.buttons(/Open the CLI's sign-in here/)).toHaveLength(1);
    expect(page.row()!.textContent).not.toContain(SIGNED_OUT_HERE);
  });

  it("a sign-out the CLI didn't confirm shows the server's words", async () => {
    let view: ClaudeLoginView = SIGNED_IN;
    const { v2 } = server(() => view, () => ({ confirmed: false, message: UNCONFIRMED, login: (view = OFF) }));
    const page = await open(v2);
    await page.click(page.buttons(/^Sign out$/)[0]);
    await page.click(page.buttons(/^Sign out$/).at(-1));
    expect(page.row()!.textContent).toContain(UNCONFIRMED);
  });

  it("the sign-out's words go for good once the row changes again: Sign out, Turn on, sign in, Turn off reads off with no old sign-out words", async () => {
    let view: ClaudeLoginView = SIGNED_IN;
    const { v2 } = server(() => view, (call) => {
      if (call.path === "/v2/settings/claude-login/sign-out") return { confirmed: false, message: UNCONFIRMED, login: (view = OFF) };
      if (call.path === "/v2/settings/claude-login/login") return (view = SIGNED_IN);
      if (call.method === "DELETE") return (view = OFF);
      return (view = { ...OFF, state: "signed_out" });
    });
    const page = await open(v2);
    await page.click(page.buttons(/^Sign out$/)[0]);
    await page.click(page.buttons(/^Sign out$/).at(-1));
    expect(page.row()!.textContent).toContain(UNCONFIRMED);
    await act(async () => { page.row()!.querySelector<HTMLInputElement>('input[name="only_me"]')!.click(); });
    await page.click(page.buttons(/^Turn on$/)[0]);
    await page.click(page.buttons(/Open the CLI's sign-in here/)[0]);
    expect(page.row()!.textContent).toContain("Signed in as person@example.com");
    await page.click(page.buttons(/^Turn off$/)[0]);
    const text = page.row()!.textContent ?? "";
    expect(page.buttons(/^Turn on$/), "Turn off left the row off").toHaveLength(1);
    expect(text, "Turn off after a later sign-in brings back no old sign-out words").not.toContain(UNCONFIRMED);
    expect(text).not.toContain(SIGNED_OUT_HERE);
  });

  it("a sign-out the server refuses keeps the row as it was and says why", async () => {
    const why = "This is your own Claude Code login on this machine (/u/p/.claude), which AgentRun only uses: it never signs it out.";
    const { v2 } = server(() => SIGNED_IN, () => json(403, { error: { code: "forbidden", message: why } }));
    const page = await open(v2);
    await page.click(page.buttons(/^Sign out$/)[0]);
    await page.click(page.buttons(/^Sign out$/).at(-1));
    expect(page.row()!.querySelector('[role="alert"]')?.textContent).toContain(why);
    expect(page.row()!.textContent).toContain("Signed in as person@example.com");
  });
});
