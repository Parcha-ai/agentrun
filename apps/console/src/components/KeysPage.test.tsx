import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { KeysPage } from "./KeysPage";
import { createClient } from "@/lib/client";
import type { ToolKey, ToolKeys } from "@/lib/v2";
import { type KeyIn, servedKey } from "@/test/keys";

type ToolKeyField = KeyIn["fields"][number];

// Settings → Tool keys over GET, PUT and DELETE /v2/settings/tool-keys: each field says whether it is set and where
// from, a save sends only what was typed, a key the server holds is read-only, a saved key that no longer opens is
// asked for again out loud, and no typed value is ever left in the page.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Obvious fakes: none of these is a key anywhere. */
const FAKE = "not-a-real-key-0123456789";
const OTHER = "also-not-a-real-key-9876";

const field = (name: string, source: ToolKeyField["source"], extra: Partial<ToolKeyField> = {}): ToolKeyField => ({ name, set: source !== null, source, changed_at: source === "console" ? "2026-11-09T09:00:00Z" : null, ...extra });
function view(fields: Record<string, ToolKeyField>, reenter: ToolKeys["reenter"] = null): ToolKeys {
  const f = (name: string) => fields[name] ?? field(name, null);
  return {
    keys: ([
      { id: "parallel", kind: "tool", label: "Parallel", fields: [f("PARALLEL_API_KEY")], unlocks: ["web_fetch", "web_search"], harnesses: ["pi", "claude-agent", "codex"], check: null },
      { id: "monid", kind: "tool", label: "Monid", fields: [f("MONID_API_KEY")], unlocks: ["monid.discover", "monid.inspect", "monid.run"], harnesses: ["pi", "claude-agent", "codex"], check: null },
      { id: "browserbase", kind: "tool", label: "Browserbase", fields: [f("BROWSERBASE_API_KEY"), f("BROWSERBASE_PROJECT_ID")], unlocks: ["browser"], harnesses: ["pi"], check: null },
    ] as KeyIn[]).map(servedKey),
    reenter,
  };
}

type Call = { method: string; path: string; type: string | null; body: unknown };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** A server that answers GET with `views` in turn (the last one again after) and PUT and DELETE with `write`. As serve
 *  does, it takes the session cookie on a write only when the write is JSON: one that is not is 401, bodiless or not. */
function server(views: ToolKeys[], write: (call: Call) => Response | Promise<Response> = () => new Response(null, { status: 204 })) {
  const calls: Call[] = [];
  let read = 0;
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: String(url), type: new Headers(init?.headers).get("content-type"), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (call.method === "GET") return json(200, views[Math.min(read++, views.length - 1)]);
    if (!call.type?.startsWith("application/json")) return json(401, { error: { code: "unauthenticated", message: "this route needs Authorization: Bearer <the token in the data directory>", retryable: false } });
    return write(call);
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls };
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

