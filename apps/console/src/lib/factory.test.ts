import { describe, expect, it, vi } from "vitest";
import running from "../fixtures/run.working.working.1.json";
import { createClient } from "./client";
import { factoryCards, readFactoryScope, reconcileFactoryRuns } from "./factory";
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

  it("reports SDK freshness as unavailable, without treating quiet activity as stale or granting control", () => {
    const [card] = factoryCards([run("sdk", { factory: { ...FACTORY, source: "sdk", runtime: "codex-sdk", control: "observed", observation: { basis: "unreported", status: "unreported", last_seen_at: null }, last_activity_at: null } })], name);
    expect(card).toMatchObject({ lane: "working", controlLabel: "Observed", activityAt: null });
    expect(card.reason).toContain("freshness is not reported");
    expect(card.costLabel).not.toContain("$0");
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
