import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RaceStart } from "./RaceStart";
import { toolOffers } from "@/lib/agentForm";
import { createClient } from "@/lib/client";
import type { Places } from "@/lib/place";
import { laneStart } from "@/lib/race";
import { pick, picker } from "@/test/picker";

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
// The tools this server runs (capabilities `tools`), as a server offers them: the shell is pi's alone (an adapter harness
// gets the host tools only). A lane gets a new agent's, by its harness and the server's default place.
const TOOLS = toolOffers([
  { name: "read", available: true, harnesses: ["pi", "codex"] },
  { name: "write", available: true, harnesses: ["pi", "codex"] },
  { name: "bash", available: true, sandbox_only: true, harnesses: ["pi"] },
  { name: "web_search", available: true, harnesses: ["pi"] },
]);
const BOXED: Places = { modes: ["runner", "sandbox"], boxes: [{ id: "local", available: true }], defaultPlace: { mode: "sandbox", box: "local" } };
const LABEL = "20261123-1004-1f2e";
const TASK = "Fix the failing test in the parser";

type Sent = { lane: string; agentId: string; body: Record<string, unknown>; key: string };
type Made = Record<string, unknown> & { id: string };
/** A fake server: every POST /v2/agents recorded in `made` (an id it has already is 409 agent_exists, as the server
 *  answers), and every POST /v2/agents/{id}/runs in `sent`, answered by `answer` (202 with a run, or a refusal).
 *  `places`: the server's (capabilities `places`), none by default. `agent`: a POST /v2/agents answer of the test's
 *  own (a refusal or a lost answer), else the server's. */
