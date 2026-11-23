// Demo mode's backend: a `fetch` for the console's client that answers `agentrun.v2/0` from the demo's world, in this
// page, in place of the server. Nothing a person does in demo mode reaches the server: a read is answered from sample
// data, the few things a tour does (answering a question or an approval, starting or stopping a run) change only the
// world in this page's memory, and every other write is refused, saying so.
//
// Three reads go to the server all the same. The session and sign-out (`/auth/…`), since the person is signed in to it.
// And its catalogue, which is the product's own and holds nothing of the owner's: what the server can do
// (`/capabilities`, shown as a server with every model and tool ready, without its secrets' names or its switches) and the
// templates it ships with (`/templates`, the bundled ones only).
import { DAY } from "./tale";
import { createWorld, hex, type World } from "./world";

export const DEMO_REFUSAL = "Demo mode shows sample data, so this change was not made. Turn demo mode off in Settings → Demo to work with your own server.";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const refusal = (status: number, code: string, message: string, details?: Record<string, unknown>) => json({ error: { code, message, retryable: false, request_id: "req_demo", ...(details ? { details } : {}) } }, status);
const notFound = (what: string) => refusal(404, "not_found", `no ${what}`);
const refused = () => refusal(403, "demo_mode", DEMO_REFUSAL);

/** A page of `items` from a cursor that is the index it starts at. */
function page<T>(items: T[], q: URLSearchParams, fallback = 50): { items: T[]; next_cursor: string | null } {
  const limit = Math.min(Math.max(Number(q.get("limit")) || fallback, 1), 200);
  const from = Math.max(Number(q.get("cursor")) || 0, 0);
  return { items: items.slice(from, from + limit), next_cursor: from + limit < items.length ? String(from + limit) : null };
}

const wait = (ms: number, signal?: AbortSignal | null) => new Promise<void>((done) => {
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); done(); }, { once: true });
});

/** A server's capabilities as the demo shows them: the same harnesses, tools and features, each one ready, on named
 *  models, with nothing that says how the server itself is set up. */
export function demoCapabilities(real: Record<string, unknown>): Record<string, unknown> {
  const { secrets: _secrets, switches: _switches, home: _home, runner_refused: _refused, ...caps } = real;
  const list = (x: unknown) => (Array.isArray(x) ? (x as Record<string, unknown>[]) : []);
  const ready = ({ reason: _reason, needs: _needs, ...x }: Record<string, unknown>): Record<string, unknown> => ({ ...x, available: true });
  const models = { default: "anthropic/claude-sonnet-5-5", fast: "openai/gpt-6-luna", strong: "anthropic/claude-opus-5-5" };
  const features = (caps.features ?? {}) as Record<string, unknown>;
  const workflows = (caps.workflows ?? {}) as { decisions?: { providers?: unknown } };
  return {
    ...caps,
    harnesses: list(caps.harnesses).map((h) => ({ ...ready(h), default_model: h.id === "codex" ? "openai/gpt-6.1-sol" : models.default })),
    models: { ...(caps.models as object), source: "providers", route_prefix: null, ...models, ready: true, needs: null, priced: true },
    learning_model: { location: "server", ready: true, model: models.default, needs: null, reason: null },
    // The demo takes the owner's OK on a learned workflow itself, whatever this session may approve on the server.
    learning: { ...(caps.learning as object), pending: true, approve: true },
    tools: list(caps.tools).map((t) => { const { why: _why, resolves: _resolves, ...tool } = ready(t); return tool; }),
    workflows: { ...workflows, ...(workflows.decisions ? { decisions: { ...workflows.decisions, providers: list(workflows.decisions.providers).map(ready) } } : {}) },
    features: { ...features, learning: "on", triggers: { ...(features.triggers as object), routes: true, public_url: true } },
  };
}

