import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentPage } from "./AgentPage";
import { RunDetail } from "./RunDetail";
import { RunHeader } from "./RunHeader";
import { messageFeatures, recorded } from "@/fixtures";
import { createClient } from "@/lib/client";

// The demo, end to end on recorded answers: the console's own client and pages over what a faux AgentRun Server answered
// to the same story (src/fixtures/README.md, "learning.*"). An agent learned over six runs; a person opens its Learning
// tab, edits a note that someone else changed meanwhile (412: the newest loads, the edit is kept), saves it on the newest
// version (first refused by the checks, 400, then saved), and retires their own note. Then an agent with no notes turns
// learning on from its empty tab. Every write names the version the person saw (the card's own etag, never read again),
// as the server checked it.
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

async function mount(v2: ReturnType<typeof createClient>, agentId: string) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentPage, { v2, agentId, tab: "learning", learning: "on", go: () => {} })));
  await settle();
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.getAttribute("aria-label") ?? b.textContent ?? "").trim()));
  const click = async (label: RegExp) => { const b = button(label); expect(b, String(label)).toBeTruthy(); await act(async () => { b!.click(); }); await settle(); };
  const card = (name: string) => host.querySelector(`article[aria-label="${name}"]`) as HTMLElement | null;
  const editor = () => host.querySelector('section[aria-label="Edit note"]') as HTMLElement | null;
  const type = async (el: HTMLTextAreaElement, value: string) => {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const save = async () => { await act(async () => { editor()!.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); }); await settle(); };
  return { host, button, click, card, editor, type, save, text: () => host.textContent ?? "" };
}

const FIRST = "Try /policies/refund-policy first";
const MINE = "Keep the summary to three lines";

