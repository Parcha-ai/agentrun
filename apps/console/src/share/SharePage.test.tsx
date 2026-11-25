import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { golden } from "./fixtures/golden";
import { SharePage } from "./SharePage";
import { exportSource, runIdOf, type ShareBundle, type ShareLoad, type ShareSource } from "./bundle";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); });

const bundle: ShareBundle = golden;
// Words of the run that must never show on a refusal: its title, its agent, its answer, its steps, a file.
const RUN_TEXT = ["PGPASSWORD", "Golden agent", "Done. Mail", "The host", "held again", "out/report.md", "[redacted:"];

/** The export as a server answers it: each restore id moves its cut to `restored`, and the sha changes with them. */
function fakeServer(answer?: (restore: readonly string[]) => ShareLoad | Promise<ShareLoad>) {
  const asked: string[][] = [];
  const source: ShareSource = {
    async load(restore) {
      asked.push([...restore]);
      if (answer) return answer(restore);
      const keep = new Set(restore);
      const restored = bundle.cuts.filter((c) => keep.has(c.id)).map(({ id, at, start, end, rule, kind }) => ({ id, at, start, end, rule, kind }));
      return { ok: true, bundle: { ...bundle, cuts: bundle.cuts.filter((c) => !keep.has(c.id)), restored, sha256: restore.length ? `sha-of-${[...restore].sort().join("+")}` : bundle.sha256 } };
    },
  };
  return { source, asked };
}

async function mount(source: ShareSource, runId = "run_golden") {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(SharePage, { source, runId })));
  return host;
}
const flip = async (host: HTMLElement, id: string) => {
  const button = host.querySelector<HTMLButtonElement>(`[data-cut="${id}"] [role="switch"]`);
  if (!button) throw new Error(`no switch for ${id}`);
  await act(async () => button.click());
};

