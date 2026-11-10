import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspacePage } from "./WorkspacePage";
import { SETTINGS_PAGES } from "./Settings";
import { SIGN_IN_TO_CHANGE } from "@/lib/secrets";
import { route } from "@/App";
import { createClient } from "@/lib/client";
import type { Archil } from "@/lib/v2";

// Settings → Workspace over GET, PUT and DELETE /v2/workspace/archil and POST /v2/workspace/archil/test: Archil (Mode 2)
// on or off with its disk and region, its key as a SecretRow said ARCHIL_API_KEY (never a value), a save that sends the fields and the key only when pasted and says a refusal by field, a key the environment
// holds greyed with nothing to paste, a Test that says the server's detail or why as given, and Turn off after a confirm.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Obvious fakes: none of these is a key or a disk anywhere. */
const FAKE = "not-a-real-key-0123456789";
const COPY = "Runs keep their folders on this Archil disk. The server never mounts it; computers that support it mount a run's folder.";
const IMAGE = `example/exec@sha256:${"a".repeat(64)}`;

/** Archil's one secret as served, "workspace:archil"; the page says it as ARCHIL_API_KEY, the name the PUT takes. */
const secret = (set: boolean, source: Archil["secret"]["source"] = set ? "console" : null): Archil["secret"] => ({ name: "workspace:archil", set, source, changed_at: source === "console" ? "2026-11-09T01:00:00.000Z" : null });
const off: Archil = { on: false, secret: secret(false) };
const on: Archil = { on: true, diskId: "dsk-test-1", region: "aws-us-east-1", s3Url: "https://s3.example.test", secret: secret(true) };

