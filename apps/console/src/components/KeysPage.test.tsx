import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { KeysPage } from "./KeysPage";
import { createClient } from "@/lib/client";
import type { ToolKeyField, ToolKeys } from "@/lib/v2";

// Settings → Tool keys over GET, PUT and DELETE /v2/settings/tool-keys: each field says whether it is set and where
// from, a save sends only what was typed, a key the server holds is read-only, a saved key that no longer opens is
// asked for again out loud, and no typed value is ever left in the page.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Obvious fakes: none of these is a key anywhere. */
const FAKE = "not-a-real-key-0123456789";
const OTHER = "also-not-a-real-key-9876";

const field = (name: string, source: ToolKeyField["source"], extra: Partial<ToolKeyField> = {}): ToolKeyField => ({ name, set: source !== null, source, ...extra });
function view(fields: Record<string, ToolKeyField>, reenter: ToolKeys["reenter"] = null): ToolKeys {
  const f = (name: string) => fields[name] ?? field(name, null);
  return {
    keys: [
      { id: "parallel", label: "Parallel", fields: [f("PARALLEL_API_KEY")], unlocks: ["web_fetch", "web_search"], harnesses: ["pi", "claude-agent", "codex"] },
      { id: "monid", label: "Monid", fields: [f("MONID_API_KEY")], unlocks: ["monid.discover", "monid.inspect", "monid.run"], harnesses: ["pi", "claude-agent", "codex"] },
      { id: "browserbase", label: "Browserbase", fields: [f("BROWSERBASE_API_KEY"), f("BROWSERBASE_PROJECT_ID")], unlocks: ["browser"], harnesses: ["pi"] },
    ],
    reenter,
  };
}

type Call = { method: string; path: string; body: unknown };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** A server that answers GET with `views` in turn (the last one again after) and PUT and DELETE with `write`. */
function server(views: ToolKeys[], write: (call: Call) => Response = () => new Response(null, { status: 204 })) {
  const calls: Call[] = [];
  let read = 0;
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (call.method === "GET") return json(200, views[Math.min(read++, views.length - 1)]);
    return write(call);
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls };
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

async function open(v2: ReturnType<typeof createClient>, atRest: "sealed" | "unavailable" = "sealed") {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(KeysPage, { v2, atRest })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const row = (label: string) => [...host.querySelectorAll("li")].find((li) => li.querySelector("span.font-mono")?.textContent === label)!;
  const buttons = (within: Element) => [...within.querySelectorAll("button")];
  const button = (within: Element, label: RegExp) => buttons(within).find((b) => label.test((b.textContent ?? "").trim()));
  const click = async (within: Element, label: RegExp) => { await act(async () => { button(within, label)!.click(); }); await settle(); };
  const input = (name: string) => host.querySelector(`input[name="${name}"]`) as HTMLInputElement;
  // The prototype's setter, so React sees the change as typing.
  const type = async (name: string, value: string) => {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(name), value); input(name).dispatchEvent(new Event("input", { bubbles: true })); });
  };
  return { host, row, buttons, button, click, input, type, settle };
}