describe("SharePage: the export, and a restore as an export again", () => {
  it("reads the export once with no restore, then draws it", async () => {
    const { source, asked } = fakeServer();
    const host = await mount(source);
    expect(asked).toEqual([[]]);
    expect(host.querySelector("h1")?.textContent).toBe(bundle.run.title);
  });

  it("each switch reads the export again with exactly the ids switched on, and the footer then names those ids and the new sha", async () => {
    const { source, asked } = fakeServer();
    const host = await mount(source);
    await flip(host, "c_05af703d64842a4a");
    expect(asked.at(-1)).toEqual(["c_05af703d64842a4a"]);
    await flip(host, "c_74b434b337661b96");
    expect([...asked.at(-1)!].sort()).toEqual(["c_05af703d64842a4a", "c_74b434b337661b96"]);
    await flip(host, "c_05af703d64842a4a");
    expect(asked.at(-1)).toEqual(["c_74b434b337661b96"]);
    expect(asked).toHaveLength(4);
    const command = host.querySelector("footer code")?.textContent;
    expect(command).toBe("agentrun share run_golden --restore c_74b434b337661b96 --expect sha-of-c_74b434b337661b96");
    expect(host.querySelector<HTMLElement>('[data-cut="c_74b434b337661b96"] [role="switch"]')?.getAttribute("aria-checked")).toBe("true");
  });

  it("a switch is only ever offered for a restorable cut, so no format, held or dump id is ever asked for", async () => {
    const { source, asked } = fakeServer();
    const host = await mount(source);
    for (const button of host.querySelectorAll<HTMLButtonElement>('[role="switch"]')) await act(async () => button.click());
    const kinds = new Map(bundle.cuts.map((c) => [c.id, c.kind]));
    for (const ids of asked) for (const id of ids) expect(["label", "personal"]).toContain(kinds.get(id));
  });

  it.each([
    [409, /hasn't ended/i],
    [403, /withheld/i],
    [500, /failed closed/i],
    [404, /no run run_golden/i],
    [401, /not signed in/i],
    [413, /over 8 MiB/i],
  ])("a %i shows its reason and nothing of the run", async (status, words) => {
    const { source } = fakeServer(() => ({ ok: false, status }));
    const host = await mount(source);
    const text = host.textContent ?? "";
    expect(text).toMatch(words);
    for (const words of RUN_TEXT) expect(text).not.toContain(words);
    expect(host.querySelector("h1")?.textContent).not.toBe(bundle.run.title);
    expect(host.querySelector('[role="switch"], footer code')).toBeNull();
  });

  it("a server that can't be reached shows that and nothing of the run", async () => {
    const { source } = fakeServer(() => { throw new TypeError("Failed to fetch"); });
    const host = await mount(source);
    expect(host.textContent).toMatch(/can't reach/i);
    for (const words of RUN_TEXT) expect(host.textContent).not.toContain(words);
  });

  it("a restore whose export then fails takes the run off the page: the earlier bundle is not what would ship", async () => {
    let calls = 0;
    const ok = fakeServer();
    const { source } = fakeServer((restore) => (calls++ === 0 ? ok.source.load(restore, new AbortController().signal) : { ok: false, status: 500 }));
    const host = await mount(source);
    expect(host.textContent).toContain("Golden agent");
    await flip(host, "c_05af703d64842a4a");
    expect(host.textContent).toMatch(/failed closed/i);
    for (const words of RUN_TEXT) expect(host.textContent).not.toContain(words);
  });
});

describe("exportSource: the owner's own export, and no other read", () => {
  const answer = (status: number, body = "") => new Response(body, { status, headers: { "content-type": "application/json" } });

  it("asks GET /v2/runs/<id>/export, same-origin with the session, and ?restore= with the ids comma-separated", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => answer(200, JSON.stringify(golden)));
    vi.stubGlobal("fetch", fetch);
    const source = exportSource({ runId: "run_golden" });
    const first = await source.load([], new AbortController().signal);
    expect(first).toEqual({ ok: true, bundle });
    await source.load(["c_05af703d64842a4a", "c_74b434b337661b96"], new AbortController().signal);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(["/v2/runs/run_golden/export", "/v2/runs/run_golden/export?restore=c_05af703d64842a4a,c_74b434b337661b96"]);
    for (const call of fetch.mock.calls) expect(call[1]).toMatchObject({ credentials: "same-origin", method: "GET" });
  });

  it("a base puts the API under it; a refusal is its status, never its body", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => answer(409, JSON.stringify({ error: { code: "run_not_final", message: "words" } })));
    vi.stubGlobal("fetch", fetch);
    expect(await exportSource({ runId: "run 1", base: "/under" }).load([], new AbortController().signal)).toEqual({ ok: false, status: 409 });
    expect(fetch.mock.calls[0]![0]).toBe("/under/v2/runs/run%201/export");
  });

  it("a 200 that is not a share bundle is a failure, not a page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(200, JSON.stringify({ format: "something/else" }))));
    expect(await exportSource({ runId: "r" }).load([], new AbortController().signal)).toEqual({ ok: false, status: 500 });
    vi.stubGlobal("fetch", vi.fn(async () => answer(200, "not json")));
    expect(await exportSource({ runId: "r" }).load([], new AbortController().signal)).toEqual({ ok: false, status: 500 });
  });

  it("the whole page, mounted on the export, reads the export and nothing else", async () => {
    const fetch = vi.fn(async () => answer(200, JSON.stringify(golden)));
    vi.stubGlobal("fetch", fetch);
    const host = await mount(exportSource({ runId: "run_golden" }));
    for (const name of [/timeline/i, /files/i, /report/i]) {
      const button = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => name.test(b.textContent ?? ""))!;
      await act(async () => button.click());
    }
    expect(fetch.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["/v2/runs/run_golden/export"]);
  });
});

describe("runIdOf: the run a page's address names", () => {
  it("reads /share/<run>, and nothing else", () => {
    expect(runIdOf("/share/run_abc123")).toBe("run_abc123");
    expect(runIdOf("/share/run_abc123/")).toBe("run_abc123");
    for (const path of ["/share/", "/share", "/", "/share/a/b", "/share/..", "/share/%2e%2e", "/r/run_abc"]) expect(runIdOf(path), path).toBeNull();
  });
});