type Call = { method: string; path: string; type: string | null; body: unknown };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** A server that answers GET with `views` in turn (the last one again after), and PUT, DELETE and POST with `write`. */
function server(views: (Archil | Response)[], write: (call: Call) => Response | Promise<Response> = () => json(200, on)) {
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
  act(() => root!.render(createElement(WorkspacePage, { v2, writable })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const button = (label: RegExp, within: Element = host) => [...within.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  const click = async (label: RegExp, within: Element = host) => { const b = button(label, within); expect(b, String(label)).toBeTruthy(); await act(async () => { b!.click(); }); await settle(); };
  const input = (name: string) => host.querySelector(`input[name="${name}"]`) as HTMLInputElement;
  const type = async (name: string, value: string) => {
    const el = input(name);
    expect(el, name).toBeTruthy();
    // React tracks a controlled input's value: set it through the native setter so its onChange sees the change.
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const submit = async () => { await act(async () => { host.querySelector("form")!.requestSubmit(); }); await settle(); };
  return { host, button, click, input, type, submit, settle };
}

describe("Settings → Workspace", () => {
  it("is a Settings tab, at #/settings/workspace", () => {
    expect(SETTINGS_PAGES.map((p) => p.label)).toContain("Workspace");
    expect(route("#/settings/workspace")).toEqual({ section: "settings", settings: "workspace" });
  });

  it("says Archil is off, with its one line, and its keys by name, not set", async () => {
    const { v2 } = server([off]);
    const { host } = await open(v2);
    expect(host.querySelector("h1")?.textContent).toBe("Workspace");
    expect(host.textContent).toContain(COPY);
    // Archil's on or off is one mark, not the key row's state (SecretRow's own data-state).
    expect(host.querySelectorAll("[data-archil-state]")).toHaveLength(1);
    expect(host.querySelector("[data-archil-state]")?.textContent).toBe("Off");
    // One key, said by the name the write takes, never the server's full secret name.
    expect([...host.querySelectorAll("li[data-secret]")].map((li) => li.getAttribute("data-secret"))).toEqual(["workspace:archil"]);
    expect(host.querySelector('li[data-secret="workspace:archil"] > span')?.textContent).toBe("ARCHIL_API_KEY");
    expect(host.querySelector('li[data-secret="workspace:archil"]')!.textContent).toContain("Missing");
    expect(host.textContent).not.toMatch(/workspace:|computer:/);
    // No key input until Paste.
    expect(host.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect(host.querySelector('input[name="image"]')!.getAttribute("placeholder")).toBe("Archil's default (recommended)");
  });

  it("says Archil is on with its disk and region, and fills the fields from the server", async () => {
    const { v2 } = server([on]);
    const { host, input } = await open(v2);
    expect(host.querySelector("[data-archil-state]")?.textContent).toBe("On");
    expect(host.querySelector("[data-disk]")?.textContent).toBe("dsk-test-1 · aws-us-east-1");
    expect(input("diskId").value).toBe("dsk-test-1");
    expect(input("region").value).toBe("aws-us-east-1");
    expect(input("s3Url").value).toBe("https://s3.example.test");
    expect(input("image").value).toBe("");
    const row = host.querySelector('li[data-secret="workspace:archil"]')!;
    expect(row.textContent).toContain("Set");
    expect(row.textContent).toContain("Pasted here");
    expect(row.textContent).toContain("Changed");
  });

  it("greys a key the server's environment holds, with nothing to paste over or remove", async () => {
    const { v2 } = server([{ ...on, secret: secret(true, "env") }]);
    const { host, button } = await open(v2);
    const row = host.querySelector('li[data-secret="workspace:archil"]')!;
    expect(row.getAttribute("data-source")).toBe("env");
    expect(row.textContent).toContain("Set in the environment");
    expect(button(/^(Paste|Replace|Remove)$/, row)).toBeUndefined();
  });

  it("saves the fields and the key pasted, as a password, and leaves no key in the page", async () => {
    const { v2, calls } = server([off, on]);
    const { host, input, click, type, submit } = await open(v2);
    await click(/^Paste$/, host.querySelector('li[data-secret="workspace:archil"]')!);
    expect(input("ARCHIL_API_KEY").getAttribute("type")).toBe("password");
    await type("diskId", "dsk-test-1");
    await type("region", "aws-us-east-1");
    await type("s3Url", "https://s3.example.test");
    await type("ARCHIL_API_KEY", FAKE);
    await submit();
    expect(calls.filter((c) => c.method === "PUT")).toEqual([{ method: "PUT", path: "/v2/workspace/archil", type: "application/json", body: { diskId: "dsk-test-1", region: "aws-us-east-1", s3Url: "https://s3.example.test", keys: { ARCHIL_API_KEY: FAKE } } }]);
    expect(host.querySelector("[data-archil-state]")?.textContent).toBe("On");
    expect(host.innerHTML).not.toContain(FAKE);
    expect([...host.querySelectorAll("input")].map((i) => i.value)).not.toContain(FAKE);
  });

  it("keeps the key with the settings it saves with: its row is in the form, and Paste or Remove never saves", async () => {
    const { v2, calls } = server([on]);
    const { host, click } = await open(v2);
    const row = host.querySelector('li[data-secret="workspace:archil"]')!;
    expect(row.closest("form")).toBe(host.querySelector("form"));
    await click(/^Replace$/, row);
    await click(/^Cancel$/, host.querySelector("form")!);
    await click(/^Remove$/, host.querySelector('li[data-secret="workspace:archil"]')!);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("sends an image only when one is given", async () => {
    const { v2, calls } = server([on]);
    const { type, submit } = await open(v2);
    await type("image", IMAGE);
    await submit();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ diskId: "dsk-test-1", region: "aws-us-east-1", s3Url: "https://s3.example.test", image: IMAGE });
  });

  it("says a refused save by field, in the server's words, and keeps what was typed", async () => {
    const refusal = { error: { code: "input_invalid", message: "s3Url is the disk's S3 endpoint, an https URL", retryable: false, fields: [
      { field: "s3Url", reason: "invalid", message: "s3Url is the disk's S3 endpoint, an https URL" },
      { field: "keys.ARCHIL_API_KEY", reason: "wrong_type", message: "ARCHIL_API_KEY is a non-empty string, or null to remove it" },
    ] } };
    const { v2 } = server([off], () => json(422, refusal));
    const { host, input, click, type, submit } = await open(v2);
    await click(/^Paste$/, host.querySelector('li[data-secret="workspace:archil"]')!);
    await type("ARCHIL_API_KEY", " ");
    await type("diskId", "dsk-test-1");
    await type("region", "aws-us-east-1");
    await type("s3Url", "http://s3.example.test");
    await submit();
    const said = (name: string) => input(name).closest("label")!.querySelector("[role=alert]")?.textContent;
    expect(said("s3Url")).toBe("s3Url is the disk's S3 endpoint, an https URL");
    expect(said("ARCHIL_API_KEY")).toBe("ARCHIL_API_KEY is a non-empty string, or null to remove it");
    expect(input("diskId").value).toBe("dsk-test-1");
    expect(host.querySelector("[data-archil-state]")?.textContent).toBe("Off");
  });

  it("tests Archil: the server's detail, or its why as given", async () => {
    const why = "Archil has no disk dsk-test-1 in aws-us-east-1: check the disk and region, then test again.";
    let ok = false;
    const { v2, calls } = server([on], () => json(200, ok ? { ok: true, detail: "the disk dsk-test-1 answered its root listing" } : { ok: false, why }));
    const { host, click } = await open(v2);
    await click(/^Test$/);
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/v2/workspace/archil/test" });
    expect(host.querySelector("[data-test]")?.textContent).toMatch(new RegExp(`^Failed · .+ · ${why.replace(/[.]/g, "\\.")}$`));
    ok = true;
    await click(/^Test$/);
    expect(host.querySelector("[data-test]")?.textContent).toMatch(/^Passed · .+ · the disk dsk-test-1 answered its root listing$/);
  });

  it("says a write refused off the owner's session in the server's words", async () => {
    const words = "only the owner's password session changes a secret";
    const { v2 } = server([on], () => json(403, { error: { code: "forbidden", message: words, retryable: false } }));
    const { host, submit } = await open(v2);
    await submit();
    expect(host.querySelector("[role=alert]")?.textContent).toBe(`forbidden: ${words}`);
  });

  it("removes the key after asking: the fields as they are, and the key null", async () => {
    const { v2, calls } = server([on], () => json(200, { ...on, secret: secret(false) }));
    const { host, click } = await open(v2);
    await click(/^Remove$/, host.querySelector('li[data-secret="workspace:archil"]')!);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    const confirm = host.querySelector("[data-confirm-key]")!;
    expect(confirm.textContent).toContain("Remove ARCHIL_API_KEY saved on this server?");
    await click(/^Remove$/, confirm);
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ diskId: "dsk-test-1", region: "aws-us-east-1", s3Url: "https://s3.example.test", keys: { ARCHIL_API_KEY: null } });
    expect(host.querySelector('li[data-secret="workspace:archil"]')!.textContent).toContain("Missing");
  });

  it("turns Archil off only after a confirm, with DELETE, and keeps the key", async () => {
    const { v2, calls } = server([on], (c) => json(200, c.method === "DELETE" ? { on: false, secret: secret(true) } : on));
    const { host, click } = await open(v2);
    await click(/^Turn off$/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    const confirm = host.querySelector("[data-confirm]")!;
    expect(confirm.textContent).toContain("Turn Archil off?");
    await click(/^Turn off$/, confirm);
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([{ method: "DELETE", path: "/v2/workspace/archil", type: "application/json", body: undefined }]);
    expect(host.querySelector("[data-archil-state]")?.textContent).toBe("Off");
    expect(host.querySelector('li[data-secret="workspace:archil"]')!.textContent).toContain("Set");
  });

  it("off the owner's password session, says once how to change keys and has no key input; the disk fields save without keys", async () => {
    const { v2, calls } = server([on]);
    const { host, button, submit } = await open(v2, false);
    expect([...host.querySelectorAll("[role=status]")].map((s) => s.textContent)).toEqual([SIGN_IN_TO_CHANGE]);
    expect(host.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect(button(/^(Paste|Replace|Remove)$/)).toBeUndefined();
    expect(host.querySelector('li[data-secret="workspace:archil"]')!.textContent).toContain("Set");
    await submit();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ diskId: "dsk-test-1", region: "aws-us-east-1", s3Url: "https://s3.example.test" });
  });

  it("on the owner's password session, has no sign-in note", async () => {
    const { v2 } = server([off]);
    const { host } = await open(v2);
    expect(host.textContent).not.toContain(SIGN_IN_TO_CHANGE);
  });

  it("has no Turn off while Archil is off", async () => {
    const { v2 } = server([off]);
    const { button } = await open(v2);
    expect(button(/^Turn off$/)).toBeUndefined();
  });

  it("says a failed read in the server's words, and reads again on Try again", async () => {
    const down = json(500, { error: { code: "internal", message: "the store is busy", retryable: true } });
    const { v2, calls } = server([down, off]);
    const { host, click } = await open(v2);
    expect(host.querySelector("[role=alert]")?.textContent).toContain("Archil's settings could not be read: internal: the store is busy");
    await click(/^Try again$/);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
    expect(host.querySelector("[data-archil-state]")?.textContent).toBe("Off");
  });
});
