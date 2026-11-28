import { describe, expect, it, vi } from "vitest";
import running from "../fixtures/run.working.working.1.json";
import { createClient } from "./client";
import { FACTORY_VIEW_KEY, factoryCards, factoryHash, factoryPlace, readFactoryScope, reconcileFactoryRuns, savedFactoryView, saveFactoryView } from "./factory";
import type { FactoryRunPage, Run } from "./v2";

const FACTORY: NonNullable<Run["factory"]> = {
  lifecycle_version: "10", source: "managed", runtime: "pi", control: "managed", controls: { stop: true, cancel: true, approve: false },
  observation: { basis: "runner", status: "current", last_seen_at: "2026-11-21T10:00:00Z" },
  last_activity_at: "2026-11-21T09:59:50Z", github: null, children: [],
};
const run = (id: string, patch: Partial<Run> = {}): Run => ({ ...running.body, kind: "agentic", run_id: id, factory: FACTORY, ...patch } as Run);
const name = () => "Same agent";
const signal = () => new AbortController().signal;

describe("factory session projection", () => {
  it("keeps simultaneous runs of one agent, unlinked work and archived active sessions; history and terminal review are not executing", () => {
    const runs = [run("one"), run("two", { archived_at: "2026-11-21T09:00:00Z" }), run("import", { imported_from: { source: "codex", session: "history" } }), run("review", { status: "completed", ended_at: "2026-11-21T10:00:00Z", review: { kind: "verify", node: null, reason: "Check evidence", at: "2026-11-21T10:00:00Z" } })];
    expect(factoryCards(runs, name).map((c) => [c.id, c.repo, c.lane])).toEqual([["one", null, "working"], ["two", null, "working"]]);
    expect(factoryCards(runs, name, true).map((c) => [c.id, c.lane, c.reason])).toEqual([["review", "attention", "Check evidence"]]);
  });

  it("separates queue, parked turn, pause, question, stop and disconnected reporting", () => {
    const cards = factoryCards([
      run("queue", { status: "queued" }), run("parked", { state: "idle" }), run("pause", { status: "paused" }),
      run("ask", { status: "input_required", state: "waiting", pending: { kind: "question", question: "Which scope?", asked_at: "2026-11-21T10:00:00Z" } }),
      run("stop", { status: "input_required", state: "idle" }),
      run("offline", { status: "input_required", pending: { kind: "question", question: "Still waiting?", asked_at: "2026-11-21T10:00:00Z" }, factory: { ...FACTORY, observation: { basis: "connector", status: "offline", last_seen_at: null } } }),
    ], name);
    expect(cards.map((c) => [c.id, c.lane, c.stateLabel])).toEqual([
      ["queue", "waiting", "Queued"], ["parked", "waiting", "Between turns"], ["pause", "waiting", "Paused"],
      ["ask", "attention", "Input required"], ["stop", "attention", "Stopped"], ["offline", "unknown", "Activity unknown"],
    ]);
    expect(cards[5].reason).toContain("Still waiting?");
    expect(cards[5].reason).toContain("Source offline");
  });

  it("says nothing of connection freshness for a run no runner holds: a queued run, and one that waits for its person", () => {
    // The server reads such a run as runner-observed and unreported: there is no connection to report on, so the card
    // keeps the agent's own words whole.
    const unheld = { ...FACTORY, observation: { basis: "runner", status: "unreported", last_seen_at: null } } satisfies NonNullable<Run["factory"]>;
    const [queued, asking] = factoryCards([
      run("queued", { status: "queued", factory: unheld }),
      run("asking", { status: "input_required", state: "waiting", pending: { kind: "question", question: "Which scope?", asked_at: "2026-11-21T10:00:00Z" }, factory: unheld }),
    ], name);
    expect(queued.reason).toBeNull();
    expect(asking.reason).toBe("Which scope?");
  });

  it("names a session by its run's short label, a child by its conversation, and the child's parent by the same short label", () => {
    const id = "01a20ee0-b5a2-7000-b6d1-1ed9964844d8";
    const [parent, child] = factoryCards([run(id, { factory: { ...FACTORY, children: [{ id: `${id}:conversation:24`, conversation_id: 24, parent_call_id: "call-1", status: "active", label: "Tester" }] } })], name);
    expect(parent.ref).toBe("run 964844d8");
    expect(child.ref).toBe("child 24");
    expect(child.parentLabel).toBe("Same agent · 964844d8");
    // The whole ids stay on the cards for the link and the key.
    expect([parent.runId, child.runId, child.id]).toEqual([id, id, `${id}:child:${id}:conversation:24`]);
  });

  it("reports SDK freshness as unavailable, without treating quiet activity as stale or granting control", () => {
    const [card] = factoryCards([run("sdk", { factory: { ...FACTORY, source: "sdk", runtime: "codex-sdk", control: "observed", observation: { basis: "unreported", status: "unreported", last_seen_at: null }, last_activity_at: null } })], name);
    expect(card).toMatchObject({ lane: "working", controlLabel: "Observed", activityAt: null });
    expect(card.reason).toContain("freshness is not reported");
    expect(card.costLabel).not.toContain("$0");
  });

  it("shows a connected CLI session as observed, under the name the console gives that CLI, with no freshness claimed", () => {
    const cli = (runtime: string) => run(runtime, { factory: { ...FACTORY, source: "cli", runtime, control: "observed", controls: { stop: false, cancel: false, approve: false }, observation: { basis: "unreported", status: "unreported", last_seen_at: null } } });
    const cards = factoryCards([cli("codex-cli"), cli("claude-code-cli"), cli("another-cli")], name);
    expect(cards.map((card) => card.sourceLabel)).toEqual(["Codex CLI", "Claude Code", "CLI · another-cli"]);
    for (const card of cards) {
      expect(card).toMatchObject({ lane: "working", controlLabel: "Observed" });
      expect(card.reason).toContain("freshness is not reported");
    }
  });

  it("uses only structured GitHub provenance, never task URLs or a successful result as delivery evidence", () => {
    const plain = run("plain", { title: "Merge https://github.com/elsewhere/repo/pull/99" });
    const linked = run("linked", { factory: { ...FACTORY, github: { repository: "acme/console", issue: 4, pull_request: 8, head_sha: "a".repeat(40), provenance: "github_trigger" } } });
    const malformed = run("bad", { factory: { ...FACTORY, github: { ...linked.factory!.github!, repository: "evil.test/@github.com/x" } } });
    const [a, b, c] = factoryCards([plain, linked, malformed], name);
    expect(a.githubLinks).toEqual([]);
    expect(b.githubLinks).toEqual([{ label: "acme/console", url: "https://github.com/acme/console" }, { label: "Issue #4", url: "https://github.com/acme/console/issues/4" }, { label: "PR #8", url: "https://github.com/acme/console/pull/8" }]);
    expect(b.stateLabel).toBe("Working");
    expect(c.githubLinks).toEqual([]);
  });

  it("shows reported active children individually with the parent route and no invented child heartbeat or control", () => {
    const parent = run("parent", { factory: { ...FACTORY, children: [
      { id: "child-1", conversation_id: 1, parent_call_id: "call-1", status: "active", label: "Tester" },
      { id: "child-2", conversation_id: 2, parent_call_id: "call-2", status: "completed", label: "Done" },
    ] } });
    const cards = factoryCards([parent], name);
    expect(cards).toHaveLength(2);
    expect(cards[1]).toMatchObject({ id: "parent:child:child-1", runId: "parent", agentName: "Tester", parentLabel: "Same agent · parent", controlLabel: "Observed", activityAt: null });
    expect(factoryCards([{ ...parent, status: "completed", ended_at: "2026-11-21T10:00:00Z" }], name)).toEqual([]);
  });
});

