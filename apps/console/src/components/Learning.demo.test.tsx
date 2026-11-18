import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentPage } from "./AgentPage";
import { RunDetail } from "./RunDetail";
import { messageFeatures, recorded } from "@/fixtures";
import { createClient } from "@/lib/client";

// The demo, end to end on recorded answers: the console's own client and pages over what a faux AgentRun Server answered
// (src/fixtures/README.md, "learning.*"). An agent with nothing learned turns learning on from its empty tab, and a run's
// page says what its learning changed, file by file.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Rec = { request: { method: string; path: string; headers?: Record<string, string>; body?: unknown }; status: number; headers?: Record<string, string>; body: unknown };
type Sent = { method: string; path: string; headers: Record<string, string>; body: unknown };

/** A server that answers each request with the recorded answers to it, in the order they were recorded (the last one
 *  again once they run out), and keeps what the console sent. A write whose If-Match is not the recorded one is a
 *  mismatch: the console did not send the version the server was asked about. */
function replay(names: string[]) {
  const queue = new Map<string, Rec[]>();
  const keyOf = (method: string, path: string) => `${method} ${path.split("?")[0]}`;
  for (const n of names) {
    const r = recorded<unknown>(n) as unknown as Rec;
    const k = keyOf(r.request.method, r.request.path);
    queue.set(k, [...(queue.get(k) ?? []), r]);
  }
  const sent: Sent[] = [];
  const mismatches: string[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(String(url), "http://serve.test");
    const method = init.method ?? "GET";
    const path = u.pathname.replace(/^\/v2/, "");
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    sent.push({ method, path, headers, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const q = queue.get(keyOf(method, path));
    if (!q) return new Response(JSON.stringify({ error: { code: "not_found", message: `nothing recorded for ${method} ${path}` } }), { status: 404, headers: { "content-type": "application/json" } });
    const r = q.length > 1 ? q.shift()! : q[0];
    const want = r.request.headers?.["if-match"];
    if (want !== undefined && headers["if-match"] !== want) mismatches.push(`${method} ${path}: sent ${headers["if-match"]}, recorded ${want}`);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), sent, mismatches };
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

describe("demo: an agent's learning, on a faux server's recorded answers", () => {
  it("an agent with nothing learned turns learning on from its empty tab: a new revision, and the tab says nothing is learned yet", async () => {
    // The agent is read by the page, again by the switch before its save (the same answer both times), and again after the
    // save, now on its new revision.
    const s = replay(["learning.off-agent", "learning.off-agent", "learning.stats", "learning.off-view", "learning.off-runs", "learning.off-switch", "learning.off-agent-after"]);
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentPage, { v2: s.v2, agentId: "release-notes", tab: "learning", learning: "on", go: () => {} })));
    await settle();
    const text = () => host.textContent ?? "";
    expect(text()).toContain("Learning is off for this agent.");
    expect(text()).toContain("rev 1 of 1");
    await act(async () => { (host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
    await settle();
    expect(s.mismatches).toEqual([]);
    const put = s.sent.find((x) => x.method === "PUT")!;
    expect(put.path).toBe("/agents/release-notes/definition");
    expect(put.body).toMatchObject({ definition: { learning: true, version: 2 }, note: "Learning on" });
    expect(text()).toContain("rev 2 of 2");
    expect(text()).toContain("Nothing learned yet");
    // Its tools have no write tool, and it needs none: the tab asks for no tool.
    expect(text()).not.toMatch(/write tool/i);
  });

  it("a run's page says what its learning changed, file by file, from the server's own answer", async () => {
    const s = replay(["learning.diff-run", "learning.diff"]);
    const id = recorded<{ run_id: string }>("learning.diff-run").body.run_id;
    const run = await s.v2.getRun(id);
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(RunDetail, { run, agentName: "Refund policy finder", messages: messageFeatures, harnessSteers: true, rows: [], files: [], tab: "report", readLearningDiff: () => s.v2.runLearningDiff(id) })));
    await settle();
    expect(s.sent.map((x) => `${x.method} ${x.path}`)).toEqual([`GET /runs/${id}`, `GET /runs/${id}/learning/diff`]);
    const said = [...host.querySelectorAll('section[aria-label="What it changed"] [data-said]')].map((x) => x.textContent);
    expect(said).toEqual(["Added: workflow find-refund-policy", "Changed: corrections"]);
  });
});
