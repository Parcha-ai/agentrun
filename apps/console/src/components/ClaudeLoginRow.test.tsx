import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { KeysPage } from "./KeysPage";
import { ClaudeLoginRow } from "./ClaudeLoginRow";
import { ANTHROPIC_KEY_CREDITS, LOGIN_ROW } from "@/lib/claudeLogin";
import { createClient } from "@/lib/client";
import type { ClaudeLoginView, ToolKeys } from "@/lib/v2";
import { servedKey } from "@/test/keys";

// Settings → Model keys' "Use Claude Code's login on this machine" row: off, it asks where the login is and the owner's
// word that only they run agents here; a server that refuses the mode says why in its one line; on, it says what the CLI
// said (who, which plan), or the command that signs the CLI in and, on the server's machine, a button that starts the
// CLI's own sign-in. A server with the mode switched off answers 404: no row. Beside the Anthropic key, which plans
// include API credits.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEYS: ToolKeys = { keys: [servedKey({ id: "anthropic", kind: "model", label: "Anthropic", fields: [{ name: "ANTHROPIC_API_KEY", set: false, source: null }], unlocks: [], harnesses: ["pi", "claude-agent"], check: null })], reenter: null };
const COMMAND = "CLAUDE_CONFIG_DIR=/data/claude-login CLAUDE_SECURESTORAGE_CONFIG_DIR=/data/claude-login ANTHROPIC_CONFIG_DIR=/data/claude-login/anthropic claude auth login";
const OFF: ClaudeLoginView = { state: "off", place: "agentrun", command: COMMAND, can_start: true };

type Call = { method: string; path: string; body?: unknown };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Answer = ClaudeLoginView | Response;
function server(read: () => Answer | Promise<Answer>, write: (call: Call) => Answer | Promise<Answer>) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", path: String(url), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
    calls.push(call);
    if (call.path === "/v2/settings/tool-keys") return json(200, KEYS);
    const answer = await (call.method === "GET" ? read() : write(call));
    return answer instanceof Response ? answer : json(200, answer);
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls };
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

async function open(v2: ReturnType<typeof createClient>, onChange?: () => void, available?: boolean) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(KeysPage, { v2, writable: true, plan: createElement(ClaudeLoginRow, { v2, writable: true, onChange, available }) })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  const click = async (label: RegExp) => { await act(async () => { button(label)!.click(); }); await settle(); };
  const row = () => host.querySelector<HTMLElement>(`[aria-label="${LOGIN_ROW}"]`);
  return { host, button, click, row, settle };
}