describe("factory lifecycle transitions", () => {
  const ended = (version: string) => run("moving", { status: "completed", ended_at: "2026-11-21T10:00:00Z", review: { kind: null, node: null, reason: "Inspect evidence", at: "2026-11-21T10:00:00Z" }, factory: { ...FACTORY, lifecycle_version: version } });
  const live = (version: string) => run("moving", { factory: { ...FACTORY, lifecycle_version: version } });

  it("keeps a cancelling session visible until its execution has settled", () => {
    const cancelling = run("cancel", { status: "cancelled", ended_at: null });
    expect(factoryCards([cancelling], name)[0]).toMatchObject({ id: "cancel", lane: "waiting", stateLabel: "Cancelling" });
    expect(factoryCards([{ ...cancelling, ended_at: "2026-11-21T10:00:00Z" }], name)).toEqual([]);
  });

  it("shows ordinary failures as ended attention, never active work", () => {
    const failed = run("failure", { status: "failed", ended_at: "2026-11-21T10:00:00Z", error: { code: "internal", message: "Adapter disconnected", retryable: false } as Run["error"] });
    expect(factoryCards([failed], name)).toEqual([]);
    expect(factoryCards([failed], name, true)[0]).toMatchObject({ id: "failure", lane: "attention", reason: "Adapter disconnected" });
  });

  it("reconciles an escalation and a later reopen by committed version, not request order or wall clock", () => {
    const first = reconcileFactoryRuns([live("9007199254740992")], [ended("9007199254740993")]);
    expect(first.active).toEqual([]);expect(first.review).toHaveLength(1);
    const reopened = reconcileFactoryRuns([live("9007199254740994")], [ended("9007199254740993")]);
    expect(reopened.active).toHaveLength(1);expect(reopened.review).toEqual([]);
  });

  it("keeps a run that ended between SQL selection and projection in ended attention", () => {
    const got = reconcileFactoryRuns([ended("12")], []);
    expect(got.active).toEqual([]);expect(got.review).toHaveLength(1);
  });

  it("refuses contradictory states with the same committed version", () => {
    expect(() => reconcileFactoryRuns([live("12")], [ended("12")])).toThrow("changed while its status");
  });

  it("preserves known spend when some charges have no price", () => {
    const partial = run("partial", { cost: { ...running.body.cost, usd: null, so_far_usd: 1.25, unpriced: 2 } as Run["cost"] });
    expect(factoryCards([partial], name)[0].costLabel).toContain("1.25");
    expect(factoryCards([partial], name)[0].costLabel).toContain("2 not priced");
  });
});

