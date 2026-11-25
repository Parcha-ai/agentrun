import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const OFF: ClaudeLoginView = { state: "off", place: "agentrun", command: COMMAND, can_start: true, folder: "/data/claude-login", machine: { folder: "/u/p/.claude", source: "default" } };
const SIGNED_OUT_HERE: ClaudeLoginView = { ...OFF, state: "signed_out" };
const STARTED_AT = "2026-11-23T12:00:00.000Z";

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
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.useRealTimers(); });

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

  it("off: while the owner's word is not ticked, Turn on says why it waits, next to it and as its description; ticked, the words go", async () => {
    const WHY = 'Tick "Only I run agents on this server" to turn it on.';
    const { v2 } = server(() => OFF, () => OFF);
    const page = await open(v2);
    const turnOn = page.button(/^Turn on$/)!;
    expect(turnOn.disabled).toBe(true);
    expect(page.row()!.textContent).toContain(WHY);
    const described = turnOn.getAttribute("aria-describedby");
    expect(described && document.getElementById(described)?.textContent).toBe(WHY);
    await act(async () => { page.row()!.querySelector<HTMLInputElement>('input[name="only_me"]')!.click(); });
    expect(page.button(/^Turn on$/)!.disabled).toBe(false);
    expect(page.row()!.textContent).not.toContain(WHY);
    expect(page.button(/^Turn on$/)!.getAttribute("aria-describedby")).toBeNull();
  });

  it("signed in: who and which plan; Turn off; nothing else to type", async () => {
    let view: ClaudeLoginView = { ...OFF, state: "signed_in", place: "machine", account: { method: "claude.ai", email: "person@example.com", plan: "max" } };
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

  it("a login kept while this server refuses its folders: says it is kept and why, with Turn off and no turn-on; Turn off removes it, and the turn-on comes back", async () => {
    const why = "Claude Code's login on this machine needs its folders to be this server's user's own: it runs as uid 1000 (runner), and /data/runner/claude, the folder CLAUDE_CONFIG_DIR gives it, is not a folder it owns, nor one it would make in a folder it owns. Start the server as the person whose Claude plan it is.";
    let view: ClaudeLoginView = { ...OFF, state: "refused", place: "machine", command: "", can_start: false, refused: why, folder: "/data/runner/claude" };
    const changed: number[] = [];
    const { v2, calls } = server(() => view, (call) => (view = call.method === "DELETE" ? OFF : view));
    const page = await open(v2, () => changed.push(1));
    const text = page.row()?.textContent ?? "";
    expect(text).toContain(why);
    expect(text).toContain("Turned on, and not used while this server refuses its folders");
    expect(text).not.toContain("AgentRun asks the CLI about the login in");
    expect(page.button(/^Turn off$/), "Turn off is offered").toBeDefined();
    expect(page.button(/^Turn on$/)).toBeUndefined();
    expect(page.row()?.querySelector("form")).toBeNull();
    await page.click(/^Turn off$/);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([{ method: "DELETE", path: "/v2/settings/claude-login" }]);
    expect(changed).toEqual([1]);
    expect(page.row()!.querySelector("form")).not.toBeNull();
    expect(page.row()!.textContent).not.toContain(why);
  });

  it("switched off, as capabilities say (features.claude_login false): no row, and no request, so the browser logs no 404", async () => {
    const { v2, calls } = server(() => json(404, { error: { code: "not_found", message: "getClaudeLogin: off" } }), () => OFF);
    const page = await open(v2, undefined, false);
    expect(page.row()).toBeNull();
    expect(calls.filter((call) => call.path.startsWith("/v2/settings/claude-login"))).toEqual([]);
    expect(page.host.textContent).toContain(ANTHROPIC_KEY_CREDITS);
  });

  it("switched off while it waits for a sign-in it started: the row goes, and no poll or return to the page asks again", async () => {
    // Signed out, then the sign-in the row starts waits for the browser, so the row polls (it polls only then).
    let view: ClaudeLoginView = { ...OFF, state: "signed_out", can_start: true };
    const { v2, calls } = server(() => view, () => (view = { ...view, sign_in: { state: "waiting", started_at: STARTED_AT, limit_ms: 600_000 } }));
    // The poll runs on a fake clock, stepped past its interval instead of slept through. setTimeout stays real for settle().
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const page = await open(v2, undefined, true);
    await page.click(/Open the CLI's sign-in here/);
    const reads = () => calls.filter((call) => call.method === "GET" && call.path === "/v2/settings/claude-login").length;
    // Still on, a step past the poll's interval reads the status: the same step below would reach a poll left running.
    const polled = reads();
    await act(async () => { vi.advanceTimersByTime(2_500); });
    await page.settle();
    expect(reads()).toBeGreaterThan(polled);
    act(() => root!.render(createElement(KeysPage, { v2, writable: true, plan: createElement(ClaudeLoginRow, { v2, writable: true, available: false }) })));
    await page.settle();
    expect(vi.getTimerCount()).toBe(0);
    const before = reads();
    await act(async () => { window.dispatchEvent(new Event("focus")); vi.advanceTimersByTime(2_500); });
    await page.settle();
    expect(page.row()).toBeNull();
    expect(reads()).toBe(before);
  });

  it("switched off while a turn-on is out: its answer, landing after, never puts the row back", async () => {
    let land: (view: ClaudeLoginView) => void = () => {};
    const { v2 } = server(() => OFF, () => new Promise<ClaudeLoginView>((resolve) => { land = resolve; }));
    const page = await open(v2, undefined, true);
    await act(async () => { page.row()!.querySelector<HTMLInputElement>('input[name="only_me"]')!.click(); });
    await act(async () => { page.button(/^Turn on$/)!.click(); });
    act(() => root!.render(createElement(KeysPage, { v2, writable: true, plan: createElement(ClaudeLoginRow, { v2, writable: true, available: false }) })));
    await page.settle();
    await act(async () => { land({ ...OFF, state: "signed_out" }); });
    await page.settle();
    expect(page.row()).toBeNull();
  });

  it("switched off while a turn-on is out: its failure, landing after, shows no alert once the row comes back", async () => {
    let fail: (answer: Response) => void = () => {};
    const { v2 } = server(() => OFF, () => new Promise<Answer>((resolve) => { fail = resolve; }));
    const page = await open(v2, undefined, true);
    await act(async () => { page.row()!.querySelector<HTMLInputElement>('input[name="only_me"]')!.click(); });
    await act(async () => { page.button(/^Turn on$/)!.click(); });
    act(() => root!.render(createElement(KeysPage, { v2, writable: true, plan: createElement(ClaudeLoginRow, { v2, writable: true, available: false }) })));
    await page.settle();
    await act(async () => { fail(json(500, { error: { code: "internal", message: "putClaudeLogin: the write failed" } })); });
    await page.settle();
    act(() => root!.render(createElement(KeysPage, { v2, writable: true, plan: createElement(ClaudeLoginRow, { v2, writable: true, available: true }) })));
    await page.settle();
    expect(page.row()).not.toBeNull();
    expect(page.row()!.querySelector('[role="alert"]')).toBeNull();
  });

  it("switched off on the server (404): no row; the Anthropic key says which plans include API credits", async () => {
    const { v2 } = server(() => json(404, { error: { code: "not_found", message: "getClaudeLogin: Claude Code's login on this machine is off on this server (AGENTRUN_CLAUDE_CODE_LOGIN=off)." } }), () => OFF);
    const page = await open(v2);
    expect(page.row()).toBeNull();
    expect(page.host.textContent).toContain(ANTHROPIC_KEY_CREDITS);
    expect(page.host.textContent).not.toMatch(/(Sign in|Continue) with Claude/);
  });

  it("names the folder: this machine's login as the server finds it (never a fixed ~/.claude), the folder the CLI is asked about, and, where the server saw no CLAUDE_CONFIG_DIR, what a Claude Code with its own needs", async () => {
    let view: ClaudeLoginView = OFF;
    const { v2 } = server(() => view, () => (view = { ...OFF, state: "signed_out", place: "machine", folder: "/u/p/.claude" }));
    const page = await open(v2);
    const machine = () => page.row()!.querySelector<HTMLInputElement>('input[type="radio"][value="machine"]')!;
    expect(machine().parentElement!.textContent).toBe("This machine's Claude Code login (/u/p/.claude)");
    expect(page.row()!.textContent).not.toContain("~/.claude");
    expect(page.row()!.textContent).not.toMatch(/start AgentRun with CLAUDE_CONFIG_DIR/);
    await act(async () => { machine().click(); });
    expect(page.row()!.textContent).toMatch(/start AgentRun with CLAUDE_CONFIG_DIR set to that folder/);
    await act(async () => { page.row()!.querySelector<HTMLInputElement>('input[name="only_me"]')!.click(); });
    await page.click(/^Turn on$/);
    expect(page.row()!.textContent).toMatch(/AgentRun asks the CLI about the login in \/u\/p\/\.claude\./);
    expect(page.row()!.textContent).toMatch(/start AgentRun with CLAUDE_CONFIG_DIR set to that folder/);

    // A server started with CLAUDE_CONFIG_DIR: that folder, and nothing to add.
    act(() => root?.unmount());
    view = { ...OFF, machine: { folder: "/work/claude-config", source: "CLAUDE_CONFIG_DIR" } };
    const set = await open(server(() => view, () => view).v2);
    const radio = set.row()!.querySelector<HTMLInputElement>('input[type="radio"][value="machine"]')!;
    expect(radio.parentElement!.textContent).toBe("This machine's Claude Code login (/work/claude-config)");
    await act(async () => { radio.click(); });
    expect(set.row()!.textContent).not.toMatch(/start AgentRun with CLAUDE_CONFIG_DIR/);
  });

  it("names where this machine's login keeps its credentials when the server's environment sets CLAUDE_SECURESTORAGE_CONFIG_DIR, set and empty included, and says nothing of it otherwise", async () => {
    const at = (credentials?: string): ClaudeLoginView => ({ ...SIGNED_OUT_HERE, place: "machine", folder: "/u/p/.claude", machine: { ...OFF.machine, ...(credentials === undefined ? {} : { credentials }) } as ClaudeLoginView["machine"] });
    const set = await open(server(() => at("/u/p/secure"), () => at("/u/p/secure")).v2);
    expect(set.row()!.textContent).toContain("Its credentials are read from /u/p/secure, as CLAUDE_SECURESTORAGE_CONFIG_DIR in the server's environment says.");
    act(() => root?.unmount());
    const empty = await open(server(() => at(""), () => at("")).v2);
    expect(empty.row()!.textContent).toMatch(/CLAUDE_SECURESTORAGE_CONFIG_DIR set empty in the server's environment.*~\/\.claude, and on macOS the Keychain item with no suffix/);
    act(() => root?.unmount());
    const none = await open(server(() => at(), () => at()).v2);
    expect(none.row()!.textContent).not.toMatch(/Its credentials are read/);
  });

  it("a sign-in the server started that still waits shows as waiting from the server's word, after a reload too, with no press on this page", async () => {
    let view: ClaudeLoginView = { ...SIGNED_OUT_HERE, sign_in: { state: "waiting", started_at: STARTED_AT, limit_ms: 600_000 } };
    const { v2, calls } = server(() => view, () => view);
    const page = await open(v2);
    const waiting = page.button(/^Waiting for the browser…$/);
    expect(waiting).toBeDefined();
    expect(waiting!.disabled).toBe(true);
    expect(page.button(/^Open the CLI's sign-in here$/)).toBeUndefined();
    expect(page.row()!.textContent).toMatch(/The sign-in stops after 10 minutes\./);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    // The server says it ended signed in: the row says who.
    view = { ...OFF, state: "signed_in", account: { method: "claude.ai", email: "person@example.com" }, sign_in: { state: "signed_in", started_at: STARTED_AT, ended_at: STARTED_AT, limit_ms: 600_000 } };
    await page.click(/^Check again$/);
    expect(page.row()!.textContent).toContain("Signed in as person@example.com");
    expect(page.button(/^Waiting for the browser…$/)).toBeUndefined();
  });

  it("a sign-in that timed out says so, with its limit and how to start it again, and the button starts it again", async () => {
    let view: ClaudeLoginView = { ...SIGNED_OUT_HERE, sign_in: { state: "timed_out", started_at: STARTED_AT, ended_at: STARTED_AT, limit_ms: 600_000 } };
    const { v2, calls } = server(() => view, () => (view = { ...SIGNED_OUT_HERE, sign_in: { state: "waiting", started_at: STARTED_AT, limit_ms: 600_000 } }));
    const page = await open(v2);
    const status = page.row()!.querySelector('[role="status"]');
    expect(status?.textContent).toMatch(/^The sign-in stopped after 10 minutes with no answer from the browser.*Open the CLI's sign-in here starts it again\.$/);
    const again = page.button(/^Open the CLI's sign-in here$/);
    expect(again!.disabled).toBe(false);
    await page.click(/^Open the CLI's sign-in here$/);
    expect(calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual(["/v2/settings/claude-login/login"]);
    expect(page.button(/^Waiting for the browser…$/)!.disabled).toBe(true);
  });

  it("an older server's answer, with no folder, machine or sign-in, renders as it did: this machine's login at ~/.claude, no folder line, no sign-in state", async () => {
    // A server from before the view named its folders (the development proxy may reach one) answers without them.
    const older = { state: "off", place: "agentrun", command: COMMAND, can_start: true };
    const { v2 } = server(() => json(200, older), () => json(200, { ...older, state: "signed_out", place: "machine" }));
    const page = await open(v2);
    expect(page.row()).not.toBeNull();
    const machine = page.row()!.querySelector<HTMLInputElement>('input[type="radio"][value="machine"]')!;
    expect(machine.parentElement!.textContent).toBe("This machine's Claude Code login (~/.claude)");
    await act(async () => { machine.click(); });
    expect(page.row()!.textContent).not.toMatch(/start AgentRun with CLAUDE_CONFIG_DIR/);
    await act(async () => { page.row()!.querySelector<HTMLInputElement>('input[name="only_me"]')!.click(); });
    await page.click(/^Turn on$/);
    expect(page.row()!.textContent).toContain(COMMAND);
    expect(page.row()!.textContent).not.toMatch(/AgentRun asks the CLI about the login in/);
    expect(page.row()!.textContent).not.toMatch(/start AgentRun with CLAUDE_CONFIG_DIR/);
    expect(page.row()!.querySelector('[role="status"]')).toBeNull();
    expect(page.button(/^Open the CLI's sign-in here$/)!.disabled).toBe(false);
  });

  it("a sign-in the CLI ended without signing in says so with its exit code", async () => {
    const { v2 } = server(() => ({ ...SIGNED_OUT_HERE, sign_in: { state: "failed", started_at: STARTED_AT, ended_at: STARTED_AT, limit_ms: 600_000, exit_code: 1 } }), () => OFF);
    const page = await open(v2);
    expect(page.row()!.querySelector('[role="status"]')?.textContent).toMatch(/ended without signing in \(exit code 1\)/);
    expect(page.button(/^Open the CLI's sign-in here$/)!.disabled).toBe(false);
  });
});
