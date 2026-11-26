import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { LocalModelCard, localModelState, machineLine } from "./LocalModelCard";
import { createClient } from "@/lib/client";
import type { LocalModel } from "@/lib/v2";

// The first screen's "Free local model" card, over GET /v2/settings/local-model and POST .../pull: its five faces
// (unknown, recommend, pulling, ready, none), the pull's progress read until it ends, and the capabilities read again once.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GIB = 1024 ** 3;
const LINUX: LocalModel["machine"] = { platform: "linux", arch: "x64", ram_bytes: 32 * GIB, gpu: { kind: "unknown" } };
const base = (over: Partial<LocalModel> = {}): LocalModel => ({
  machine: LINUX,
  ollama: { asked: true, reachable: true, version: "0.40.17" },
  recommended: { tag: "qwen3:8b", why: "qwen3:8b fits this machine's 32.0 GiB of memory (it needs 15 GiB).", pulled: false },
  pull: null,
  can_pull: true,
  refused: null,
  ...over,
});
const pulling = (completed: number): LocalModel => base({ pull: { tag: "qwen3:8b", state: "pulling", status: "pulling 000000000000", completed_bytes: completed, total_bytes: 5 * GIB } });
const done = base({ pull: { tag: "qwen3:8b", state: "done", status: "success", completed_bytes: 5 * GIB, total_bytes: 5 * GIB } });

type Call = { method: string; path: string; body: unknown };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** A server whose GETs answer `reads` in turn (the last one again once they run out), and whose POST answers `pulled`. */
function server(reads: (LocalModel | Response)[], pulled?: LocalModel) {
  const calls: Call[] = [];
  let n = 0;
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: new URL(String(url), "http://console").pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (call.method === "POST") return json(202, pulled);
    const next = reads[Math.min(n++, reads.length - 1)]!;
    return next instanceof Response ? next : json(200, next);
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls };
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