describe("factory paged reads", () => {
  it("passes scope, opaque cursor and cancellation to the existing authenticated client", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ runs: [], next_cursor: null, scope: "active", observed_at: "2026-11-21T10:00:00Z" }), { headers: { "content-type": "application/json" } }));
    const v2 = createClient({ fetch: f as typeof fetch });
    const abort = signal();
    await v2.listFactoryRuns("active", "cursor+/=", abort);
    expect(f.mock.calls[0]).toMatchObject(["/v2/runs?scope=active&limit=50&cursor=cursor%2B%2F%3D", { method: "GET", credentials: "same-origin", signal: abort }]);
  });

  it("follows cursors and deduplicates a session moving between pages, while disclosing a bounded partial read", async () => {
    const listFactoryRuns = vi.fn()
      .mockResolvedValueOnce({ scope: "active", runs: [run("one")], next_cursor: "next" })
      .mockResolvedValueOnce({ scope: "active", runs: [run("one"), run("old-active")], next_cursor: "more" });
    const got = await readFactoryScope({ listFactoryRuns }, "active", 2, signal());
    expect(got.runs.map((r) => r.run_id)).toEqual(["one", "old-active"]);
    expect(got.hasMore).toBe(true);
  });

  it("refuses recent-history answers from a server that ignores scope", async () => {
    const listFactoryRuns = vi.fn(async () => ({ runs: [run("recent")], next_cursor: null } as FactoryRunPage));
    await expect(readFactoryScope({ listFactoryRuns }, "active", 5, signal())).rejects.toThrow("does not provide the Agent Factory projection");
  });

  it("refuses a repeated cursor rather than silently treating a partial fleet as complete", async () => {
    const listFactoryRuns = vi.fn(async () => ({ scope: "active", runs: [run("one")], next_cursor: "same" } as FactoryRunPage));
    await expect(readFactoryScope({ listFactoryRuns }, "active", 5, signal())).rejects.toThrow("repeated a page cursor");
  });
});