describe("demo: a person and an agent's notes, on a faux server's recorded answers", () => {
  it("reads what the agent learned, edits a note that changed meanwhile, saves it on the newest version, and retires one", async () => {
    // The note's own read comes only after the refused save, for its newest version: the edit and the retire are made on
    // the cards' versions.
    const s = replay(["learning.agent", "learning.stats", "learning.view", "learning.view-edited", "learning.view-retired", "learning.runs",
      "learning.note-newest", "learning.note-stale", "learning.note-refused", "learning.note-saved", "learning.mine-retired"]);
    const page = await mount(s.v2, "refund-finder");

    // What learning changed: the runs before its first note against the runs that started from one, as the server said.
    const impact = recorded<{ impact: { before: { runs: number }; after: { runs: number } } }>("learning.view").body.impact;
    expect(impact.before.runs).toBe(2);
    const since = page.host.querySelector('section[aria-label^="Since it learned (on 4 runs): answers in "]')!;
    // The time to the answer, the job's own cost and what learning itself costs a run, each as the server measured it.
    expect(since.getAttribute("aria-label")).toMatch(/ · learning itself \$[0-9.]+ est\. a run$/);
    // What it learned: two notes in use, where each came from, how many runs used each, and the note the second replaced.
    expect(page.text()).toContain("2 notes in use. Every later run reads them before it starts.");
    const first = page.card(FIRST)!;
    expect(first.textContent).toContain("It answered at once on Taylor Stitch and Brooklinen.");
    // The run it was learned in, its title cut short with its end kept, whole in its tooltip.
    const source = first.querySelector('a[href^="#/runs/"]')!;
    expect(source.textContent).toBe("Find this shop's…brooklinen.com");
    expect(source.getAttribute("title")).toBe("Find this shop's refund policy page: https://www.brooklinen.com");
    // Who changed it, as the server names it (last_change): the person's own note, created by them.
    expect(page.card(MINE)!.textContent).toMatch(/Created by you · \S/);
    // The later runs were given both notes whole under # Learned and read neither: a note counts as used only when a run
    // reads it with the read tool (serve's learning-run.ts noteUsed), so no card says "Used in".
    expect(first.textContent).not.toContain("Used in");
    expect(page.card(MINE)!.textContent).not.toContain("Used in");
    expect(page.text()).toContain("Earlier notes1 no longer read");
    // What runs kept nothing, and why: Kith's note about its own portal, and three runs with nothing new.
    const notKept = page.host.querySelector('section[aria-label="Kept nothing"]')!;
    expect(notKept.querySelector("li")!.textContent).toContain("https://www.kith.com");
    // In the server's own words, from the agent's run list: why Kith's note was not kept.
    expect(notKept.querySelector("li")!.textContent).toContain("It's about one shop's returns portal, not a rule other shops share.");
    expect(notKept.textContent).toContain("3 more runs had nothing new to remember.");

    // Edit: the note opens on the version its card showed; someone else saved a change meanwhile, so the save is refused.
    await page.click(/^Edit Try/);
    const opened = recorded<string>("learning.note");
    const card = recorded<{ notes: { items: { file: string; etag: string }[] } }>("learning.view").body.notes.items.find((x) => x.file === "try-policies-refund-policy-first.md")!;
    expect(card.etag).toBe(opened.headers!.etag);
    expect(page.editor()!.querySelector("textarea")!.value).toContain("It answered at once on Taylor Stitch and Brooklinen.");
    await page.type(page.editor()!.querySelector("textarea")!, "Open `https://<shop>/policies/refund-policy` first.\n\n**How to apply:** fetch it before any search, every time.\n");
    await page.save();
    expect(page.text()).toContain("Changed since you opened it");
    expect(page.editor()!.querySelector("textarea")!.value).toContain("Taylor Stitch, Brooklinen and Allbirds");
    expect(page.editor()!.querySelector("pre")!.textContent).toContain("every time");

    // Saved again on the newest: a hidden character is refused by the server's checks, then the clean text is saved.
    const body = page.editor()!.querySelector("textarea")!;
    await page.type(body, body.value.replace(/\*\*How to apply:\*\*[\s\S]*$/, "**How to apply:** fetch it before any search, every​time.\n"));
    await page.save();
    expect(page.text()).toContain("Not saved: the note doesn't pass the checks.");
    const refusal = recorded<{ error: { problems: { detail: string }[] } }>("learning.note-refused").body.error.problems[0].detail;
    expect(page.text()).toContain(refusal);
    await page.type(page.editor()!.querySelector("textarea")!, page.editor()!.querySelector("textarea")!.value.replace("every​time", "every time"));
    await page.save();
    expect(page.editor()).toBeNull();
    expect(page.card(FIRST)!.textContent).toContain("fetch it before any search, every time.");
    expect(page.card(FIRST)!.textContent).toContain("Edited by you");

    // Retire their own note, after the confirm: it leaves the notes in use and shows under Earlier notes.
    await page.click(/^Retire Keep/);
    expect(page.text()).toContain("Retire it? Later runs stop reading it. It stays under Earlier notes.");
    await page.click(/^Yes, retire$/);
    expect(page.card(MINE)).toBeNull();
    expect(page.text()).toContain("1 note in use.");
    await page.click(/^Earlier notes/);
    expect(page.host.querySelector('section[aria-label="Earlier notes"]')!.textContent).toContain(`${MINE}Retired`);

    // Every write named the version the person saw, as JSON (the one write the server takes under a session), and the
    // note was read only for its newest version after the refused save.
    expect(s.mismatches).toEqual([]);
    const firstPut = s.sent.findIndex((x) => x.method === "PUT");
    expect(s.sent.slice(0, firstPut).some((x) => x.path.endsWith(".md"))).toBe(false);
    expect(s.sent.filter((x) => x.method === "GET" && x.path.endsWith(".md")).map((x) => x.path)).toEqual(["/agents/refund-finder/learning/files/try-policies-refund-policy-first.md"]);
    const writes = s.sent.filter((x) => x.method !== "GET");
    expect(writes.map((w) => `${w.method} ${w.path} ${w.headers["if-match"]}`)).toEqual([
      `PUT /agents/refund-finder/learning/files/try-policies-refund-policy-first.md ${opened.headers!.etag}`,
      `PUT /agents/refund-finder/learning/files/try-policies-refund-policy-first.md ${recorded("learning.note-newest").headers!.etag}`,
      `PUT /agents/refund-finder/learning/files/try-policies-refund-policy-first.md ${recorded("learning.note-newest").headers!.etag}`,
      `POST /agents/refund-finder/learning/files/keep-it-to-three-lines.md/retire ${recorded("learning.mine").headers!.etag}`,
    ]);
    for (const w of writes.slice(0, 3)) {
      expect(w.headers["content-type"]).toBe("application/json");
      expect(Object.keys(w.body as object)).toEqual(["text"]);
      expect((w.body as { text: string }).text).toMatch(/^---\nname: Try \/policies\/refund-policy first\ndescription: .+\ntype: feedback\nsupersedes: \[shopify-refund-policy-path\.md\]\n---\n/);
    }
    expect(s.sent.find((x) => x.path.endsWith(".md"))!.headers.accept).toBe("text/markdown, application/json");
  });

  it("an agent with no notes turns learning on from its empty tab: a new revision, and the tab says nothing is learned yet", async () => {
    const s = replay(["learning.off-agent", "learning.stats", "learning.off-view", "learning.off-runs", "learning.off-switch"]);
    const page = await mount(s.v2, "release-notes");
    expect(page.text()).toContain("Learning is off for this agent.");
    expect(page.text()).toContain("rev 1 of 1");
    await act(async () => { (page.host.querySelector('[role="switch"]') as HTMLButtonElement).click(); });
    await settle();
    expect(s.mismatches).toEqual([]);
    const put = s.sent.find((x) => x.method === "PUT")!;
    expect(put.path).toBe("/agents/release-notes/definition");
    expect(put.body).toMatchObject({ definition: { learning: true, version: 2 }, note: "Learning on" });
    expect(page.text()).toContain("rev 2 of 2");
    expect(page.text()).toContain("Nothing learned yet");
    // Its tools have no write tool, and it needs none: the tab asks for no tool.
    expect(page.text()).not.toMatch(/write tool/i);
  });

  it("a run's header says what it read and kept, each a link to those notes in the agent's Learning tab", async () => {
    const s = replay(["learning.run-brooklinen", "learning.run-allbirds"]);
    const brooklinen = recorded<{ run_id: string }>("learning.run-brooklinen").body.run_id;
    const allbirds = recorded<{ run_id: string }>("learning.run-allbirds").body.run_id;
    const header = async (id: string) => renderToStaticMarkup(createElement(RunHeader, { run: await s.v2.getRun(id), agentName: "Refund policy finder" }));
    const b = await header(brooklinen);
    // Each run was given its notes whole and read none, so no run says it used one (serve's learning-run.ts noteUsed
    // counts only a note read with the read tool): Brooklinen's header says what it learned, Allbirds' says nothing.
    expect(b).not.toContain('aria-label="Used');
    expect(b).toContain('aria-label="Learned 1 note: Try /policies/refund-policy first (replaces 1 older note)"');
    expect(b).toContain('href="#/agents/refund-finder/learning?note=try-policies-refund-policy-first.md"');
    const a = await header(allbirds);
    expect(a).not.toContain('aria-label="Used');
    expect(a).not.toContain("Learned");
  });
  it("a run's page says what its learning changed, note by note, from the server's own answer", async () => {
    const s = replay(["learning.diff-run", "learning.diff"]);
    const id = recorded<{ run_id: string }>("learning.diff-run").body.run_id;
    const run = await s.v2.getRun(id);
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(createElement(RunDetail, { run, agentName: "Refund policy finder", messages: messageFeatures, harnessSteers: true, rows: [], files: [], tab: "report", readLearningDiff: () => s.v2.runLearningDiff(id) })));
    for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(s.sent.map((x) => `${x.method} ${x.path}`)).toEqual([`GET /runs/${id}`, `GET /runs/${id}/learning/diff`]);
    const said = [...host.querySelectorAll('section[aria-label="What it changed"] [data-said]')].map((x) => x.textContent);
    expect(said).toEqual(["Added: Try /policies/refund-policy first", "Replaced: Shopify refund policy path → Try /policies/refund-policy first"]);
    act(() => root.unmount());
  });
});