describe("KeysPage", () => {
  it("shows each field set or not set, and where it comes from", async () => {
    const { v2 } = server([view({ PARALLEL_API_KEY: field("PARALLEL_API_KEY", "stored"), BROWSERBASE_API_KEY: field("BROWSERBASE_API_KEY", "server") })]);
    const page = await open(v2);
    expect(page.row("Parallel").textContent).toContain("PARALLEL_API_KEYset · saved here");
    expect(page.row("Parallel").textContent).toContain("Unlocks web_fetch, web_search");
    expect(page.button(page.row("Parallel"), /^Change$/)).toBeTruthy();
    expect(page.row("Monid").textContent).toContain("MONID_API_KEYnot set");
    expect(page.button(page.row("Monid"), /^Add key$/)).toBeTruthy();
    expect(page.row("Browserbase").textContent).toContain("BROWSERBASE_API_KEYset · from the server");
    expect(page.row("Browserbase").textContent).toContain("BROWSERBASE_PROJECT_IDnot set");
    expect(page.row("Browserbase").textContent).toContain("1 of 2 set");
    expect(page.row("Browserbase").textContent).toContain("pi only");
  });

  it("Add key sends a PUT with only the values typed, then reads the keys again", async () => {
    const { v2, calls } = server([view({}), view({ BROWSERBASE_API_KEY: field("BROWSERBASE_API_KEY", "stored") })]);
    const page = await open(v2);
    await page.click(page.row("Browserbase"), /^Add key$/);
    expect(page.input("BROWSERBASE_API_KEY").type).toBe("password");
    expect(page.input("BROWSERBASE_API_KEY").getAttribute("autocomplete")).toBe("new-password");
    await page.type("BROWSERBASE_API_KEY", FAKE);
    await page.click(page.row("Browserbase"), /^Save$/);
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes).toEqual([{ method: "PUT", path: "/v2/settings/tool-keys/browserbase", body: { values: { BROWSERBASE_API_KEY: FAKE } } }]);
    expect(calls.filter((c) => c.method === "GET" && c.path === "/v2/settings/tool-keys")).toHaveLength(2);
    expect(page.row("Browserbase").textContent).toContain("BROWSERBASE_API_KEYset · saved here");
    expect(page.input("BROWSERBASE_API_KEY")).toBeNull();
  });

  it("a key the server is started with has no edit controls, and says why", async () => {
    const { v2 } = server([view({ PARALLEL_API_KEY: field("PARALLEL_API_KEY", "server") })]);
    const page = await open(v2);
    expect(page.buttons(page.row("Parallel"))).toEqual([]);
    expect(page.row("Parallel").textContent).toContain("Set when the server starts");
    expect(page.buttons(page.row("Monid")).length).toBeGreaterThan(0);
  });

  it("a key part-held by the server offers inputs only for the fields the page may set", async () => {
    const { v2 } = server([view({ BROWSERBASE_API_KEY: field("BROWSERBASE_API_KEY", "server") })]);
    const page = await open(v2);
    await page.click(page.row("Browserbase"), /^Add key$/);
    expect(page.input("BROWSERBASE_API_KEY")).toBeNull();
    expect(page.input("BROWSERBASE_PROJECT_ID")).toBeTruthy();
  });

  it("keys that no longer open: a banner names the reason and the fields, and marks their rows", async () => {
    const unreadable = field("MONID_API_KEY", null, { set: false, stored_unreadable: true });
    const { v2 } = server([view({ MONID_API_KEY: unreadable }, { reason: "seal_key_changed", fields: ["MONID_API_KEY"] })]);
    const page = await open(v2);
    const banner = page.host.querySelector('[aria-label="Keys to enter again"]')!;
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain("seal key changed");
    expect(banner.textContent).toContain("MONID_API_KEY");
    expect(page.row("Monid").textContent).toContain("enter again");
    expect(page.row("Monid").textContent).toContain("can't be opened");
    expect(page.row("Parallel").textContent).not.toContain("enter again");
  });

  it("a damaged file whose fields are unknown still raises the banner", async () => {
    const { v2 } = server([view({}, { reason: "file_unreadable", fields: [] })]);
    const page = await open(v2);
    const banner = page.host.querySelector('[aria-label="Keys to enter again"]')!;
    expect(banner.textContent).toContain("damaged");
    expect(banner.textContent).toContain("not known");
  });

  it("a server that can't store keys says so plainly and offers no save", async () => {
    const { v2 } = server([view({})]);
    const page = await open(v2, "unavailable");
    expect(page.host.textContent).toContain("This server can't store keys");
    expect(page.host.textContent).toContain("where the server starts");
    for (const label of ["Parallel", "Monid", "Browserbase"]) expect(page.button(page.row(label), /^Add key$/)!.disabled).toBe(true);
  });

  it("a 409 no_sealing_key closes the form, says the server can't store keys and disables saving", async () => {
    const { v2 } = server([view({})], () => json(409, { error: { code: "no_sealing_key", message: "This server was handed no seal key", retryable: false } }));
    const page = await open(v2);
    expect(page.host.textContent).not.toContain("can't store keys");
    await page.click(page.row("Monid"), /^Add key$/);
    await page.type("MONID_API_KEY", FAKE);
    await page.click(page.row("Monid"), /^Save$/);
    expect(page.host.textContent).toContain("This server can't store keys");
    expect(page.input("MONID_API_KEY")).toBeNull();
    expect(page.button(page.row("Monid"), /^Add key$/)!.disabled).toBe(true);
  });

  it("a 422 shows its message at the field, and the form stays open", async () => {
    const { v2 } = server([view({})], () => json(422, { error: { code: "input_invalid", message: "MONID_API_KEY is at most 1024 bytes", retryable: false, fields: [{ field: "values.MONID_API_KEY", reason: "too_long", message: "MONID_API_KEY is at most 1024 bytes" }] } }));
    const page = await open(v2);
    await page.click(page.row("Monid"), /^Add key$/);
    await page.type("MONID_API_KEY", FAKE);
    await page.click(page.row("Monid"), /^Save$/);
    const label = page.input("MONID_API_KEY").closest("label")!;
    expect(label.querySelector('[role="alert"]')!.textContent).toBe("MONID_API_KEY is at most 1024 bytes");
  });

  it("another refusal shows the server's error card on the row, and a key the server now holds is read again", async () => {
    const { v2, calls } = server([view({}), view({ MONID_API_KEY: field("MONID_API_KEY", "server") })], () => json(409, { error: { code: "key_set_by_server", message: "This server is started with MONID_API_KEY: change it where the server is started.", retryable: false, details: { fields: ["MONID_API_KEY"] } } }));
    const page = await open(v2);
    await page.click(page.row("Monid"), /^Add key$/);
    await page.type("MONID_API_KEY", FAKE);
    await page.click(page.row("Monid"), /^Save$/);
    expect(page.row("Monid").textContent).toContain("The key was not saved");
    expect(page.row("Monid").textContent).toContain("key_set_by_server");
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
    expect(page.row("Monid").textContent).toContain("set · from the server");
  });

  it("Remove asks first, then sends a DELETE and reads the keys again", async () => {
    const { v2, calls } = server([view({ PARALLEL_API_KEY: field("PARALLEL_API_KEY", "stored") }), view({})]);
    const page = await open(v2);
    await page.click(page.row("Parallel"), /^Remove$/);
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    await page.click(page.row("Parallel"), /^Remove$/);
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([{ method: "DELETE", path: "/v2/settings/tool-keys/parallel", body: undefined }]);
    expect(page.row("Parallel").textContent).toContain("PARALLEL_API_KEYnot set");
  });

  it("no typed value is ever in the DOM: not while typing, not after a save, not after a cancel", async () => {
    const { v2, calls } = server([view({}), view({ MONID_API_KEY: field("MONID_API_KEY", "stored") })]);
    const page = await open(v2);
    await page.click(page.row("Parallel"), /^Add key$/);
    await page.type("PARALLEL_API_KEY", OTHER);
    expect(page.host.innerHTML).not.toContain(OTHER);
    await page.click(page.row("Parallel"), /^Cancel$/);
    await page.click(page.row("Parallel"), /^Add key$/);
    expect(page.input("PARALLEL_API_KEY").value).toBe("");
    await page.click(page.row("Parallel"), /^Cancel$/);

    await page.click(page.row("Monid"), /^Add key$/);
    await page.type("MONID_API_KEY", FAKE);
    expect(page.input("MONID_API_KEY").getAttribute("value")).toBeNull();
    expect(page.host.innerHTML).not.toContain(FAKE);
    await page.click(page.row("Monid"), /^Save$/);
    expect(calls.some((c) => c.method === "PUT")).toBe(true);
    expect(page.host.innerHTML).not.toContain(FAKE);
    expect([...page.host.querySelectorAll("input")].map((i) => i.value)).not.toContain(FAKE);
    await page.click(page.row("Monid"), /^Change$/);
    expect(page.input("MONID_API_KEY").value).toBe("");
  });
});