describe("the factory's view, kept in this browser", () => {
  const store = (held: Record<string, string> = {}) => ({ held, getItem: (key: string) => held[key] ?? null, setItem: (key: string, value: string) => { held[key] = value; } });
  it("is cards until List is picked, and reads nothing else as a view", () => {
    expect(savedFactoryView(store())).toBe("cards");
    expect(savedFactoryView(store({ [FACTORY_VIEW_KEY]: "list" }))).toBe("list");
    expect(savedFactoryView(store({ [FACTORY_VIEW_KEY]: "table" }))).toBe("cards");
    const kept = store();
    saveFactoryView("list", kept);
    expect(kept.held).toEqual({ [FACTORY_VIEW_KEY]: "list" });
    expect(savedFactoryView(kept)).toBe("list");
    saveFactoryView("cards", kept);
    expect(savedFactoryView(kept)).toBe("cards");
  });

  it("reads cards, and keeps nothing, where the browser refuses its storage", () => {
    const refusing = { getItem: () => { throw new Error("refused"); }, setItem: () => { throw new Error("refused"); } };
    expect(savedFactoryView(refusing)).toBe("cards");
    expect(() => saveFactoryView("list", refusing)).not.toThrow();
    expect(savedFactoryView(null)).toBe("cards");
    expect(() => saveFactoryView("list", null)).not.toThrow();
  });
});

describe("the next step on a session that waits on a person", () => {
  const asked = "2026-11-21T10:00:00Z";
  it("is Answer for a question and Review for what asks leave; a session nobody is asked about, an ended run and a child have none", () => {
    const waiting = (id: string, pending: Run["pending"]) => run(id, { status: "input_required", state: "waiting", pending });
    const cards = factoryCards([
      waiting("ask", { kind: "question", question: "Which scope?", asked_at: asked }),
      waiting("call", { kind: "approval", tool: "write", asked_at: asked } as unknown as Run["pending"]),
      run("works", { factory: { ...FACTORY, children: [{ id: "works:conversation:2", conversation_id: 2, parent_call_id: "c1", status: "active", label: "Check it" }] } }),
      run("stopped", { status: "input_required", state: "idle" }),
    ], name);
    expect(cards.map((card) => [card.id, card.action])).toEqual([["ask", "Answer"], ["call", "Review"], ["works", undefined], ["works:child:works:conversation:2", undefined], ["stopped", undefined]]);
    // An ended run in review waits on nobody: its card opens it, with no step named.
    const ended = factoryCards([run("ended", { status: "failed", ended_at: asked, error: { code: "run_failed", message: "It failed." } as unknown as Run["error"], pending: { kind: "question", question: "Left over?", asked_at: asked } })], name, true);
    expect(ended.map((card) => card.action)).toEqual([undefined]);
  });
});

describe("the board's address", () => {
  it("says only what is not the default, and reads back what it wrote", () => {
    expect(factoryHash()).toBe("#/factory");
    expect(factoryHash({ repository: "all", control: "all" })).toBe("#/factory");
    const place = { session: "run_abc/1 2", repository: "repo:acme/console.web", control: "control:Observed" };
    const hash = factoryHash(place);
    expect(hash).toBe("#/factory?session=run_abc%2F1+2&repo=acme%2Fconsole.web&control=observed");
    expect(factoryPlace(hash.split("?")[1]!)).toEqual(place);
    expect(factoryPlace(factoryHash({ repository: "unreported", control: "control:Managed" }).split("?")[1]!)).toEqual({ repository: "unreported", control: "control:Managed" });
    expect(factoryPlace("")).toEqual({ repository: "all", control: "all" });
  });

  it("widens a filter it does not know to every session, never to an empty board no option explains", () => {
    expect(factoryPlace("repo=not-a-repository&control=owned")).toEqual({ repository: "all", control: "all" });
    expect(factoryPlace("repo=a/b/c&control=Managed")).toEqual({ repository: "all", control: "all" });
    // A word every object answers to (constructor, toString, __proto__) is no control: it is not one of the two.
    for (const word of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) expect(factoryPlace(`control=${word}`), word).toEqual({ repository: "all", control: "all" });
    // A session id past any real one is not carried into a request.
    expect(factoryPlace(`session=${"x".repeat(201)}`)).toEqual({ repository: "all", control: "all" });
  });
});
