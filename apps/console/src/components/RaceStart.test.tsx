import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RaceStart } from "./RaceStart";
import { toolOffers } from "@/lib/agentForm";
import { createClient } from "@/lib/client";
import type { Places } from "@/lib/place";
import { laneStart } from "@/lib/race";

// #/races/new: the task, and 2 to 4 lanes (a harness and a model each, from the harnesses this server runs). Start sends
// one inline run per lane (POST /v2/runs), each under its own Idempotency-Key, then opens the race. A lane the server
// refuses says so in its own place, and the others start all the same.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });
const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const HARNESSES = [
  { id: "pi", available: true, default_model: "anthropic/claude-sonnet-5-5", models: ["anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5"] },
  { id: "codex", available: true, default_model: "openai/gpt-6.1-sol", models: ["openai/gpt-6.1-sol"] },
  { id: "opencode", available: false, reason: "No key here.", default_model: null, models: [] },
];
// The tools this server runs (capabilities `tools`): a lane gets a new agent's, by its harness and the server's place.
const TOOLS = toolOffers([
  { name: "read", available: true, harnesses: ["pi", "codex"] },
  { name: "write", available: true, harnesses: ["pi", "codex"] },
  { name: "bash", available: true, sandbox_only: true, harnesses: ["pi", "codex"] },
  { name: "web_search", available: true, harnesses: ["pi"] },
]);
const BOXED: Places = { modes: ["runner", "sandbox"], boxes: [{ id: "local", available: true }], defaultPlace: { mode: "sandbox", box: "local" } };
const LABEL = "20261123-1004-1f2e";
const TASK = "Fix the failing test in the parser";

type Sent = { lane: string; body: Record<string, unknown>; key: string };
/** A fake server: every POST /v2/runs recorded, answered by `answer` (202 with a run, or a refusal). `places`: the
 *  server's (capabilities `places`), none by default. */