/** The demo's `fetch`. `real`: the server's, for the three reads the demo leaves to it; `world`: the story's state. */
export function createDemoFetch({ real, world = createWorld() }: { real: typeof fetch; world?: World }): typeof fetch {
  const handle = async (method: string, path: string, q: URLSearchParams, body: Record<string, unknown>, init: RequestInit | undefined, input: RequestInfo | URL): Promise<Response> => {
    if (path.startsWith("/auth/")) return real(input, init);
    if (method === "GET" && path === "/capabilities") {
      const res = await real(input, init);
      return res.ok ? json(demoCapabilities((await res.json()) as Record<string, unknown>)) : res;
    }
    if (method === "GET" && path === "/templates") {
      const res = await real(input, init);
      if (!res.ok) return res;
      const served = (await res.json()) as { templates?: { bundled?: boolean }[] };
      return json({ ...served, templates: (served.templates ?? []).filter((t) => t.bundled === true) });
    }
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    const [root, id, sub, ...rest] = parts;
    const get = method === "GET";

    if (root === "agents") {
      if (!id) {
        // Building an agent is part of the tour: it is made in the page's memory, and runs as a stand-in.
        if (method === "POST" && body.definition && typeof body.definition === "object") return json(world.createAgent(body.definition as Record<string, unknown>), 201);
        if (!get) return refused();
        const all = q.get("archived") === "true" ? [] : world.agents();
        const p = page(all, q, 100);
        return json({ agents: p.items, next_cursor: p.next_cursor });
      }
      const agent = world.agent(id);
      if (!agent) return notFound(`agent ${id}`);
      if (!sub) return get ? json(agent, 200, { etag: agent.home_etag }) : refused();
      if (sub === "definition" && method === "PUT" && body.definition && typeof body.definition === "object") {
        const saved = world.saveDefinition(id, body.definition as Record<string, unknown>, typeof body.note === "string" ? body.note : null)!;
        return json(saved, 200, { etag: saved.home_etag });
      }
      if (sub === "native" && get) return json({ native: agent.definition.native ?? null });
      if (sub === "revisions" && get) return json({ revisions: world.revisions(id), next_cursor: null });
      if (sub === "runs" && get) {
        const p = page(world.runs({ agent: id, status: q.get("status") ?? undefined, archived: q.get("archived") === "true" }), q);
        return json({ runs: p.items, next_cursor: p.next_cursor });
      }
      if (sub === "runs" && method === "POST") {
        const run = world.start(id, (body.input && typeof body.input === "object" ? body.input : {}) as Record<string, unknown>);
        return run ? json(run, 202, { location: `/v2/runs/${run.run_id}` }) : notFound(`agent ${id}`);
      }
      if (sub === "source" && get) return json({ enabled: false, moved: false, state: "needs_connection", blockers: [] });
      if (sub === "learning") {
        const [what, ...more] = rest;
        if (!what && get) return json(world.learning(id));
        if (what === "corrections" && get) { const text = world.learning(id)?.corrections ?? ""; return json({ text, etag: `"${hex(`corrections:${text.length}`, 16)}"`, cap_bytes: 2048 }, 200, { etag: `"${hex(`corrections:${text.length}`, 16)}"` }); }
        if (what === "cost" && get) return json(world.learningCost(id));
        if (what === "promotions" && get) return json(world.promotions(id));
        if (what === "loop" && get) return json(world.loop(id));
        if (what === "audits" && get) return json(world.audits(id));
        if (what === "log" && get) return json({ items: [], total: world.learning(id)?.log.total ?? 0, next_cursor: null });
        if (what === "workflows" && more[1] === "revisions" && more.length === 2 && get) return json(world.workflowRevisions(more[0]));
        if (what === "files") {
          // An approval is the one learning write a tour makes: the workflow that waits for the owner's OK takes it.
          const action = method === "POST" ? more.at(-1) : null;
          const file = (action ? more.slice(0, -1) : more).join("/");
          const text = world.learningFile(file);
          if (text === null) return notFound(`file ${file}`);
          if (action && action !== "approve") return refused();
          if (action) world.approvePending();
          if (!get && !action) return refused();
          return new Response(text, { status: 200, headers: { "content-type": "text/markdown; charset=utf-8", etag: `"${hex(`file:${file}:${action ?? ""}`, 16)}"` } });
        }
      }
      return get ? notFound(`route ${path}`) : refused();
    }

    if (root === "runs") {
      if (!id) {
        if (!get) return refused();
        const p = page(world.runs({ status: q.get("status") ?? undefined, archived: q.get("archived") === "true" }), q);
        return json({ runs: p.items, next_cursor: p.next_cursor });
      }
      const run = world.run(id);
      if (!run) return notFound(`run ${id}`);
      if (!sub) return get ? json(run) : refused();
      if (sub === "timeline" && get) {
        // The cursor is a count of what the reader holds: the rows, and whether the run waits or has ended. A read that
        // holds it all waits, as the server's long poll does, for the story's next beat.
        const mark = () => { const r = world.run(id)!; const rows = world.rows(id)!; return { r, rows, n: rows.length * 8 + (r.pending ? 1 : 0) + (r.ended_at ? 2 : 0) + (rows.some((x) => x.summary?.startsWith("Asked your approval")) ? 4 : 0) + 1 }; };
        const after = q.has("after") ? Number(q.get("after")) : null;
        const until = Date.now() + Math.min(Number(q.get("wait_ms")) || 0, 4000);
        let now = mark();
        while (after !== null && now.n === after && !now.r.ended_at && Date.now() < until && !init?.signal?.aborted) { await wait(250, init?.signal); now = mark(); }
        const unchanged = after !== null && now.n === after;
        return json({ run_id: id, status: now.r.status, state: now.r.state, reset: !unchanged, rows: unchanged ? [] : now.rows, drop: [], next_after: now.n, unchanged, has_more: false, final: !!now.r.ended_at, cost: now.r.cost, poll_after_ms: now.r.ended_at ? 0 : 500 });
      }
      if (sub === "files" && get) {
        const files = world.files(id) ?? {};
        if (!rest.length) return json({ run_id: id, files: Object.entries(files).map(([p, text]) => ({ path: p, size_bytes: new TextEncoder().encode(text).length, modified_at: run.ended_at ?? run.updated_at, content_type: p.endsWith(".csv") ? "text/csv; charset=utf-8" : "text/markdown; charset=utf-8" })), complete: true, truncated: false });
        const text = files[rest.join("/")];
        return text === undefined ? notFound(`file ${rest.join("/")}`) : new Response(text, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      if (sub === "graph" && get) { const g = world.graph(id); return g ? json(g) : notFound(`graph for run ${id}`); }
      if (sub === "trace" && get) return json(world.trace(id));
      if (sub === "usage" && get) return json(world.usage(id));
      if (sub === "learning" && get) return rest[0] === "diff" ? json({ base: null, head: null, files: [] }) : json(world.runLearning(id) ?? null);
      if (sub === "computer" && get) return json({ state: "off", why: "This run has no screen: its agent has no computer.", hold: "agent" });
      if (method === "POST") {
        if (sub === "approvals" && rest[0]) {
          const pending = run.pending?.kind === "approval" && run.pending.id === rest[0];
          if (!pending) return refusal(409, "conflict", "This call no longer waits for an answer.", { reason: "not_pending" });
          world.answer(id, { decision: body.decision === "deny" ? "deny" : "allow" });
          return new Response(null, { status: 204 });
        }
        if (sub === "messages") {
          if (run.pending?.kind !== "question") return refusal(409, "demo_mode", "In demo mode a run takes a message only as the answer to its question.");
          world.answer(id, { text: String(body.content ?? "") });
          return json({ mode: "answer", message_id: `msg_demo_${Date.now()}` }, 202);
        }
        if (sub === "stop" || sub === "cancel") return world.stop(id, sub === "cancel") ? json({ run_id: id, status: sub === "cancel" ? "cancelled" : "completed" }, 202) : refusal(409, "conflict", "The run has already ended.");
        if (sub === "archive" || sub === "unarchive") return json(world.archive(id, sub === "archive"));
      }
      return get ? notFound(`route ${path}`) : refused();
    }

    if (root === "stats" && get) {
      const from = q.get("from");
      return json(world.stats({ ...(from ? { from: Date.parse(from) } : {}), ...(q.get("agent") ? { agent: q.get("agent")! } : {}) }));
    }
    if (root === "triggers") {
      if (!id) return get ? json({ triggers: world.triggers() }) : refused();
      const trigger = world.trigger(id);
      if (!trigger) return notFound(`trigger ${id}`);
      if (!sub) {
        if (get) return json(trigger);
        // Pausing and resuming a trigger is part of the tour; its other edits are not made.
        if (method === "PATCH" && typeof body.enabled === "boolean" && Object.keys(body).length === 1) return json(world.setTriggerEnabled(id, body.enabled));
        return refused();
      }
      if (sub === "firings" && get) return json({ firings: world.firings(id) });
      if (sub === "fire" && method === "POST") return json(world.fire(id));
      return get ? notFound(`route ${path}`) : refused();
    }
    if (root === "observations" && get) {
      const days = Number(q.get("days")) || 30;
      return json({ connectors: [], sessions: [], usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: null, cache_write_tokens: null, total_tokens: 0, cache_hit_rate: null, overflow: false, status: "unavailable", models: [], daily: [] }, limits: { session_retention_days: 90, usage_retention_days: 90, window_start: new Date(world.opened - days * DAY).toISOString() } });
    }
    // What other pages read of the server's settings: in the demo, a server with nothing connected beyond its models.
    if (get && path === "/settings/mcp-servers") return json({ servers: [] });
    if (get && path === "/settings/tools") return json({});
    if (get && path === "/integrations/github") return json({ connected: false });
    if (get && path === "/connectors") return json({ connectors: [] });
    // Suggested agents come from scanning a repository on GitHub, which the demo's server has not connected.
    if (get && path === "/suggestions") return json({ github: { connected: false, app: null, installations: [], install_url: null }, repositories: [], suggestions: [] });
    if (get && path === "/computers") return json({ kinds: [], paired: [] });
    if (method === "POST" && path === "/workflows/validate") return json({ ok: true, issues: [], warnings: [] });
    return get ? notFound(`route ${path}`) : refused();
  };

  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://demo.invalid");
    const method = (init?.method ?? "GET").toUpperCase();
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string" && init.body) { try { const parsed: unknown = JSON.parse(init.body); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>; } catch { /* a body that is not JSON carries nothing the demo reads */ } }
    // A moment, as a server takes: a page's loading state shows as it would.
    await wait(40, init?.signal);
    if (init?.signal?.aborted) throw new DOMException("The request was aborted.", "AbortError");
    return handle(method, url.pathname.replace(/^\/v2(?=\/)/, ""), url.searchParams, body, init, input);
  };
}

/** The demo for a console: its `fetch`, and where a run's file is read from by an address (an image's `src`, a
 *  download's link), since no server holds the demo's files: the file itself, as a data URL. */
export function createDemo({ real }: { real: typeof fetch }): { fetch: typeof fetch; fileUrl: (runId: string, path: string) => string } {
  const world = createWorld();
  return {
    fetch: createDemoFetch({ real, world }),
    fileUrl: (runId, path) => {
      const image = world.page(path);
      if (image) return image;
      const text = world.files(runId)?.[path];
      return `data:text/plain;charset=utf-8,${encodeURIComponent(text ?? "")}`;
    },
  };
}
