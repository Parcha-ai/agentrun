import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { golden } from "./golden.fixture";
import { VerdictCard } from "@/components/NodeDrawer";
import type { Decision } from "@/lib/runGraph";
import { HostedSharePage } from "./SharePage";
import { shareIdOf, storedSource, type ShareBundle, type ShareLoad, type ShareSource } from "./bundle";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); });

const bundle: ShareBundle = golden;
const ID = "abcdefghijklmnopqrstuvwxyz";
// Words of the run that must never show on a refusal.
const RUN_TEXT = ["Golden agent", "Done. Mail", "out/report.md", "[redacted:"];
const answer = (status: number, body = "") => new Response(body, { status, headers: { "content-type": "application/json" } });

async function mount(element: ReturnType<typeof createElement>) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(element));
  return host;
}
const fixed = (load: ShareLoad): ShareSource => ({ load: async () => load });

describe("shareIdOf: the share a share host's address names", () => {
  it("is /r/<id> with or without a trailing slash, an id of 26 base32 letters, and nothing else", () => {
    expect(shareIdOf(`/r/${ID}`)).toBe(ID);
    expect(shareIdOf(`/r/${ID}/`)).toBe(ID);
    for (const path of ["/r/", "/r/_assets/x.js", `/r/${ID}/bundle.json`, `/r/${ID.toUpperCase()}`, "/r/abc", `/share/${ID}`, `/x/r/${ID}`, `/r/${ID}1`]) expect(shareIdOf(path)).toBeNull();
  });
});

describe("storedSource: the stored bundle, and no other read", () => {
  it("asks GET /r/<id>/bundle.json with no credential, and ignores restores", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => answer(200, JSON.stringify(golden)));
    vi.stubGlobal("fetch", fetch);
    expect(await storedSource({ shareId: ID }).load(["c_05af703d64842a4a"], new AbortController().signal)).toEqual({ ok: true, bundle });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([`/r/${ID}/bundle.json`]);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "GET", credentials: "omit" });
  });

  it("a refusal is its status; a 200 that is no bundle is a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(410, JSON.stringify({ error: { code: "purged", message: "words" } }))));
    expect(await storedSource({ shareId: ID }).load([], new AbortController().signal)).toEqual({ ok: false, status: 410 });
    vi.stubGlobal("fetch", vi.fn(async () => answer(200, JSON.stringify({ format: "other" }))));
    expect(await storedSource({ shareId: ID }).load([], new AbortController().signal)).toEqual({ ok: false, status: 500 });
  });
});

describe("HostedSharePage: a share host's public page", () => {
  it("draws the stored bundle with no cuts panel, no switch and no publish command", async () => {
    const host = await mount(createElement(HostedSharePage, { source: fixed({ ok: true, bundle }) }));
    expect(host.querySelector("h1")?.textContent).toBe(bundle.run.title);
    expect(host.textContent).toContain("Golden agent");
    expect(host.querySelector('[aria-label="Cuts"], [role="switch"]')).toBeNull();
    expect(host.textContent).not.toContain("agentrun share");
    expect(host.textContent).toContain("shared run");
  });

  it.each([
    [404, /no share at this address/i],
    [410, /deleted/i],
    [0, /can't reach/i],
    [500, /can't be shown/i],
  ])("a %i says why and shows nothing of the run", async (status, words) => {
    const host = await mount(createElement(HostedSharePage, { source: fixed({ ok: false, status }) }));
    expect(host.textContent).toMatch(words);
    for (const text of RUN_TEXT) expect(host.textContent).not.toContain(text);
  });

  it("the whole page reads /r/<id>/bundle.json and nothing else", async () => {
    const fetch = vi.fn(async () => answer(200, JSON.stringify(golden)));
    vi.stubGlobal("fetch", fetch);
    await mount(createElement(HostedSharePage, { source: storedSource({ shareId: ID }) }));
    expect(fetch.mock.calls.map((c) => (c as unknown[])[0])).toEqual([`/r/${ID}/bundle.json`]);
  });
});

describe("VerdictCard offline: a public page loads no image from elsewhere", () => {
  const decision = { id: "d1", node: "judge", status: "answered", provider: "parallel", answers: {}, questions: {}, images: [{ token: "img1", ref: "", url: "https://images.example/page.png" }] } as unknown as Decision;
  it("falls back to the provider's http URL on the owner's console, and never offline", async () => {
    const online = await mount(createElement(VerdictCard, { d: decision, fileUrl: () => "", zoom: () => {} }));
    expect(online.querySelector("img")?.getAttribute("src")).toBe("https://images.example/page.png");
    act(() => root?.unmount());
    document.body.innerHTML = "";
    const offline = await mount(createElement(VerdictCard, { d: decision, fileUrl: () => "", zoom: () => {}, offline: true }));
    expect(offline.querySelector("img")).toBeNull();
    expect(offline.innerHTML).not.toContain("images.example");
  });
});
