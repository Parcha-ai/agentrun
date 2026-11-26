import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ANALYTICS } from "@/components/AgentAnalytics.sample";

// The first screen's Free local model card hands the tag it pulled to the first screen's agent-create flow: Try it makes
// its agent on `ollama/<tag>`, though Ollama lists another tools model the server holds as its default.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });

const GIB = 1024 ** 3;
const view = (pull: unknown, pulled: boolean) => ({
  machine: { platform: "linux", arch: "x64", ram_bytes: 32 * GIB, gpu: { kind: "unknown" } },
  ollama: { asked: true, reachable: true, version: "0.40.17" },
  recommended: { tag: "qwen3:8b", why: "qwen3:8b fits this machine's 32.0 GiB of memory (it needs 15 GiB).", pulled },
  pull, can_pull: true, refused: null,
});

it("after a pull, Try it makes its agent on the pulled tag, not on the other tools model the server holds as default", async () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  let pulled = false;
  const made: { definition: { harness?: string; model?: string } }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://serve.test");
    const method = init?.method ?? "GET";
    if (u.pathname === "/v2/auth/session") return json({ password_set: true, signed_in: true, secrets_writable: true });
    if (u.pathname === "/v2/capabilities") return json(pulled
      ? { harnesses: [{ id: "pi", available: true, default_model: "ollama/synth-tools:latest", models: ["ollama/synth-tools:latest", "ollama/qwen3:8b"] }], tools: [], features: {}, models: { source: "providers", default: "ollama/synth-tools:latest", ready: true } }
      : { harnesses: [{ id: "pi", available: true, default_model: null, models: [] }], tools: [], features: {}, models: { source: "providers", default: null, ready: false, needs: "key" } });
    if (u.pathname === "/v2/settings/local-model" && method === "GET") return json(view(null, false));
    if (u.pathname === "/v2/settings/local-model/pull" && method === "POST") {
      pulled = true;
      return json(view({ tag: "qwen3:8b", state: "done", status: "success", completed_bytes: 5 * GIB, total_bytes: 5 * GIB }, false), 202);
    }
    if (u.pathname === "/v2/stats") return json({ agents: 0, runs: { total: 0, active: 0, needs_input: 0, failed: 0, status_unknown: 0, needs_review: 0 }, per_agent: [], cost: { usd: null, basis: null, unknown_runs: 0 }, archived: { agents: 0, runs: 0 }, analytics: { ...ANALYTICS, by_source: [] } });
    if (u.pathname === "/v2/runs") return json({ runs: [], next_cursor: null });
    if (u.pathname === "/v2/agents" && method === "POST") { made.push(JSON.parse(String(init!.body))); return json({ agent_id: "made-1" }, 201); }
    if (u.pathname === "/v2/agents") return json({ agents: [], next_cursor: null });
    if (u.pathname === "/v2/agents/made-1/runs" && method === "POST") return json({ run: { run_id: "run-1" } }, 202);
    return json({ error: { code: "not_found", message: u.pathname, retryable: false } }, 404);
  });
  location.hash = "";
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(App)));
  const wait = async (ok: () => boolean, what: string) => {
    const end = Date.now() + 4000;
    while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(ok(), what).toBe(true);
  };
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  await wait(() => !!button(/^See templates$/), "Start here offers its templates");
  await act(async () => { button(/^See templates$/)!.click(); });
  await wait(() => !!button(/^Pull qwen3:8b$/), "the Free local model card offers the pull");
  await act(async () => { button(/^Pull qwen3:8b$/)!.click(); });
  await wait(() => !!button(/^Try it$/), "with the capabilities read again, a template runs");
  await act(async () => { button(/^Try it$/)!.click(); });
  await wait(() => made.length > 0, "the template's agent is made");
  expect(made[0]!.definition).toMatchObject({ harness: "pi", model: "ollama/qwen3:8b" });
});

