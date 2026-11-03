import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ModelKeyCard } from "./ModelKeyCard";
import { createClient } from "@/lib/client";
import type { ToolKey, ToolKeys } from "@/lib/v2";

// The first screen's model key card, over GET and PUT /v2/settings/tool-keys: it offers the server's model keys, saves
// the one picked through its own route, leaves no typed value in the page, and says what no key fixes.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** An obvious fake: not a key anywhere. */
const FAKE = "not-a-real-key-0123456789";
const model = (id: string, label: string, name: string, source: "server" | "stored" | null = null): ToolKey => ({ id, kind: "model", label, fields: [{ name, set: source !== null, source }], unlocks: [], harnesses: ["pi"] });
const VIEW: ToolKeys = {
  keys: [
    { id: "parallel", kind: "tool", label: "Parallel", fields: [{ name: "PARALLEL_API_KEY", set: false, source: null }], unlocks: ["web_fetch"], harnesses: ["pi"] },
    model("anthropic", "Anthropic", "ANTHROPIC_API_KEY"), model("openai", "OpenAI", "OPENAI_API_KEY"), model("openrouter", "OpenRouter", "OPENROUTER_API_KEY"),
  ],
  reenter: null,
};

type Call = { method: string; path: string; body: unknown };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function server(write: (call: Call) => Response = () => new Response(null, { status: 204 })) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return call.method === "GET" ? json(200, VIEW) : write(call);
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls };
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

async function open(props: Omit<Parameters<typeof ModelKeyCard>[0], "v2">, v2: ReturnType<typeof createClient>) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(ModelKeyCard, { v2, ...props })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  const click = async (label: RegExp) => { await act(async () => { button(label)!.click(); }); await settle(); };
  const input = (name: string) => host.querySelector(`input[name="${name}"]`) as HTMLInputElement | null;
  const type = async (name: string, value: string) => {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(name), value); input(name)!.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  return { host, button, click, input, type, settle };
}

describe("ModelKeyCard", () => {
  it("offers the model keys only, saves the one picked through its own route, and keeps no typed value", async () => {
    const { v2, calls } = server();
    let saved = 0;
    const card = await open({ needs: "key", atRest: "sealed", onSaved: () => { saved++; } }, v2);
    expect(card.host.textContent).toContain("Add a model key to run agents");
    const offered = [...card.host.querySelectorAll('[role="group"][aria-label="Provider"] button')].map((b) => b.textContent);
    expect(offered).toEqual(["Anthropic", "OpenAI", "OpenRouter"]);
    expect(card.input("ANTHROPIC_API_KEY")).toBeNull();
    await card.click(/^Anthropic$/);
    expect(card.input("ANTHROPIC_API_KEY")?.type).toBe("password");
    await card.type("ANTHROPIC_API_KEY", FAKE);
    await card.click(/^Save$/);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([{ method: "PUT", path: "/v2/settings/tool-keys/anthropic", body: { values: { ANTHROPIC_API_KEY: FAKE } } }]);
    expect(saved).toBe(1);
    expect(card.input("ANTHROPIC_API_KEY")).toBeNull();
    expect(card.host.innerHTML).not.toContain(FAKE);
  });

  // AGENT_MODEL names a model the server knows whose provider has no key: another provider's key would not run it (the
  // server's own model wins), so the card offers that provider's key alone, and names the model.
  it("when the server's default model names a provider with no key, offers that provider's key alone, and names the model", async () => {
    const { v2 } = server();
    const card = await open({ needs: "key", model: "anthropic/claude-sonnet-5-5", atRest: "sealed" }, v2);
    const offered = [...card.host.querySelectorAll('[role="group"][aria-label="Provider"] button')].map((b) => b.textContent);
    expect(offered).toEqual(["Anthropic"]);
    expect(card.host.textContent).toContain("anthropic/claude-sonnet-5-5");
    const any = await (async () => { act(() => root!.unmount()); root = undefined; return open({ needs: "key", model: null, atRest: "sealed" }, v2); })();
    expect([...any.host.querySelectorAll('[role="group"][aria-label="Provider"] button')].map((b) => b.textContent)).toEqual(["Anthropic", "OpenAI", "OpenRouter"]);
  });

  it("shows a refused save and calls nothing saved", async () => {
    const { v2 } = server(() => json(500, { error: { code: "internal", message: "the disk is full", retryable: true } }));
    let saved = 0;
    const card = await open({ needs: "key", atRest: "sealed", onSaved: () => { saved++; } }, v2);
    await card.click(/^OpenAI$/);
    await card.type("OPENAI_API_KEY", FAKE);
    await card.click(/^Save$/);
    expect(saved).toBe(0);
    expect(card.host.textContent).toContain("The key was not saved");
    expect(card.host.textContent).toContain("the disk is full");
    expect(card.host.innerHTML).not.toContain(FAKE);
  });

  it("on a server that can't store keys, names where to set them and offers no form", async () => {
    const { v2 } = server();
    const card = await open({ needs: "key", atRest: "unavailable" }, v2);
    expect(card.host.textContent).toContain("This server can't store keys");
    expect(card.host.textContent).toContain("ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY");
    expect(card.host.textContent).not.toContain("PARALLEL_API_KEY");
    expect(card.button(/^Anthropic$/)).toBeUndefined();
  });

  it("when the server's own default model is the problem, says so and offers no key", async () => {
    const { v2, calls } = server();
    const card = await open({ needs: "model", atRest: "sealed" }, v2);
    expect(card.host.textContent).toContain("AGENT_MODEL names a model it doesn't know");
    expect(card.button(/^Anthropic$/)).toBeUndefined();
    expect(calls).toEqual([]);
  });
});
