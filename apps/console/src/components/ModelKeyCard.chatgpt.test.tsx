import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelKeyCard } from "./ModelKeyCard";
import { NoModelBanner } from "./NoModelBanner";
import { buttonVariants } from "./ui/button";
import { createClient } from "@/lib/client";
import { servedKey } from "@/test/keys";
import type { ChatGPTView, ToolKeys } from "@/lib/v2";

// The first screen of a server with no key: "Continue with ChatGPT" first, beside "Add a key", and plainly what the plan
// runs and what still needs a key; then what runs here, harness by harness. A server with no ChatGPT sign-in offers
// the keys as before. The bar on every other page offers the sign-in first too.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LINE = "Codex and pi agents run on your ChatGPT plan. Claude Agent, OpenCode, Jev decisions and paid tools need their own keys.";
const GATEWAY_NAMES_NONE = "Name the gateway's model in AGENT_MODEL where AgentRun starts, or pick its models in Settings → Model keys → Use a model gateway.";
const REFUSED = "AGENT_MODEL_BASE_URL must be an https URL of a gateway, with a path if it serves the API under one; it is http, not https.";
const KEYS: ToolKeys = {
  keys: [
    servedKey({ id: "anthropic", kind: "model", label: "Anthropic", fields: [{ name: "ANTHROPIC_API_KEY", set: false, source: null }], unlocks: [], harnesses: ["pi"], check: null }),
    servedKey({ id: "openrouter", kind: "model", label: "OpenRouter", fields: [{ name: "OPENROUTER_API_KEY", set: false, source: null }], unlocks: [], harnesses: ["pi"], check: null }),
  ],
  reenter: null,
};
// As a server with no key and no sign-in serves them: pi runs here with no default model, codex does not, and both would
// on the plan (`needs` lists chatgpt); Claude Agent needs a key whatever the plan.
const SIGN_IN = "or sign in with ChatGPT (Settings → Model keys) to run it on your ChatGPT plan.";
const HARNESSES = [
  { id: "pi", available: true, default_model: null, reason: `No model yet: add a model key in Settings → Model keys; ${SIGN_IN}`, needs: ["key", "chatgpt"] },
  { id: "codex", available: false, default_model: null, reason: `codex needs OPENAI_API_KEY, OPENROUTER_API_KEY (OpenAI's models through OpenRouter), or a gateway in AGENT_MODEL_BASE_URL; ${SIGN_IN}`, needs: ["key", "chatgpt"] },
  { id: "claude-agent", available: false, reason: "Claude Agent needs an Anthropic or OpenRouter key.", needs: ["key"] },
];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
// GET /v2/settings/model-gateway as an environment's gateway serves it: `problem` is why serve refuses its address, else null.
const gatewayView = (problem: string | null) => ({ source: "env", base_url: "http://gw.example/v1", ids: "as_named", models: { default: null, fast: null, strong: null }, set_at_start: ["AGENT_MODEL_BASE_URL"], secret: { set: true, source: "env" }, problem });
function server(gateway: string | null = null) {
  const calls: string[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (String(url) === "/v2/settings/tool-keys") return json(200, KEYS);
    if (String(url) === "/v2/settings/model-gateway") return json(200, gatewayView(gateway));
    if (String(url) === "/v2/settings/chatgpt/sign-in") return json(200, { authorize_url: "https://auth.openai.com/api/accounts/authorize?state=fake", expires_at: new Date(Date.now() + 600_000).toISOString() });
    return json(200, { state: "pending" });
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls };
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

async function open(props: Partial<Parameters<typeof ModelKeyCard>[0]>, gateway: string | null = null) {
  const { v2, calls } = server(gateway);
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(ModelKeyCard, { v2, writable: true, needs: "key", ...props })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const buttons = () => [...host.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
  const click = async (label: RegExp) => { await act(async () => { [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()))!.click(); }); await settle(); };
  return { host, buttons, click, calls };
}

describe("ModelKeyCard, a server with no key that offers the ChatGPT sign-in", () => {
  it("leads with Continue with ChatGPT beside Add a key, says what the plan runs, and lists what runs here", async () => {
    const card = await open({ plan: { state: "signed_out" }, harnesses: HARNESSES });
    expect(card.buttons().slice(0, 2)).toEqual(["Continue with ChatGPT", "Add a key"]);
    const primary = [...card.host.querySelectorAll("button")].find((b) => b.textContent === "Continue with ChatGPT")!;
    // Sign-in uses the shared main-action treatment; its colors are covered by the primitive's tests.
    expect(primary.className).toBe(buttonVariants({ variant: "primary", size: "sm" }));
    expect(card.host.textContent).toContain(LINE);
    // The providers wait behind Add a key.
    expect(card.host.querySelector('[role="group"][aria-label="Provider"]')).toBeNull();
    await card.click(/^Add a key$/);
    expect([...card.host.querySelectorAll('[role="group"][aria-label="Provider"] button')].map((b) => b.textContent)).toEqual(["Anthropic", "OpenRouter"]);
    const list = card.host.querySelector('[aria-label="What runs here"]')!;
    expect([...list.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      expect.stringMatching(/^Piruns after Continue with ChatGPTNo model yet: .*or sign in with ChatGPT \(Settings → Model keys\) to run it on your ChatGPT plan\.$/),
      expect.stringMatching(/^Codexruns after Continue with ChatGPTcodex needs OPENAI_API_KEY.*to run it on your ChatGPT plan\.$/),
      expect.stringMatching(/^Claude.*needs a key.*Claude Agent needs an Anthropic or OpenRouter key\.$/),
    ]);
  });

  // Behind a gateway, signing in gives no default (serve's settingsModel takes the plan only without AGENT_MODEL_BASE_URL)
  // and the provider keys are not used (GATEWAY_RUNS): what runs an agent that names no model is the gateway's model.
  it("on a gateway server that names no model, says to name the gateway's model, and offers neither the sign-in nor a key", async () => {
    const card = await open({ plan: { state: "signed_out" }, harnesses: HARNESSES, source: "gateway", model: null, routePrefix: "agent-model" });
    expect(card.host.querySelector("h2")?.textContent).toBe("Name the gateway's model to run agents");
    expect(card.host.textContent).toContain(GATEWAY_NAMES_NONE);
    expect(card.buttons()).not.toContain("Continue with ChatGPT");
    expect(card.host.querySelector('[role="group"][aria-label="Provider"]')).toBeNull();
    expect(card.host.textContent).not.toContain("No model provider's key is set");
  });

  // A gateway address serve refuses (modelGatewayBase) runs no model, whatever AGENT_MODEL names, and no key or sign-in
  // fixes it: the card says so in the server's words (GET /v2/settings/model-gateway's `problem`).
  it.each([["names a default", "agent-model/gpt-6-luna"], ["names no model", null]])("on a gateway server whose address is refused (and that %s), says why in the server's words, with no sign-in or key", async (_, model) => {
    const card = await open({ plan: { state: "signed_out" }, harnesses: HARNESSES, source: "gateway", model, routePrefix: "agent-model" }, REFUSED);
    expect(card.calls).toContain("GET /v2/settings/model-gateway");
    expect(card.host.querySelector("h2")?.textContent).toBe("This server's model gateway is refused");
    expect(card.host.textContent).toContain(REFUSED);
    expect(card.host.textContent).not.toContain(GATEWAY_NAMES_NONE);
    expect(card.buttons()).not.toContain("Continue with ChatGPT");
    expect(card.host.querySelector('[role="group"][aria-label="Provider"]')).toBeNull();
    expect(card.host.textContent).not.toContain("No model provider's key is set");
  });

  // A gateway server whose AGENT_MODEL is a plan model (chatgpt/<id>) runs an agent with no model on the plan, so signed
  // out it can't run one until someone signs in (serve's planChoice), and the sign-in is the card's way on. Capabilities
  // send that default under the gateway's route_prefix: agent-model/chatgpt/<id>.
  it("on a gateway server whose default is a plan model, offers the sign-in and says what the plan runs", async () => {
    const card = await open({ plan: { state: "signed_out" }, harnesses: HARNESSES, source: "gateway", model: "agent-model/chatgpt/gpt-6.1-sol", routePrefix: "agent-model" });
    expect(card.buttons().slice(0, 2)).toEqual(["Continue with ChatGPT", "Add a key"]);
    expect(card.host.textContent).toContain(LINE);
  });

  // A gateway's own default (agent-model/anthropic/claude-x) runs on the gateway: the provider under the prefix is the
  // gateway's to route, so its key isn't the one to ask for.
  it("on a gateway server whose default is the gateway's own model, doesn't ask for that model's provider key", async () => {
    const card = await open({ plan: { state: "signed_out" }, harnesses: HARNESSES, source: "gateway", model: "agent-model/anthropic/claude-x", routePrefix: "agent-model" });
    expect(card.host.textContent).not.toContain("Save the Anthropic key");
  });

  it("Continue with ChatGPT starts the sign-in and keeps the card while it waits (onPlan)", async () => {
    vi.stubGlobal("open", vi.fn(() => ({ location: { href: "" }, opener: null, close() {} })));
    const seen: ChatGPTView[] = [];
    const card = await open({ plan: { state: "signed_out" }, onPlan: (v) => seen.push(v) });
    await card.click(/^Continue with ChatGPT$/);
    expect(card.calls).toContain("POST /v2/settings/chatgpt/sign-in");
    expect(seen.at(-1)?.state).toBe("pending");
    expect(card.host.textContent).toContain("paste it here");
  });

  it("signed in (the first sign-in), says who and OpenAI's words on usage, and Done lets the card go", async () => {
    let done = 0;
    const card = await open({ plan: { state: "signed_in", email: "person@example.com", plan: "plus", models: ["gpt-6.1-sol"] }, onDone: () => { done++; } });
    expect(card.host.textContent).toContain("Signed in as person@example.com (Plus)");
    expect(card.host.textContent).toContain("Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings.");
    expect(card.host.textContent).not.toContain("Add a model key");
    await card.click(/^Done$/);
    expect(done).toBe(1);
  });

  it("signed in, once capabilities name the plan's model the server's default (chatgpt/<id>), still says who and lets the card go", async () => {
    let done = 0;
    const card = await open({ needs: null, model: "chatgpt/gpt-6.1-sol", plan: { state: "signed_in", email: "person@example.com", plan: "plus", models: ["gpt-6.1-sol"] }, onDone: () => { done++; } });
    expect(card.host.textContent).toContain("Signed in as person@example.com (Plus)");
    expect(card.host.textContent).not.toContain("Add a model key");
    await card.click(/^Done$/);
    expect(done).toBe(1);
  });

  it("with no ChatGPT sign-in on the server, offers the keys as before", async () => {
    const card = await open({ plan: null });
    expect(card.buttons()).not.toContain("Continue with ChatGPT");
    expect([...card.host.querySelectorAll('[role="group"][aria-label="Provider"] button')].map((b) => b.textContent)).toEqual(["Anthropic", "OpenRouter"]);
  });
});

describe("NoModelBanner and the ChatGPT sign-in", () => {
  it("signed out with no key, offers Continue with ChatGPT first, then a key", () => {
    const html = renderToStaticMarkup(createElement(NoModelBanner, { needs: "key", settings: true, source: "providers", chatgpt: true }));
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toMatch(/^No model yet\. Continue with ChatGPT/);
    expect(text.indexOf("Continue with ChatGPT")).toBeLessThan(text.indexOf("Add a key"));
    expect(html).toMatch(/<a href="#\/settings\/keys"[^>]*>Continue with ChatGPT<\/a>/);
    expect(text).toContain("Codex and pi agents run on your ChatGPT plan");
  });

  it("source chatgpt: the plan is signed in, so the bar names the plan's default model and no key", () => {
    const html = renderToStaticMarkup(createElement(NoModelBanner, { needs: "model", settings: true, source: "chatgpt", model: "chatgpt/gpt-6.1-sol" }));
    expect(html).toContain("This server&#x27;s default model doesn&#x27;t run here");
    const plain = renderToStaticMarkup(createElement(NoModelBanner, { needs: "key", settings: true, source: "providers" }));
    expect(plain).not.toContain("ChatGPT");
  });
});