async function open(v2: ReturnType<typeof createClient>, props: { onReady?: (tag: string) => void; onDone?: () => void; onPulling?: () => void } = {}) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(LocalModelCard, { v2, pollMs: 0, ...props })));
  const settle = async () => { for (let i = 0; i < 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  const face = () => host.querySelector("[data-local-model]")?.getAttribute("data-local-model");
  return { host, button, face, settle };
}

describe("LocalModelCard", () => {
  it("unknown: says it is reading the machine until the answer comes", async () => {
    let answer: (r: Response) => void = () => {};
    const fetch = (() => new Promise<Response>((resolve) => { answer = resolve; })) as typeof globalThis.fetch;
    const card = await open(createClient({ fetch }));
    expect(card.face()).toBe("unknown");
    expect(card.host.querySelector('[role="status"]')?.textContent).toBe("Reading this machine…");
    expect(card.button(/^Pull/)).toBeUndefined();
    await act(async () => { answer(json(200, base())); });
    await card.settle();
    expect(card.face()).toBe("recommend");
  });

  it("recommend: the machine in one line, the tag and its why, and a Pull button", async () => {
    const { v2 } = server([base()]);
    const card = await open(v2);
    expect(card.face()).toBe("recommend");
    expect(card.host.querySelector("[data-machine]")?.textContent).toBe("Linux x64 · 32.0 GB memory · GPU not read · Ollama 0.40.17");
    expect(card.host.textContent).toContain("qwen3:8b fits this machine's 32.0 GiB");
    expect(card.button(/^Pull qwen3:8b$/)).toBeDefined();
  });

  it("pulling: one click pulls the recommended tag, its progress shown until done; then ready, the capabilities read again once", async () => {
    const { v2, calls } = server([base(), pulling(2 * GIB), pulling(4 * GIB), done], pulling(0));
    const readied: string[] = [];
    const card = await open(v2, { onReady: (tag) => { readied.push(tag); } });
    let bars: number[] = [];
    const seen = new MutationObserver(() => {
      const bar = card.host.querySelector('[role="progressbar"]');
      if (bar) bars.push(Number(bar.getAttribute("aria-valuenow")));
    });
    seen.observe(card.host, { subtree: true, attributes: true, childList: true });
    await act(async () => { card.button(/^Pull qwen3:8b$/)!.click(); });
    await card.settle();
    seen.disconnect();
    bars = [...new Set(bars)];
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: "/v2/settings/local-model/pull", body: { tag: "qwen3:8b" } }]);
    expect(bars).toEqual([0, 40, 80]);
    expect(card.face()).toBe("ready");
    expect(card.host.textContent).toContain("Ready: qwen3:8b runs here on this machine, at $0");
    expect(readied).toEqual(["qwen3:8b"]);
    expect(card.button(/^Pull/)).toBeUndefined();
  });

  it("pulling: says the pull is under way (onPulling) as soon as it sees one, a pull it started or one under way when it opens", async () => {
    const started = server([base(), pulling(2 * GIB), done], pulling(0));
    let told = 0;
    const card = await open(started.v2, { onPulling: () => { told++; } });
    expect(told).toBe(0);
    await act(async () => { card.button(/^Pull qwen3:8b$/)!.click(); });
    await card.settle();
    expect(told).toBe(1);
    act(() => root?.unmount()); document.body.innerHTML = "";
    const already = server([pulling(GIB), done], pulling(0));
    let seen = 0;
    await open(already.v2, { onPulling: () => { seen++; } });
    expect(seen).toBe(1);
  });

  it("pulling: a progress read that fails is followed by another, so the card still reaches ready", async () => {
    const dropped = json(502, { error: { code: "bad_gateway", message: "upstream dropped", retryable: true } });
    const { v2 } = server([base(), pulling(2 * GIB), dropped, done], pulling(0));
    const readied: string[] = [];
    const card = await open(v2, { onReady: (tag) => { readied.push(tag); } });
    await act(async () => { card.button(/^Pull qwen3:8b$/)!.click(); });
    await card.settle();
    expect(card.face()).toBe("ready");
    expect(readied).toEqual(["qwen3:8b"]);
  });
  it("pulling: a progress read refused (403, 404) hides the card and reads no more", async () => {
    for (const status of [403, 404]) {
      const refused = () => json(status, { error: { code: status === 404 ? "not_found" : "forbidden", message: "no", retryable: false } });
      const { v2, calls } = server([base(), pulling(2 * GIB), ...Array.from({ length: 40 }, refused)], pulling(0));
      const card = await open(v2);
      await act(async () => { card.button(/^Pull qwen3:8b$/)!.click(); });
      await card.settle();
      expect(card.host.innerHTML).toBe("");
      const gets = calls.filter((call) => call.method === "GET").length;
      await card.settle();
      expect(calls.filter((call) => call.method === "GET").length).toBe(gets);
      act(() => root?.unmount());
    }
  });
  it("pulling: the bar and Ollama's status with the bytes", async () => {
    const { v2 } = server([pulling(2 * GIB), done]);
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    // A slow poll, so the card is read as it pulls.
    await act(async () => { root!.render(createElement(LocalModelCard, { v2, pollMs: 60_000 })); });
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(host.querySelector("[data-local-model]")?.getAttribute("data-local-model")).toBe("pulling");
    expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("40");
    expect(host.textContent).toContain("pulling 000000000000 · 2.0 GB of 5.0 GB");
  });

  it("ready: a tag already pulled reads ready with no pull, and Done lets the card go", async () => {
    const { v2, calls } = server([base({ recommended: { tag: "qwen3:8b", why: "Already pulled: no pull needed.", pulled: true } })]);
    let dismissed = 0;
    const card = await open(v2, { onDone: () => { dismissed++; } });
    expect(card.face()).toBe("ready");
    expect(card.button(/^Pull/)).toBeUndefined();
    await act(async () => { card.button(/^Done$/)!.click(); });
    expect(dismissed).toBe(1);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("none: no Ollama, or nothing fits: the why, and no button", async () => {
    const { v2 } = server([base({ ollama: { asked: true, reachable: false, version: null }, recommended: { tag: null, why: "Ollama isn't running on this machine. Install it from https://ollama.com/download, start it, then come back here.", pulled: false } })]);
    const card = await open(v2);
    expect(card.face()).toBe("none");
    expect(card.host.textContent).toContain("Install it from https://ollama.com/download");
    expect(card.host.querySelector("[data-machine]")?.textContent).toContain("no Ollama running");
    expect(card.host.querySelectorAll("button")).toHaveLength(0);
  });

  it("a server that pulls nothing here says why in place of the button", async () => {
    const { v2 } = server([base({ can_pull: false, refused: "A local model is pulled from here only on one owner's own server on their own machine." })]);
    const card = await open(v2);
    expect(card.button(/^Pull/)).toBeUndefined();
    expect(card.host.textContent).toContain("only on one owner's own server");
  });

  for (const [under, refused] of [
    ["a model gateway", "This server sends every model to its model gateway (AGENT_MODEL_BASE_URL), so a local model would not run here."],
    ["the faux model", "This server runs the faux model, so no local model is pulled here."],
  ] as const) {
    it(`under ${under}, Ollama is not asked: the refusal's words alone, never that Ollama isn't running`, async () => {
      // The why says Ollama isn't running here on purpose: the card must not show it when Ollama was never asked.
      const { v2 } = server([base({ ollama: { asked: false, reachable: false, version: null }, recommended: { tag: null, why: "Ollama isn't running on this machine. Install it from https://ollama.com/download, start it, then come back here.", pulled: false }, can_pull: false, refused })]);
      const card = await open(v2);
      expect(card.face()).toBe("none");
      expect(card.host.textContent).toContain(refused);
      expect(card.host.textContent).not.toMatch(/isn't running|no Ollama running|ollama\.com\/download/);
      expect(card.host.querySelector("[data-machine]")?.textContent).toBe("Linux x64 · 32.0 GB memory · GPU not read");
      expect(card.host.querySelectorAll("button")).toHaveLength(0);
    });
  }

  it("a failed pull says so in Ollama's words, and offers the pull again", async () => {
    const { v2 } = server([base({ pull: { tag: "qwen3:8b", state: "failed", status: "pulling manifest", completed_bytes: 0, total_bytes: 0, error: "pull model manifest: file does not exist" } })]);
    const card = await open(v2);
    expect(card.face()).toBe("recommend");
    expect(card.host.querySelector('[role="alert"]')?.textContent).toBe("The pull failed: pull model manifest: file does not exist");
    expect(card.button(/^Try again$/)).toBeDefined();
  });

  it("a server without the route, or a caller who is not the owner, shows no card", async () => {
    for (const status of [404, 403]) {
      const { v2 } = server([json(status, { error: { code: status === 404 ? "not_found" : "forbidden", message: "no", retryable: false } })]);
      const card = await open(v2);
      expect(card.host.innerHTML).toBe("");
      act(() => root?.unmount());
    }
  });

  it("the machine line names Apple silicon and an NVIDIA card", () => {
    expect(machineLine(base({ machine: { platform: "darwin", arch: "arm64", ram_bytes: 16 * GIB, gpu: { kind: "apple", unified: true } } }))).toBe("macOS arm64 · 16.0 GB memory · Apple silicon, unified memory · Ollama 0.40.17");
    expect(machineLine(base({ machine: { platform: "win32", arch: "x64", ram_bytes: 64 * GIB, gpu: { kind: "nvidia", name: "Synth GPU 24", memory_bytes: 24 * GIB } } }))).toBe("Windows x64 · 64.0 GB memory · Synth GPU 24, 24.0 GB · Ollama 0.40.17");
    expect(localModelState(null)).toBe("unknown");
  });
});
