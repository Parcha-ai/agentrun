import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

// #/free's hardware-fit slot is the first screen's Free local model card. A pull there reads the capabilities again, and
// the shelf's Use free then opens Apply on `ollama/<tag>` (App's templatePick), though the server's default is another
// free model.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });

const GIB = 1024 ** 3;
const CATALOG = { id: "openrouter/example/free-model:free", context_window: 262144 };
const LOCAL = { id: "ollama/qwen3:8b", context_window: 65536 };
const view = (pull: unknown) => ({
  machine: { platform: "linux", arch: "x64", ram_bytes: 32 * GIB, gpu: { kind: "unknown" } },
  ollama: { asked: true, reachable: true, version: "0.40.17" },
  recommended: { tag: "qwen3:8b", why: "qwen3:8b fits this machine's 32.0 GiB of memory (it needs 15 GiB).", pulled: false },
  pull, can_pull: true, refused: null,
});
const FIELD = {
  id: "field-monitor", bundled: false, source: null, sha: null, publisher: null, category: null, tags: ["free"],
  name: "field-monitor", display_name: "Field monitor (free to run)", version: "0.1.0", description: "Watches a field.", license: null, author: null, repository: null, output: null,
  input_schema: null, harness: ["pi"], model: { tier: "fast" }, effort: null, tools: null, tool_policy: null, computer: null, needs: null,
  computer_here: null, checkout: null, secrets: [], budget: null, learning: false, approvals_default: "ask", triggers: [], skills: [],
  evals: [], mcp: [], parameters: { type: "object", additionalProperties: false, properties: {} },
};

async function openFree() {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  let pulled = false;
  const applied: unknown[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://serve.test");
    const method = init?.method ?? "GET";
    if (u.pathname === "/v2/auth/session") return json({ password_set: true, signed_in: true, secrets_writable: true });
    // The server's default stays the free catalog model after the pull: only the pulled tag says ollama/qwen3:8b.
    if (u.pathname === "/v2/capabilities") return json({
      harnesses: [{ id: "pi", available: true, default_model: CATALOG.id, models: pulled ? [CATALOG.id, LOCAL.id] : [CATALOG.id], free_models: pulled ? [LOCAL, CATALOG] : [CATALOG] }],
      tools: [], features: {}, models: { source: "providers", default: CATALOG.id, ready: true },
    });
    if (u.pathname === "/v2/settings/local-model" && method === "GET") return json(view(null));
    if (u.pathname === "/v2/settings/local-model/pull" && method === "POST") {
      pulled = true;
      return json(view({ tag: "qwen3:8b", state: "done", status: "success", completed_bytes: 5 * GIB, total_bytes: 5 * GIB }), 202);
    }
    if (u.pathname === "/v2/templates" && method === "GET") return json({ templates: [FIELD] });
    if (u.pathname === "/v2/templates/field-monitor/apply" && method === "POST") { applied.push(JSON.parse(String(init!.body))); return json({ agent_id: "made-1", triggers: [], warnings: [] }, 201); }
    if (u.pathname === "/v2/settings/mcp-servers") return json({ servers: [] });
    if (u.pathname === "/v2/settings/email") return json({ configured: false });
    if (u.pathname === "/v2/runs") return json({ runs: [], next_cursor: null });
    if (u.pathname === "/v2/agents") return json({ agents: [], next_cursor: null });
    return json({ error: { code: "not_found", message: u.pathname, retryable: false } }, 404);
  });
  location.hash = "#/free";
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(App)));
  const wait = async (ok: () => boolean, what: string) => {
    const end = Date.now() + 4000;
    while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(ok(), what).toBe(true);
  };
  const button = (label: RegExp, scope: ParentNode = host) => [...scope.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  const slot = () => host.querySelector('[data-testid="free-fit-slot"]');
  const agent = () => host.querySelector('section[aria-label="Agents that run free"] article[aria-label="Field monitor (free to run)"]');
  return { host, wait, button, slot, agent, applied };
}

it("on #/free with no local model, the Free local model card is in the hardware-fit slot", async () => {
  const free = await openFree();
  await free.wait(() => !!free.slot()?.querySelector('section[aria-label="Free local model"]'), "the card is in the slot");
  await free.wait(() => !!free.button(/^Pull qwen3:8b$/, free.slot()!), "the card offers the pull");
});

it("after a pull ends there, Use free applies the template with overrides.model ollama/<tag>, not the server's free default", async () => {
  const free = await openFree();
  await free.wait(() => !!free.agent(), "the free template is listed");
  expect(free.agent()!.textContent).toContain("free-model:free");
  await free.wait(() => !!free.slot() && !!free.button(/^Pull qwen3:8b$/, free.slot()!), "the card offers the pull");
  await act(async () => { free.button(/^Pull qwen3:8b$/, free.slot()!)!.click(); });
  await free.wait(() => !!free.agent()?.textContent?.includes("qwen3:8b · local (Ollama)"), "with the capabilities read again, the template runs on the pulled tag");
  await act(async () => { free.button(/^Use free$/, free.agent()!)!.click(); });
  expect(location.hash).toBe(`#/templates/field-monitor?model=${encodeURIComponent(LOCAL.id)}`);
  await free.wait(() => !!free.button(/^Apply$/), "the Apply screen opens");
  await act(async () => { free.button(/^Apply$/)!.click(); });
  await free.wait(() => free.applied.length > 0, "the template is applied");
  expect(free.applied[0]).toMatchObject({ overrides: { model: LOCAL.id } });
});

const { App } = await import("./App");