function mount(answer: (sent: Sent) => Response | Promise<Response>, places: Places | null = null) {
  const sent: Sent[] = [];
  const went: string[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://serve.test").pathname;
    if (path !== "/v2/runs" || init?.method !== "POST") return json(404, { error: { code: "not_found", message: path, retryable: false } });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const one = { lane: (body.labels as Record<string, string>).lane, body, key: (init.headers as Record<string, string>)["idempotency-key"] };
    sent.push(one);
    return answer(one);
  }) as typeof globalThis.fetch;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(RaceStart, { v2: createClient({ fetch }), harnesses: HARNESSES, tools: TOOLS, places, go: (to: string) => void went.push(to), label: LABEL })));
  return { host, sent, went };
}
const started = (sent: Sent) => json(202, { run_id: `run-${sent.lane}`, agent_id: `agent-${sent.lane}`, status: "queued", state: "working", labels: sent.body.labels });
const button = (host: Element, label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
async function type(host: Element, task: string) {
  const area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, task);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("RaceStart", () => {
  it("offers the harnesses this server runs, and starts one inline run per lane, each under its own key, then opens the race", async () => {
    const { host, sent, went } = mount(started);
    const lanes = [...host.querySelectorAll("[data-race-lane]")];
    expect(lanes).toHaveLength(2);
    expect(lanes.map((l) => [l.querySelector('[data-lane-harness]')?.getAttribute("data-value"), l.querySelector('[data-lane-model]')?.getAttribute("data-value")])).toEqual([["pi", "anthropic/claude-sonnet-5-5"], ["codex", "openai/gpt-6.1-sol"]]);
    expect(host.textContent).not.toContain("opencode");
    await type(host, TASK);
    await act(async () => { button(host, "Start the race")!.click(); });
    await settle();
    // Each lane with the tools its harness runs here (no box on this server: no shell), so a lane can do the task.
    expect(sent.map((s) => s.body)).toEqual([
      laneStart(LABEL, 1, { harness: "pi", model: "anthropic/claude-sonnet-5-5" }, TASK, 1, { tools: ["read", "write", "web_search"] }),
      laneStart(LABEL, 2, { harness: "codex", model: "openai/gpt-6.1-sol" }, TASK, 1, { tools: ["read", "write"] }),
    ]);
    expect(new Set(sent.map((s) => s.key)).size).toBe(2);
    expect(went).toEqual([`#/races/${LABEL}`]);
  });

  it("on a server with a box, every lane runs in it, with the shell a new agent gets there", async () => {
    const { host, sent } = mount(started, BOXED);
    await type(host, TASK);
    await act(async () => { button(host, "Start the race")!.click(); });
    await settle();
    expect(sent.map((s) => (s.body.definition as Record<string, unknown>))).toEqual([
      expect.objectContaining({ harness: "pi", tools: ["read", "write", "bash", "web_search"], computer: { kind: "sandbox", provider: "local" } }),
      expect.objectContaining({ harness: "codex", tools: ["read", "write", "bash"], computer: { kind: "sandbox", provider: "local" } }),
    ]);
  });

  it("a lane the server refuses says why in its own place; the others start, and Start again sends only that lane, under the key it had", async () => {
    let refuse = true;
    const { host, sent, went } = mount((one) => one.lane === "2" && refuse
      ? json(409, { error: { code: "agent_not_runnable", message: "codex doesn't run on this server: no OpenAI key.", retryable: false } })
      : started(one));
    await type(host, TASK);
    await act(async () => { button(host, "Start the race")!.click(); });
    await settle();
    const [one, two] = [...host.querySelectorAll("[data-race-lane]")];
    expect(one.querySelector("a")?.getAttribute("href")).toBe("#/runs/run-1");
    expect(two.textContent).toContain("codex doesn't run on this server: no OpenAI key.");
    expect(two.querySelector<HTMLButtonElement>('button[aria-label="Lane 2 harness"]')!.disabled, "a refused lane may be picked again").toBe(false);
    expect(went).toEqual([]);
    refuse = false;
    const first = sent.find((s) => s.lane === "2")!.key;
    await act(async () => { button(host, "Start the lanes left")!.click(); });
    await settle();
    expect(sent.map((s) => s.lane)).toEqual(["1", "2", "2"]);
    expect(sent.at(-1)!.key).toBe(first);
    expect(went).toEqual([`#/races/${LABEL}`]);
  });

  it("a lane whose answer never came whole keeps its pick and key, and Start again sends the same request, so it never starts twice", async () => {
    const lost: [string, () => Response | Promise<Response>][] = [
      ["a request that never got an answer", () => Promise.reject(new TypeError("Failed to fetch"))],
      ["a 5xx with no refusal in it", () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } })],
      ["a start the server is still making", () => json(409, { error: { code: "idempotency_in_progress", message: "A request with this key is still in progress.", retryable: true } })],
    ];
    for (const [why, answer] of lost) {
      let lose = true;
      const { host, sent, went } = mount((one) => (one.lane === "2" && lose ? answer() : started(one)));
      await type(host, TASK);
      await act(async () => { button(host, "Start the race")!.click(); });
      await settle();
      const two = host.querySelector('[data-race-lane="2"]')!;
      expect(two.textContent, why).toContain("Not sure this lane started; Start again checks.");
      for (const picker of ["harness", "model"])
        expect(two.querySelector<HTMLButtonElement>(`button[aria-label="Lane 2 ${picker}"]`)!.disabled, `${why}: the ${picker} holds still`).toBe(true);
      expect(host.querySelector("textarea")!.readOnly, `${why}: the task holds still`).toBe(true);
      lose = false;
      await act(async () => { button(host, "Start the lanes left")!.click(); });
      await settle();
      const [first, again] = sent.filter((s) => s.lane === "2");
      expect(again, why).toBeDefined();
      expect([again.key, again.body], `${why}: the same request`).toEqual([first.key, first.body]);
      expect(went, why).toEqual([`#/races/${LABEL}`]);
      act(() => root!.unmount());
      root = undefined;
      document.body.innerHTML = "";
    }
  });

  it("lanes are seeded when the capabilities first name a harness that runs, after none did", async () => {
    const none = HARNESSES.map((h) => ({ ...h, available: false }));
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const render = (harnesses: typeof HARNESSES) => act(() => root!.render(createElement(RaceStart, { v2: createClient({ fetch: globalThis.fetch }), harnesses, tools: TOOLS, places: null, go: () => {}, label: LABEL })));
    render(none);
    expect(host.querySelectorAll("[data-race-lane]")).toHaveLength(0);
    render(HARNESSES);
    await settle();
    expect(host.querySelectorAll("[data-race-lane]"), "the two a race needs, never one").toHaveLength(2);
  });

  it("a second click while the lanes are starting sends nothing more: each lane once", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const { host, sent } = mount(async (one) => { await held; return started(one); });
    await type(host, TASK);
    await act(async () => { button(host, "Start the race")!.click(); });
    await act(async () => { button(host, "Starting…")?.click(); button(host, "Start the race")?.click(); });
    release();
    await settle();
    expect(sent.map((s) => s.lane)).toEqual(["1", "2"]);
  });

  it("the task and cap hold still while the lanes are starting, so a lane started again later runs the same task", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const { host } = mount(async (one) => { await held; return started(one); });
    await type(host, TASK);
    await act(async () => { button(host, "Start the race")!.click(); });
    expect(host.querySelector("textarea")!.readOnly, "the task, while its requests are out").toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[type="number"]')!.readOnly, "the cap, while its requests are out").toBe(true);
    release();
    await settle();
  });

  it("a form left while its lanes start never moves the page it was left for", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const { host, sent, went } = mount(async (one) => { await held; return started(one); });
    await type(host, TASK);
    await act(async () => { button(host, "Start the race")!.click(); });
    act(() => root!.unmount());
    root = undefined;
    release();
    await settle();
    expect(sent).toHaveLength(2);
    expect(went, "no go after the form is gone").toEqual([]);
  });

  it("asks for the task before it starts anything, and adds lanes up to four", async () => {
    const { host, sent } = mount(started);
    await act(async () => { button(host, "Start the race")!.click(); });
    await settle();
    expect(sent).toEqual([]);
    expect(host.textContent).toContain("Say what every lane does");
    await act(async () => { button(host, "Add a lane")!.click(); });
    await act(async () => { button(host, "Add a lane")!.click(); });
    expect(host.querySelectorAll("[data-race-lane]")).toHaveLength(4);
    expect(button(host, "Add a lane")).toBeUndefined();
  });
});

describe("the way to the form", () => {
  it("the Runs list's toolbar links to #/races/new, as New race", async () => {
    const { RunsList } = await import("./RunsList");
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(createElement(RunsList, { runs: [], agentName: (id: string) => id, onOpen: () => {} })));
    const link = host.querySelector<HTMLAnchorElement>('header a[href="#/races/new"]');
    expect(link?.textContent).toBe("New race");
  });
});