function mount(answer: (sent: Sent) => Response | Promise<Response>, places: Places | null = null, agent?: (made: Made) => Response | Promise<Response> | undefined) {
  const sent: Sent[] = [];
  const made: Made[] = [];
  const archived: string[] = [];
  const went: string[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://serve.test").pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (path === "/v2/agents" && init?.method === "POST") {
      const definition = body.definition as Made;
      const theirs = agent?.(definition);
      if (theirs) return theirs;
      if (made.some((m) => m.id === definition.id)) return json(409, { error: { code: "agent_exists", message: `an agent ${definition.id} exists here`, retryable: false } });
      made.push(definition);
      return json(201, { agent_id: definition.id, revision: `rev-${definition.id}`, kind: "agentic", definition });
    }
    // Every agent here was edited once in the Agents list since it was made: version 2 is current, newest first.
    const revisionsOf = /^\/v2\/agents\/([^/]+)\/revisions$/.exec(path);
    if (revisionsOf) {
      const id = decodeURIComponent(revisionsOf[1]);
      return json(200, { revisions: [{ revision: `rev-${id}-edited`, version: 2, current: true }, { revision: `rev-${id}`, version: 1, current: false }], next_cursor: null });
    }
    const archiveOf = /^\/v2\/agents\/([^/]+)\/archive$/.exec(path);
    if (archiveOf && init?.method === "POST") {
      archived.push(decodeURIComponent(archiveOf[1]));
      return json(200, { agent_id: decodeURIComponent(archiveOf[1]), archived_at: "2026-11-24T23:00:00Z" });
    }
    const runOf = /^\/v2\/agents\/([^/]+)\/runs$/.exec(path);
    if (!runOf || init?.method !== "POST") return json(404, { error: { code: "not_found", message: path, retryable: false } });
    const one = { lane: (body.labels as Record<string, string>).lane, agentId: decodeURIComponent(runOf[1]), body, key: (init.headers as Record<string, string>)["idempotency-key"] };
    sent.push(one);
    return answer(one);
  }) as typeof globalThis.fetch;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(RaceStart, { v2: createClient({ fetch }), harnesses: HARNESSES, tools: TOOLS, places, go: (to: string) => void went.push(to), label: LABEL })));
  return { host, sent, made, archived, went };
}
const started = (sent: Sent) => json(202, { run_id: `run-${sent.lane}`, agent_id: sent.agentId, status: "queued", state: "working", labels: sent.body.labels });
const button = (host: Element, label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
async function type(host: Element, task: string) {
  const area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, task);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("RaceStart", () => {
  it("offers the harnesses this server runs, and makes each lane an agent of the console's own and starts a run of it, each under its own key, then opens the race", async () => {
    const { host, sent, made, went } = mount(started);
    const lanes = [...host.querySelectorAll("[data-race-lane]")];
    expect(lanes).toHaveLength(2);
    expect(lanes.map((l) => [l.querySelector('[data-lane-harness]')?.getAttribute("data-value"), l.querySelector('[data-lane-model]')?.getAttribute("data-value")])).toEqual([["pi", "anthropic/claude-sonnet-5-5"], ["codex", "openai/gpt-6.1-sol"]]);
    expect(host.textContent).not.toContain("opencode");
    await type(host, TASK);
    await act(async () => { button(host, "Start the race")!.click(); });
    await settle();
    // Each lane with the tools its harness runs here (no box on this server: no shell), so a lane can do the task.
    const one = laneStart(LABEL, 1, { harness: "pi", model: "anthropic/claude-sonnet-5-5" }, TASK, 1, { tools: ["read", "write", "web_search"] }, 1);
    const two = laneStart(LABEL, 2, { harness: "codex", model: "openai/gpt-6.1-sol" }, TASK, 1, { tools: ["read", "write"] }, 2);
    expect(made).toEqual([one.agent, two.agent]);
    // No external reference: the console's own agents, which it archives, edits and deletes as any other.
    for (const m of made) expect(m).not.toHaveProperty("external");
    // Each run pinned to its agent's first revision, the one the create answered.
    expect(sent.map((s) => [s.agentId, s.body])).toEqual([[one.agent.id, { ...one.run, revision: `rev-${one.agent.id}` }], [two.agent.id, { ...two.run, revision: `rev-${two.agent.id}` }]]);
    expect(new Set(sent.map((s) => s.key)).size).toBe(2);
    expect(went).toEqual([`#/races/${LABEL}`]);
  });

  it("on a server with a box by default, pi's lane gets the shell a new pi agent gets there, and no lane names a place: the server puts each where it puts that agent", async () => {
    const { host, made } = mount(started, BOXED);
    await type(host, TASK);
    await act(async () => { button(host, "Start the race")!.click(); });
    await settle();
    const definitions = made as Record<string, unknown>[];
    expect(definitions.map((d) => [d.harness, d.tools])).toEqual([["pi", ["read", "write", "bash", "web_search"]], ["codex", ["read", "write"]]]);
    // With a computer named, codex's lane would be put in the box, where a new codex agent never runs (no shell), and a
    // Claude Code login (the runner's alone) could not run a claude-agent lane.
    for (const d of definitions) expect(Object.keys(d).filter((k) => k === "computer" || k === "place"), String(d.harness)).toEqual([]);
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

  it("a lane whose agent was made but whose answer was lost is the same agent when Start sends it again: one agent, one run", async () => {
    let lose = true;
    const kept: Made[] = [];
    // The server makes lane 2's agent, then the answer is lost on its way back.
    const { host, sent, made, went } = mount(started, null, (definition) => {
      if (!(lose && definition.id.startsWith(`race-${LABEL}-2-`))) return undefined;
      lose = false;
      kept.push(definition);
      return new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
    });
    await type(host, TASK);
    await act(async () => { button(host, "Start the race")!.click(); });
    await settle();
    expect(host.querySelector('[data-race-lane="2"]')!.textContent).toContain("Not sure this lane started; Start again checks.");
    expect(sent.map((s) => s.lane)).toEqual(["1"]);
    made.push(...kept);
    await act(async () => { button(host, "Start the lanes left")!.click(); });
    await settle();
    expect(made.filter((m) => m.id.startsWith(`race-${LABEL}-2-`)), "lane 2's agent, made once").toHaveLength(1);
    expect(sent.map((s) => [s.lane, s.agentId])).toEqual([["1", made[0].id], ["2", kept[0].id]]);
    // The agent was edited in the Agents list since it was made: the lane still runs its first revision, the model the
    // race shows.
    expect(sent[1].body.revision).toBe(`rev-${kept[0].id}`);
    expect(went).toEqual([`#/races/${LABEL}`]);
  });

  it("a refused lane picked again lets its agent go (archived, so the Agents list keeps none of it) and makes a new one", async () => {
    let refuse = true;
    const { host, sent, made, archived } = mount((one) => one.lane === "2" && refuse
      ? json(409, { error: { code: "agent_not_runnable", message: "That model doesn't run on this server: no key for it.", retryable: false } })
      : started(one));
    await type(host, TASK);
    await act(async () => { button(host, "Start the race")!.click(); });
    await settle();
    const refusedAgent = sent.find((s) => s.lane === "2")!.agentId;
    expect(archived).toEqual([]);
    await pick(picker(host.querySelector('[data-race-lane="2"]')!, "Lane 2 harness")!, "pi");
    await settle();
    expect(archived, "the refused pick's agent").toEqual([refusedAgent]);
    refuse = false;
    await act(async () => { button(host, "Start the lanes left")!.click(); });
    await settle();
    const again = sent.filter((s) => s.lane === "2").at(-1)!;
    expect(again.agentId).not.toBe(refusedAgent);
    expect(made.find((m) => m.id === again.agentId)?.harness).toBe("pi");
  });

  it("a refused last lane can be removed, since its refusal started nothing; with every lane left started, the race opens", async () => {
    const { host, sent, archived, went } = mount((one) => one.lane === "3"
      ? json(409, { error: { code: "agent_not_runnable", message: "That model doesn't run on this server: no key for it.", retryable: false } })
      : started(one));
    await act(async () => { button(host, "Add a lane")!.click(); });
    await type(host, TASK);
    await act(async () => { button(host, "Start the race")!.click(); });
    await settle();
    expect(host.querySelector('[data-race-lane="3"]')!.textContent).toContain("no key for it");
    expect(went).toEqual([]);
    await act(async () => { button(host, "Remove lane 3")!.click(); });
    await settle();
    expect(host.querySelectorAll("[data-race-lane]")).toHaveLength(2);
    expect(sent.map((s) => s.lane)).toEqual(["1", "2", "3"]);
    expect(archived, "the removed lane's agent, which never ran").toEqual([sent[2].agentId]);
    expect(went).toEqual([`#/races/${LABEL}`]);
  });

  it("a started or unsure last lane keeps its place: no Remove for it", async () => {
    const { host } = mount((one) => one.lane === "3" ? Promise.reject(new TypeError("Failed to fetch")) : started(one));
    await act(async () => { button(host, "Add a lane")!.click(); });
    await act(async () => { button(host, "Add a lane")!.click(); });
    await type(host, TASK);
    await act(async () => { button(host, "Start the race")!.click(); });
    await settle();
    // Lane 4 started, and lane 3 may have: neither is offered for removal.
    expect(button(host, "Remove lane 4")).toBeUndefined();
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
