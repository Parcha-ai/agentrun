import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputersPage } from "./ComputersPage";
import { SETTINGS_PAGES } from "./Settings";
import { SIGN_IN_TO_CHANGE } from "@/lib/secrets";
import { route } from "@/App";
import { createClient } from "@/lib/client";
import type { ComputerKindView, ComputerProvider, Computers, ComputerSecret, PairedComputer } from "@/lib/v2";

// Settings → Computers over GET /v2/computers, PUT /v2/computers/{provider}/keys and POST /v2/computers/{provider}/test:
// a section per kind with the server's why when it isn't offered, each provider under every kind it serves with its keys
// as SecretRows by their KEY (never a value), required or Optional, with where each is set and when, and its why; the
// metered line on a metered provider of a kind that bills by the minute; Paste or Replace of one key sends only that KEY and leaves no value in the
// page, a removal sends null, a key the environment holds is greyed with nothing to paste, a refusal is said in the
// server's words, and a test says the server's passed or failed.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Obvious fakes: none of these is a key anywhere. */
const FAKE = "not-a-real-key-0123456789";

const E2B_WHY = "E2B needs E2B_API_KEY saved: save it in Settings → Computers";
const PHONE_WHY = "no provider serves a phone computer";
const CHANGED = "2026-11-09T01:00:00.000Z";
const METERED = "This provider bills by the minute through your own vendor account, and those minutes aren't counted in a run's spending cap.";
/** A provider's secret as served: its full name "computer:<provider>:<KEY>". */
const secret = (provider: string, key: string, set: boolean, source: ComputerSecret["source"] = set ? "console" : null): ComputerSecret => ({ name: `computer:${provider}:${key}`, set, source, changed_at: source === "console" ? CHANGED : null });
/** Where a choice's runs have their shell, as the server serves it: a computer that mounts the run's folder gives every
 *  host tool; one that doesn't, the file tools only. */
const MOUNTS = { shell: "computer" as const, host_tools: ["read", "write", "edit", "bash", "bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"] };
const NO_SHELL = { shell: "none" as const, host_tools: ["read", "write", "edit"], shell_note: "No computer on this server: the agent gets the file tools only, no shell. Pick a computer to run commands." };
const docker: ComputerProvider = { id: "docker", name: "Docker", metered: false, secrets: [], required: [], ready: true, ...MOUNTS };
const e2b = (saved = false): ComputerProvider => ({ id: "e2b", name: "E2B", metered: true, secrets: [secret("e2b", "E2B_API_KEY", saved)], required: ["computer:e2b:E2B_API_KEY"], ready: saved, ...(saved ? {} : { why: E2B_WHY }), ...NO_SHELL });
const orgo: ComputerProvider = { id: "orgo", name: "Orgo", metered: true, secrets: [secret("orgo", "ORGO_API_KEY", true)], required: ["computer:orgo:ORGO_API_KEY"], ready: true, ...NO_SHELL };
const kernel: ComputerProvider = { id: "kernel", name: "Kernel", metered: true, secrets: [secret("kernel", "KERNEL_API_KEY", false), secret("kernel", "KERNEL_REGION", false)], required: ["computer:kernel:KERNEL_API_KEY"], ready: false, why: "Kernel needs KERNEL_API_KEY saved", ...NO_SHELL };
/** Daytona's key is in the server's environment: it wins, greyed, with nothing to paste over it. */
const daytona: ComputerProvider = { id: "daytona", name: "Daytona", metered: true, secrets: [secret("daytona", "DAYTONA_API_KEY", true, "env")], required: ["computer:daytona:DAYTONA_API_KEY"], ready: true, ...NO_SHELL };
/** A person's own Mac, paired and attached; it is also a provider of the desktop kind. */
/** A paired computer of no OS the page knows: it is shown by what its hello says. */
const DESK: PairedComputer = {
  id: "cmp-abc", name: "desk-1", kind: "desktop", serves: ["desktop"], os: "windows", os_version: "11", device: { maker: "Acme", model: "Book 14" }, arch: "x86_64",
  screen: { width: 1920, height: 1080, scale: 1 }, groups: ["screen", "input.pointer", "input.keys"], features: { "ui.tree": { off: "no accessibility grant" } },
  driver: "0.2.0", online: true, held_by_run: null, held_until: null, created_at: "2026-11-12T10:00:30.000Z", seen_at: "2026-11-12T10:00:31.000Z",
};
const DESK_PROVIDER: ComputerProvider = { id: "cmp-abc", name: "desk-1 (windows)", metered: false, secrets: [], required: [], ready: true, ...NO_SHELL };
const kind = (k: ComputerKindView["kind"], providers: ComputerProvider[], extra: Partial<ComputerKindView> = {}): ComputerKindView => ({ kind: k, offered: true, groups: [], tools: [], providers, ...extra });
const view = (saved = false): Computers => ({
  paired: [],
  kinds: [
    kind("none", []),
    kind("sandbox", [docker, e2b(saved), daytona]),
    kind("desktop", [e2b(saved), orgo]),
    kind("phone", [], { offered: false, why: PHONE_WHY }),
    kind("browser", [kernel]),
  ],
});