describe("Settings → Model keys, Claude Code's login on this machine", () => {
  it("off: turned on only with the owner's word, at AgentRun's own login unless this machine's is chosen", async () => {
    let view: ClaudeLoginView = OFF;
    const changed: number[] = [];
    const { v2, calls } = server(() => view, (call) => (view = { ...OFF, state: "signed_out", place: (call.body as { place: ClaudeLoginView["place"] }).place }));
    const page = await open(v2, () => changed.push(1));
    const row = page.row()!;
    expect(row.textContent).toContain(LOGIN_ROW);
    expect(page.host.querySelector('section[aria-label="Model keys"]')!.contains(row)).toBe(true);
    expect(page.button(/^Turn on$/)!.disabled).toBe(true);
    const radios = [...row.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.find((r) => r.checked)!.value).toBe("agentrun");
    await act(async () => { radios.find((r) => r.value === "machine")!.click(); });
    await act(async () => { row.querySelector<HTMLInputElement>('input[name="only_me"]')!.click(); });
    await page.click(/^Turn on$/);
    expect(calls.find((c) => c.method === "PUT")).toEqual({ method: "PUT", path: "/v2/settings/claude-login", body: { place: "machine", only_me: true } });
    expect(changed).toEqual([1]);
    // Signed out: the command to run there, and the CLI's own sign-in from here.
    expect(page.row()!.textContent).toContain(COMMAND);
    expect(page.button(/Open the CLI's sign-in here/)).toBeDefined();
  });

  it("signed in: who and which plan; Turn off; nothing else to type", async () => {
    let view: ClaudeLoginView = { state: "signed_in", place: "machine", command: COMMAND, can_start: true, account: { method: "claude.ai", email: "person@example.com", plan: "max" } };
    const { v2, calls } = server(() => view, () => (view = { ...OFF, place: "machine" }));
    const page = await open(v2);
    expect(page.row()!.textContent).toContain("Signed in as person@example.com (Max)");
    expect(page.row()!.querySelector("input")).toBeNull();
    await page.click(/^Turn off$/);
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/v2/settings/claude-login")).toBe(true);
    expect(page.row()!.textContent).toContain("off");
  });

  it("signed out away from the server's machine: the command alone, no button", async () => {
    const { v2 } = server(() => ({ ...OFF, state: "signed_out", can_start: false }), () => OFF);
    const page = await open(v2);
    expect(page.row()!.textContent).toContain(COMMAND);
    expect(page.button(/sign-in/i)).toBeUndefined();
  });

  it("a sign-in run in a terminal shows when the person comes back to the page, or on Check again", async () => {
    let view: ClaudeLoginView = { ...OFF, state: "signed_out", can_start: false };
    const { v2 } = server(() => view, () => view);
    const page = await open(v2);
    expect(page.row()!.textContent).toContain(COMMAND);
    view = { ...OFF, state: "signed_in", can_start: false, account: { method: "claude.ai", email: "person@example.com", plan: "pro" } };
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await page.settle();
    expect(page.row()!.textContent).toContain("Signed in as person@example.com (Pro)");

    view = { ...OFF, state: "signed_out", can_start: false };
    const again = server(() => view, () => view);
    act(() => root?.unmount());
    const second = await open(again.v2);
    view = { ...OFF, state: "signed_in", can_start: false, account: { method: "claude.ai", email: "person@example.com" } };
    await second.click(/^Check again$/);
    expect(second.row()!.textContent).toContain("Signed in as person@example.com");
  });

  it("a status read never puts back the state a Turn off replaced, whether asked before it or while it was out", async () => {
    const signedOut: ClaudeLoginView = { ...OFF, state: "signed_out", place: "machine" };
    const late: ((view: ClaudeLoginView) => void)[] = [];
    let reads = 0;
    let deleted: ((view: ClaudeLoginView) => void) | undefined;
    const { v2 } = server(
      () => (++reads === 1 ? signedOut : new Promise<Answer>((resolve) => { late.push(resolve); })),
      () => new Promise<Answer>((resolve) => { deleted = resolve; }),
    );
    const page = await open(v2);
    // The page comes back into view while Turn off is out.
    await page.click(/^Turn off$/);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await act(async () => { deleted!(OFF); });
    await page.settle();
    expect(page.row()!.querySelector("form")).not.toBeNull();
    // Any read still out answers now, with what was true when it was asked.
    await act(async () => { for (const resolve of late.splice(0)) resolve(signedOut); });
    await page.settle();
    expect(page.row()!.querySelector("form")).not.toBeNull();
    expect(page.row()!.textContent).not.toContain(COMMAND);

    // A read asked before Turn off, answering after it.
    act(() => root?.unmount());
    reads = 0;
    const before = await open(v2);
    await before.click(/^Check again$/);
    expect(late.length).toBe(1);
    await before.click(/^Turn off$/);
    await act(async () => { deleted!(OFF); });
    await act(async () => { for (const resolve of late.splice(0)) resolve(signedOut); });
    await before.settle();
    expect(before.row()!.querySelector("form")).not.toBeNull();
    expect(before.row()!.textContent).not.toContain(COMMAND);
  });

  it("a server that refuses the mode says why in its one line, and offers no turn-on", async () => {
    const refused = "This server takes 2 API tokens, so more than one person can start runs here: a Claude plan is one person's.";
    const { v2 } = server(() => ({ ...OFF, can_start: false, refused }), () => OFF);
    const page = await open(v2);
    expect(page.row()!.textContent).toContain(refused);
    expect(page.button(/^Turn on$/)).toBeUndefined();
  });

  it("switched off, as capabilities say (features.claude_login false): no row, and no request, so the browser logs no 404", async () => {
    const { v2, calls } = server(() => json(404, { error: { code: "not_found", message: "getClaudeLogin: off" } }), () => OFF);
    const page = await open(v2, undefined, false);
    expect(page.row()).toBeNull();
    expect(calls.filter((call) => call.path.startsWith("/v2/settings/claude-login"))).toEqual([]);
    expect(page.host.textContent).toContain(ANTHROPIC_KEY_CREDITS);
  });

  it("switched off while it waits for a sign-in it started: the row goes, and no poll or return to the page asks again", async () => {
    const SIGNED_OUT: ClaudeLoginView = { ...OFF, state: "signed_out", can_start: true };
    const { v2, calls } = server(() => SIGNED_OUT, () => SIGNED_OUT);
    const page = await open(v2, undefined, true);
    await page.click(/Open the CLI's sign-in here/);
    act(() => root!.render(createElement(KeysPage, { v2, writable: true, plan: createElement(ClaudeLoginRow, { v2, writable: true, available: false }) })));
    await page.settle();
    const reads = () => calls.filter((call) => call.method === "GET" && call.path === "/v2/settings/claude-login").length;
    const before = reads();
    await act(async () => { window.dispatchEvent(new Event("focus")); await new Promise((r) => setTimeout(r, 2_500)); });
    await page.settle();
    expect(page.row()).toBeNull();
    expect(reads()).toBe(before);
  });

  it("switched off on the server (404): no row; the Anthropic key says which plans include API credits", async () => {
    const { v2 } = server(() => json(404, { error: { code: "not_found", message: "getClaudeLogin: Claude Code's login on this machine is off on this server (AGENTRUN_CLAUDE_CODE_LOGIN=off)." } }), () => OFF);
    const page = await open(v2);
    expect(page.row()).toBeNull();
    expect(page.host.textContent).toContain(ANTHROPIC_KEY_CREDITS);
    expect(page.host.textContent).not.toMatch(/(Sign in|Continue) with Claude/);
  });
});