it("a capabilities read that lists the model while the pull's progress is still being read keeps the card up until it sees the pull end, so Try it runs on the pulled tag", async () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const pulling = { tag: "qwen3:8b", state: "pulling", status: "pulling manifest", completed_bytes: GIB, total_bytes: 5 * GIB };
  const done = { tag: "qwen3:8b", state: "done", status: "success", completed_bytes: 5 * GIB, total_bytes: 5 * GIB };
  // The server holds the pulled tag as soon as the pull starts; the card's progress reads see the end only once let go.
  let started = false, ended = false;
  const made: { definition: { harness?: string; model?: string } }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://serve.test");
    const method = init?.method ?? "GET";
    if (u.pathname === "/v2/auth/session") return json({ password_set: true, signed_in: true, secrets_writable: true });
    if (u.pathname === "/v2/capabilities") return json(started
      ? { harnesses: [{ id: "pi", available: true, default_model: "ollama/synth-tools:latest", models: ["ollama/synth-tools:latest", "ollama/qwen3:8b"] }], tools: [], features: {}, models: { source: "providers", default: "ollama/synth-tools:latest", ready: true } }
      : { harnesses: [{ id: "pi", available: true, default_model: null, models: [] }], tools: [], features: {}, models: { source: "providers", default: null, ready: false, needs: "key" } });
    if (u.pathname === "/v2/settings/local-model" && method === "GET") return json(view(started ? (ended ? done : pulling) : null, false));
    if (u.pathname === "/v2/settings/local-model/pull" && method === "POST") { started = true; return json(view(pulling, false), 202); }
    if (u.pathname === "/v2/stats") return json({ agents: 0, runs: { total: 0, active: 0, needs_input: 0, failed: 0, status_unknown: 0, needs_review: 0 }, per_agent: [], cost: { usd: null, basis: null, unknown_runs: 0 }, archived: { agents: 0, runs: 0 }, analytics: { ...ANALYTICS, by_source: [] } });
    if (u.pathname === "/v2/runs") return json({ runs: [], next_cursor: null });
    if (u.pathname === "/v2/agents" && method === "POST") { made.push(JSON.parse(String(init!.body))); return json({ agent_id: "made-1" }, 201); }
    if (u.pathname === "/v2/agents") return json({ agents: [], next_cursor: null });
    if (u.pathname === "/v2/agents/made-1/runs" && method === "POST") return json({ run: { run_id: "run-1" } }, 202);
    return json({ error: { code: "not_found", message: u.pathname, retryable: false } }, 404);
  });
  location.hash = "";
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(App)));
  const wait = async (ok: () => boolean, what: string) => {
    const end = Date.now() + 6000;
    while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(ok(), what).toBe(true);
  };
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  const card = () => host.querySelector('section[aria-label="Free local model"]');
  await wait(() => !!button(/^See templates$/), "Start here offers its templates");
  await act(async () => { button(/^See templates$/)!.click(); });
  await wait(() => !!button(/^Pull qwen3:8b$/), "the Free local model card offers the pull");
  await act(async () => { button(/^Pull qwen3:8b$/)!.click(); });
  await wait(() => card()?.getAttribute("data-local-model") === "pulling", "the pull is under way");
  // Coming back into view reads the capabilities: a model is ready now, before the card has seen its pull end.
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await wait(() => !!button(/^Try it$/), "the capabilities read lists the model");
  expect(card(), "the card stays while its pull is under way").not.toBeNull();
  ended = true;
  await wait(() => card()?.getAttribute("data-local-model") === "ready", "the card sees the pull end");
  await act(async () => { button(/^Done$/)!.click(); });
  expect(card(), "Done lets the card go").toBeNull();
  await act(async () => { button(/^Try it$/)!.click(); });
  await wait(() => made.length > 0, "the template's agent is made");
  expect(made[0]!.definition).toMatchObject({ harness: "pi", model: "ollama/qwen3:8b" });
});

const { App } = await import("./App");