async function open(v2: ReturnType<typeof createClient>, onChange?: () => void) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  // The owner's password session: secrets can be pasted (session.secrets_writable).
  act(() => root!.render(createElement(KeysPage, { v2, onChange, writable: true })));
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
    const { v2 } = server([view({ PARALLEL_API_KEY: field("PARALLEL_API_KEY", "console"), BROWSERBASE_API_KEY: field("BROWSERBASE_API_KEY", "env") })]);
    const page = await open(v2);
    expect(page.row("Parallel").textContent).toContain("PARALLEL_API_KEYSetPasted here");
    expect(page.row("Parallel").textContent).toContain("Unlocks web_fetch, web_search");
    expect(page.button(page.row("Parallel"), /^Replace$/)).toBeTruthy();
    expect(page.row("Monid").textContent).toContain("MONID_API_KEYMissing");
    expect(page.button(page.row("Monid"), /^Paste$/)).toBeTruthy();
    expect(page.row("Browserbase").textContent).toContain("BROWSERBASE_API_KEYSetSet in the environment");
    expect(page.row("Browserbase").textContent).toContain("BROWSERBASE_PROJECT_IDMissing");
    expect(page.row("Browserbase").textContent).toContain("1 of 2 set");
    expect(page.row("Browserbase").textContent).toContain("pi only");
  });

  // QA: a key that no harness reads (TypeSafe's, which only a decision provider uses) read "Unlocks decisions.jev ·
  // Harnesses", a label with nothing after it. Its row says what it unlocks and nothing about harnesses.
  it("says nothing about harnesses on a row whose key no harness reads", async () => {
    const plain = view({});
    const jev: ToolKey = servedKey({ id: "typesafe", kind: "tool", label: "TypeSafe (Jev)", fields: [field("TYPESAFE_API_KEY", null)], unlocks: ["decisions.jev"], harnesses: [], check: null });
    const { v2 } = server([{ ...plain, keys: [...plain.keys, jev] }]);
    const page = await open(v2);
    expect(page.row("TypeSafe (Jev)").textContent).toContain("Unlocks decisions.jev");
    expect(page.row("TypeSafe (Jev)").textContent).not.toContain("Harnesses");
    expect(page.row("TypeSafe (Jev)").textContent).not.toContain(" · ");
    expect(page.row("Parallel").textContent).toContain("Unlocks web_fetch, web_search · Harnesses pi, claude-agent, codex");
  });

  it("Add key sends a PUT with only the values typed, then reads the keys again and says it changed", async () => {
    const { v2, calls } = server([view({}), view({ BROWSERBASE_API_KEY: field("BROWSERBASE_API_KEY", "console") })]);
    let changed = 0;
    const page = await open(v2, () => changed++);
    await page.click(page.row("Browserbase"), /^Paste$/);
    expect(page.input("BROWSERBASE_API_KEY").type).toBe("password");
    expect(page.input("BROWSERBASE_API_KEY").getAttribute("autocomplete")).toBe("new-password");
    await page.type("BROWSERBASE_API_KEY", FAKE);
    await page.click(page.row("Browserbase"), /^Save$/);
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes).toEqual([{ method: "PUT", path: "/v2/settings/tool-keys/browserbase", type: "application/json", body: { values: { BROWSERBASE_API_KEY: FAKE } } }]);
    expect(calls.filter((c) => c.method === "GET" && c.path === "/v2/settings/tool-keys")).toHaveLength(2);
    expect(page.row("Browserbase").textContent).toContain("BROWSERBASE_API_KEYSetPasted here");
    expect(page.input("BROWSERBASE_API_KEY")).toBeNull();
    expect(changed).toBe(1);
  });

  it("a write that ends after another row's form opened leaves that form and what was typed in it", async () => {
    let answer!: (r: Response) => void;
    const { v2, calls } = server([view({}), view({ MONID_API_KEY: field("MONID_API_KEY", "console") })], () => new Promise<Response>((r) => { answer = r; }));
    const page = await open(v2);
    await page.click(page.row("Monid"), /^Paste$/);
    await page.type("MONID_API_KEY", FAKE);
    await page.click(page.row("Monid"), /^Save$/);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    await page.click(page.row("Parallel"), /^Paste$/);
    await page.type("PARALLEL_API_KEY", OTHER);
    await act(async () => { answer(new Response(null, { status: 204 })); });
    await page.settle();
    expect(page.row("Monid").textContent).toContain("MONID_API_KEYSetPasted here");
    expect(page.input("PARALLEL_API_KEY").value).toBe(OTHER);
  });

  it("a key the server is started with has no edit controls, and says why", async () => {
    const { v2 } = server([view({ PARALLEL_API_KEY: field("PARALLEL_API_KEY", "env") })]);
    const page = await open(v2);
    expect(page.buttons(page.row("Parallel"))).toEqual([]);
    expect(page.row("Parallel").textContent).toContain("Set when the server starts");
    expect(page.buttons(page.row("Monid")).length).toBeGreaterThan(0);
  });

  it("a key part-held by the server offers inputs only for the fields the page may set", async () => {
    const { v2 } = server([view({ BROWSERBASE_API_KEY: field("BROWSERBASE_API_KEY", "env") })]);
    const page = await open(v2);
    await page.click(page.row("Browserbase"), /^Paste$/);
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

  it("a 422 shows its message at the field, and the form stays open", async () => {
    const { v2 } = server([view({})], () => json(422, { error: { code: "input_invalid", message: "MONID_API_KEY is at most 1024 bytes", retryable: false, fields: [{ field: "values.MONID_API_KEY", reason: "too_long", message: "MONID_API_KEY is at most 1024 bytes" }] } }));
    const page = await open(v2);
    await page.click(page.row("Monid"), /^Paste$/);
    await page.type("MONID_API_KEY", FAKE);
    await page.click(page.row("Monid"), /^Save$/);
    const label = page.input("MONID_API_KEY").closest("label")!;
    expect(label.querySelector('[role="alert"]')!.textContent).toBe("MONID_API_KEY is at most 1024 bytes");
  });

  it("another refusal shows the server's error card on the row, and a key the server now holds is read again", async () => {
    const { v2, calls } = server([view({}), view({ MONID_API_KEY: field("MONID_API_KEY", "env") })], () => json(409, { error: { code: "key_set_by_server", message: "This server is started with MONID_API_KEY: change it where the server is started.", retryable: false, details: { fields: ["MONID_API_KEY"] } } }));
    const page = await open(v2);
    await page.click(page.row("Monid"), /^Paste$/);
    await page.type("MONID_API_KEY", FAKE);
    await page.click(page.row("Monid"), /^Save$/);
    expect(page.row("Monid").textContent).toContain("The key was not saved");
    expect(page.row("Monid").textContent).toContain("key_set_by_server");
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
    expect(page.row("Monid").textContent).toContain("Set in the environment");
  });

  it("Remove asks first, then sends a DELETE, reads the keys again and says it changed", async () => {
    const { v2, calls } = server([view({ PARALLEL_API_KEY: field("PARALLEL_API_KEY", "console") }), view({})]);
    let changed = 0;
    const page = await open(v2, () => changed++);
    await page.click(page.row("Parallel"), /^Remove$/);
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    await page.click(page.row("Parallel"), /^Remove$/);
    // Bodiless, and still JSON: the cookie counts on a write only with that type.
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([{ method: "DELETE", path: "/v2/settings/tool-keys/parallel", type: "application/json", body: undefined }]);
    expect(page.row("Parallel").textContent).not.toContain("The key was not removed");
    expect(page.row("Parallel").textContent).toContain("PARALLEL_API_KEYMissing");
    expect(changed).toBe(1);
  });

  it("no typed value is ever in the DOM: not while typing, not after a save, not after a cancel", async () => {
    const { v2, calls } = server([view({}), view({ MONID_API_KEY: field("MONID_API_KEY", "console") })]);
    const page = await open(v2);
    await page.click(page.row("Parallel"), /^Paste$/);
    await page.type("PARALLEL_API_KEY", OTHER);
    expect(page.host.innerHTML).not.toContain(OTHER);
    await page.click(page.row("Parallel"), /^Cancel$/);
    await page.click(page.row("Parallel"), /^Paste$/);
    expect(page.input("PARALLEL_API_KEY").value).toBe("");
    await page.click(page.row("Parallel"), /^Cancel$/);

    await page.click(page.row("Monid"), /^Paste$/);
    await page.type("MONID_API_KEY", FAKE);
    expect(page.input("MONID_API_KEY").getAttribute("value")).toBeNull();
    expect(page.host.innerHTML).not.toContain(FAKE);
    await page.click(page.row("Monid"), /^Save$/);
    expect(calls.some((c) => c.method === "PUT")).toBe(true);
    expect(page.host.innerHTML).not.toContain(FAKE);
    expect([...page.host.querySelectorAll("input")].map((i) => i.value)).not.toContain(FAKE);
    await page.click(page.row("Monid"), /^Replace$/);
    expect(page.input("MONID_API_KEY").value).toBe("");
  });

  it("lists a model provider's key under Model keys, before the tools' keys, and saves it through its own route; with none, no headings", async () => {
    const plain = view({});
    const anthropic: ToolKey = servedKey({ id: "anthropic", kind: "model", label: "Anthropic", fields: [field("ANTHROPIC_API_KEY", null)], unlocks: [], harnesses: ["pi", "claude-agent"], check: null });
    const { v2, calls } = server([{ ...plain, keys: [...plain.keys.map((k) => ({ ...k, kind: "tool" as const })), anthropic] }]);
    const page = await open(v2);
    expect([...page.host.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(["Model keys", "Tool keys"]);
    const labels = (section: string) => [...page.host.querySelectorAll(`section[aria-label="${section}"] > ul > li`)].map((li) => li.querySelector("span.font-mono")?.textContent);
    expect([labels("Model keys"), labels("Tool keys")]).toEqual([["Anthropic"], ["Parallel", "Monid", "Browserbase"]]);
    expect(page.host.querySelector('section[aria-label="Model keys"] > p')?.textContent).toBe("We recommend an OpenRouter key with a dollar cap and an expiration date. Do not share this key with anyone.");
    expect(page.host.querySelector('section[aria-label="Tool keys"] > p')).toBeNull();
    expect(page.row("Anthropic").textContent).toContain("Model provider · Harnesses pi, claude-agent");
    await page.click(page.row("Anthropic"), /^Paste$/);
    await page.type("ANTHROPIC_API_KEY", FAKE);
    await page.click(page.row("Anthropic"), /^Save$/);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([{ method: "PUT", path: "/v2/settings/tool-keys/anthropic", type: "application/json", body: { values: { ANTHROPIC_API_KEY: FAKE } } }]);
    expect(page.host.innerHTML).not.toContain(FAKE);
    act(() => root?.unmount());
    document.body.innerHTML = "";
    const older = await open(server([plain]).v2);
    expect(older.host.querySelectorAll("h2")).toHaveLength(0);
    expect(older.host.textContent).not.toContain("We recommend an OpenRouter key");
    expect(older.row("Parallel").textContent).toContain("Unlocks web_fetch, web_search");
  });
});