type Call = { method: string; path: string; type: string | null; body: unknown };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** A server that answers GET with `views` in turn (the last one again after), and PUT and POST with `write`. */
function server(views: (Computers | Response)[], write: (call: Call) => Response | Promise<Response> = () => json(200, {})) {
  const calls: Call[] = [];
  let read = 0;
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: String(url), type: new Headers(init?.headers).get("content-type"), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (call.method === "GET") { const v = views[Math.min(read++, views.length - 1)]!; return v instanceof Response ? v : json(200, v); }
    return write(call);
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls };
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

async function open(v2: ReturnType<typeof createClient>, writable = true) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(ComputersPage, { v2, writable })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const section = (label: string) => host.querySelector(`section[aria-label="${label}"]`)!;
  /** A provider's row under a kind's section. */
  const row = (kindLabel: string, name: string) => [...section(kindLabel).querySelectorAll("li")].find((li) => li.querySelector("[data-provider]")?.textContent === name)!;
  const button = (within: Element, label: RegExp) => [...within.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  const click = async (within: Element, label: RegExp) => { const b = button(within, label); expect(b, String(label)).toBeTruthy(); await act(async () => { b!.click(); }); await settle(); };
  const type = async (within: Element, name: string, value: string) => {
    const input = within.querySelector(`input[name="${name}"]`) as HTMLInputElement;
    expect(input, name).toBeTruthy();
    await act(async () => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const submit = async (form: HTMLFormElement) => { await act(async () => { form.requestSubmit(); }); await settle(); };
  /** A key's SecretRow under a provider's row, by its KEY. */
  const key = (within: Element, name: string) => within.querySelector(`li[data-secret$=":${name}"]`)!;
  return { host, section, row, key, button, click, type, submit, settle };
}

describe("Settings → Computers", () => {
  it("is a Settings tab, at #/settings/computers", () => {
    expect(SETTINGS_PAGES.map((p) => p.label)).toContain("Computers");
    expect(route("#/settings/computers")).toEqual({ section: "settings", settings: "computers" });
  });

  it("shows a section per kind: the server's why for a kind it doesn't offer, and nothing to set up for none", async () => {
    const { v2 } = server([view()]);
    const { host, section } = await open(v2);
    expect([...host.querySelectorAll("section[aria-label]")].map((s) => s.getAttribute("aria-label"))).toEqual(["Your computers", "None", "Sandbox", "Desktop", "Phone", "Browser"]);
    expect(section("None").textContent).toContain("Nothing to set up");
    expect(section("None").querySelectorAll("li")).toHaveLength(0);
    expect(section("Phone").textContent).toContain(PHONE_WHY);
    expect(section("Phone").textContent).toContain("Not offered here");
    expect(section("Sandbox").textContent).not.toContain("Not offered here");
  });

  it("lists each provider under every kind it serves, with its keys as SecretRows by their KEY, and its why", async () => {
    const { v2 } = server([view()]);
    const { host, row, key } = await open(v2);
    for (const k of ["Sandbox", "Desktop"]) {
      const r = row(k, "E2B");
      expect(r, k).toBeTruthy();
      expect(r.textContent).toContain("Serves: sandbox, desktop");
      expect(key(r, "E2B_API_KEY").textContent).toContain("Missing");
      expect(r.textContent).toContain(E2B_WHY);
      expect(r.textContent).not.toContain("Ready");
    }
    const orgoKey = key(row("Desktop", "Orgo"), "ORGO_API_KEY");
    expect(orgoKey.textContent).toContain("Set");
    expect(orgoKey.textContent).toContain("Pasted here");
    expect(orgoKey.textContent).toContain("Changed");
    expect(row("Desktop", "Orgo").textContent).toContain("Ready");
    expect(row("Desktop", "Orgo").textContent).toContain("Serves: desktop");
    expect(row("Sandbox", "Docker").textContent).toContain("No key");
    // Required or not, from the provider's required full names.
    const k = row("Browser", "Kernel");
    expect([...k.querySelectorAll("li[data-secret]")].map((li) => li.getAttribute("data-secret"))).toEqual(["computer:kernel:KERNEL_API_KEY", "computer:kernel:KERNEL_REGION"]);
    expect([...k.querySelectorAll("li[data-secret] > span:first-child")].map((el) => el.firstChild?.textContent)).toEqual(["KERNEL_API_KEY", "KERNEL_REGION"]);
    expect(key(k, "KERNEL_API_KEY").textContent).not.toContain("Optional");
    expect(key(k, "KERNEL_REGION").textContent).toContain("Optional");
    expect(key(k, "KERNEL_REGION").querySelector("[data-state]")?.getAttribute("data-state")).toBe("optional-missing");
    expect(key(k, "KERNEL_API_KEY").querySelector("[data-state]")?.getAttribute("data-state")).toBe("missing");
    expect(host.textContent).not.toMatch(/computer:|workspace:/);
  });

  it("greys a key the server's environment holds, with nothing to paste over or remove", async () => {
    const { v2 } = server([view()]);
    const { row, key, button } = await open(v2);
    const env = key(row("Sandbox", "Daytona"), "DAYTONA_API_KEY");
    expect(env.getAttribute("data-source")).toBe("env");
    expect(env.textContent).toContain("Set in the environment");
    expect(button(env, /^(Paste|Replace|Remove)$/)).toBeUndefined();
  });

  it("says Metered on a metered provider with no link or figure, and the by-the-minute line under sandbox, desktop and phone", async () => {
    const { v2 } = server([view()]);
    const { row } = await open(v2);
    const orgoRow = row("Desktop", "Orgo");
    expect(orgoRow.querySelector("[data-metered]")?.textContent).toBe("Metered");
    expect(orgoRow.querySelectorAll("a")).toHaveLength(0);
    expect(orgoRow.textContent).not.toMatch(/\$|pricing/i);
    expect(orgoRow.textContent).toContain(METERED);
    // A browser bills by the session, not the minute: the word alone.
    expect(row("Browser", "Kernel").querySelector("[data-metered]")?.textContent).toBe("Metered");
    expect(row("Browser", "Kernel").textContent).not.toContain(METERED);
    expect(row("Sandbox", "Docker").querySelector("[data-metered]")).toBeNull();
    expect(row("Sandbox", "Docker").textContent).not.toContain("Metered");
  });

  it("pastes one key: sends only its KEY, reads the computers again, and leaves no value in the page", async () => {
    const { v2, calls } = server([view(false), view(true)], () => json(200, e2b(true)));
    const { host, row, key, click, type, submit } = await open(v2);
    await click(key(row("Sandbox", "E2B"), "E2B_API_KEY"), /^Paste$/);
    const form = row("Sandbox", "E2B").querySelector("form")!;
    expect(form.querySelector('input[name="E2B_API_KEY"]')!.getAttribute("type")).toBe("password");
    await type(form, "E2B_API_KEY", FAKE);
    await submit(form);
    const put = calls.filter((c) => c.method === "PUT");
    expect(put).toEqual([{ method: "PUT", path: "/v2/computers/e2b/keys", type: "application/json", body: { E2B_API_KEY: FAKE } }]);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
    expect(row("Sandbox", "E2B").querySelector("form")).toBeNull();
    expect(key(row("Desktop", "E2B"), "E2B_API_KEY").textContent).toContain("Set");
    expect(row("Desktop", "E2B").textContent).toContain("Ready");
    expect(host.innerHTML).not.toContain(FAKE);
    expect([...host.querySelectorAll("input")].map((i) => i.value)).not.toContain(FAKE);
  });

  it("a key's form takes that key alone, and its row's buttons wait while it is open", async () => {
    const { v2, calls } = server([view()], () => json(200, kernel));
    const { row, key, click, button, type, submit } = await open(v2);
    await click(key(row("Browser", "Kernel"), "KERNEL_REGION"), /^Paste$/);
    const form = row("Browser", "Kernel").querySelector("form")!;
    expect([...form.querySelectorAll("input")].map((i) => i.name)).toEqual(["KERNEL_REGION"]);
    expect(button(row("Browser", "Kernel"), /^(Paste|Replace|Remove)$/)).toBeUndefined();
    await type(form, "KERNEL_REGION", FAKE);
    await submit(form);
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({ path: "/v2/computers/kernel/keys", body: { KERNEL_REGION: FAKE } });
  });

  it("shows a refused save in the server's words, by key, and keeps the form open", async () => {
    const refusal = { error: { code: "invalid_request", message: "the keys were refused", retryable: false, fields: [{ field: "KERNEL_REGION", reason: "wrong_type", message: "KERNEL_REGION is a non-empty string, or null to remove it" }] } };
    const { v2 } = server([view()], () => json(422, refusal));
    const { row, key, click, type, submit } = await open(v2);
    await click(key(row("Browser", "Kernel"), "KERNEL_REGION"), /^Paste$/);
    const form = row("Browser", "Kernel").querySelector("form")!;
    await type(form, "KERNEL_REGION", "x");
    await submit(form);
    const alert = row("Browser", "Kernel").querySelector("form [role=alert]");
    expect(alert?.textContent).toBe("KERNEL_REGION is a non-empty string, or null to remove it");
    expect((row("Browser", "Kernel").querySelector('input[name="KERNEL_REGION"]') as HTMLInputElement).closest("label")!.contains(alert!)).toBe(true);
  });

  it("says a write refused off the owner's session in the server's words", async () => {
    const words = "only the owner's password session changes a secret";
    const { v2 } = server([view()], () => json(403, { error: { code: "forbidden", message: words, retryable: false } }));
    const { row, key, click, type, submit } = await open(v2);
    await click(key(row("Sandbox", "E2B"), "E2B_API_KEY"), /^Paste$/);
    const form = row("Sandbox", "E2B").querySelector("form")!;
    await type(form, "E2B_API_KEY", FAKE);
    await submit(form);
    expect(row("Sandbox", "E2B").querySelector("[role=alert]")?.textContent).toBe(`forbidden: ${words}`);
  });

  it("removes a saved key, after asking, by sending null", async () => {
    const { v2, calls } = server([view(true), view(false)], () => json(200, e2b(false)));
    const { row, key, click } = await open(v2);
    await click(key(row("Desktop", "Orgo"), "ORGO_API_KEY"), /^Remove$/);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(row("Desktop", "Orgo").textContent).toContain("Remove ORGO_API_KEY saved on this server?");
    await click(row("Desktop", "Orgo").querySelector("[data-confirm]")!, /^Remove$/);
    expect(calls.filter((c) => c.method === "PUT")).toEqual([{ method: "PUT", path: "/v2/computers/orgo/keys", type: "application/json", body: { ORGO_API_KEY: null } }]);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
  });

  it("tests a provider: the server's passed with its detail, or failed with its why, wherever the provider shows", async () => {
    const { v2, calls } = server([view()], (c) => json(200, c.path.endsWith("/orgo/test") ? { ok: true, detail: "Orgo answered: 3 computers on this account" } : { ok: false, why: E2B_WHY }));
    const { row, click } = await open(v2);
    await click(row("Desktop", "Orgo"), /^Test connection$/);
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/v2/computers/orgo/test" });
    expect(row("Desktop", "Orgo").querySelector("[data-test]")?.textContent).toMatch(/^Passed · .+ · Orgo answered: 3 computers on this account$/);
    await click(row("Sandbox", "E2B"), /^Test connection$/);
    for (const k of ["Sandbox", "Desktop"]) expect(row(k, "E2B").querySelector("[data-test]")?.textContent, k).toMatch(new RegExp(`^Failed · .+ · ${E2B_WHY.replace(/[()]/g, "\\$&")}$`));
  });

  it("off the owner's password session, says once how to change keys and offers no key input, Paste or Remove", async () => {
    const { v2 } = server([view(true)]);
    const { host, row, button } = await open(v2, false);
    const status = [...host.querySelectorAll("[role=status]")];
    expect(status.map((s) => s.textContent)).toEqual([SIGN_IN_TO_CHANGE]);
    expect(host.querySelectorAll("input")).toHaveLength(0);
    expect(button(host, /^(Paste|Replace|Remove)$/)).toBeUndefined();
    // The keys are still read out by name, and a test still runs: it changes nothing.
    expect(row("Desktop", "Orgo").textContent).toContain("ORGO_API_KEY");
    expect(button(row("Desktop", "Orgo"), /^Test connection$/)).toBeTruthy();
  });

  it("on the owner's password session, has no sign-in note", async () => {
    const { v2 } = server([view()]);
    const { host } = await open(v2);
    expect(host.textContent).not.toContain(SIGN_IN_TO_CHANGE);
  });

  it("pairs a computer: shows the code, this server's address and the countdown, reads the computers again while it is up, names the computer that used it, and lists it once, in its own section, as its hello says", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: Date.parse("2026-11-12T10:00:00.000Z") });
    try {
      const withDesk: Computers = { ...view(), paired: [DESK], kinds: view().kinds.map((k) => (k.kind === "desktop" ? { ...k, providers: [...k.providers, DESK_PROVIDER] } : k)) };
      const { v2, calls } = server([view(), view(), withDesk], () => json(201, { code: "K7PD-W3QX", expires_at: "2026-11-12T10:10:00.000Z" }));
      const { section, click, settle } = await open(v2);
      const mine = section("Your computers");
      expect(mine.textContent).toContain("None paired yet");
      await click(mine, /^Pair a computer$/);
      expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/v2/computers/pairings" });
      expect(mine.querySelector("[data-code]")?.textContent).toBe("K7PD-W3QX");
      expect(mine.querySelector("[data-address]")?.textContent).toBe(window.location.origin);
      expect(mine.querySelector("[data-countdown]")?.textContent).toBe("10:00");
      const tick = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); await settle(); };
      await tick(2_000);
      expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
      expect(mine.querySelector("[data-countdown]")?.textContent).toBe("9:58");
      await tick(2_000);
      expect(mine.querySelector("[data-code]")).toBeNull();
      expect(mine.querySelector("[role=status]")?.textContent).toBe("Paired desk-1.");
      const row = mine.querySelector('[data-paired="cmp-abc"]')!;
      expect(row.textContent).toContain("Online");
      expect(row.querySelector("[data-machine]")?.textContent).toBe("Desktop · Acme Book 14 · windows 11 · x86_64 · screen 1920×1080 at 1x");
      expect(row.querySelector("[data-offers]")?.textContent).toBe("Offers screen, input.pointer, input.keys · ui.tree off: no accessibility grant");
      expect(row.querySelector("[data-held-until]")).toBeNull();
      expect([...section("Desktop").querySelectorAll("[data-provider]")].map((el) => el.textContent)).toEqual(["E2B", "Orgo"]);
      expect(section("Desktop").textContent).toContain("Also served by your computers: desk-1 (windows).");
      await tick(10_000);
      expect(calls.filter((c) => c.method === "GET"), "no reads once the code is used").toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says a paired computer offline and how to bring it back, the run that holds one and the deadline its hold ends by, and removes one after asking", async () => {
    const held = { ...DESK, held_by_run: "0190f0aa-0000-7000-8000-00000000beef", held_until: "2026-11-12T11:00:00.000Z" };
    const away: PairedComputer = { ...DESK, id: "cmp-old", name: "old-desk", online: false, seen_at: null };
    const { v2, calls } = server([{ ...view(), paired: [held, away] }, { ...view(), paired: [held] }], () => new Response(null, { status: 204 }));
    const { section, click } = await open(v2);
    const mine = section("Your computers");
    const row = (id: string) => mine.querySelector(`[data-paired="${id}"]`);
    expect(row("cmp-abc")!.textContent).toContain("In use by run 0000beef");
    expect(row("cmp-abc")!.querySelector("[data-held-until]")?.textContent).toMatch(/^The run's hold ends by .+, released or not\.$/);
    expect(row("cmp-old")!.textContent).toContain("Offline");
    expect(row("cmp-old")!.textContent).toContain("Open its driver on that computer: it dials this server.");
    await click(row("cmp-old")!, /^Remove$/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(row("cmp-old")!.querySelector("[data-confirm]")?.textContent).toContain("Remove old-desk?");
    await click(row("cmp-old")!.querySelector("[data-confirm]")!, /^Remove$/);
    expect(calls.filter((c) => c.method === "DELETE")).toMatchObject([{ path: "/v2/computers/cmp-old", body: undefined }]);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
    expect(row("cmp-old")).toBeNull();
  });

  it("says a failed read in the server's words, and reads again on Try again", async () => {
    const down = json(500, { error: { code: "internal", message: "the store is busy", retryable: true } });
    const { v2, calls } = server([down, view()]);
    const { host, click, section } = await open(v2);
    expect(host.querySelector("[role=alert]")?.textContent).toContain("The computers could not be read: internal: the store is busy");
    await click(host, /^Try again$/);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
    expect(section("Sandbox")).toBeTruthy();
  });
});
