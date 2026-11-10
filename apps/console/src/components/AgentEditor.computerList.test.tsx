import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditPage } from "./AgentsPage";
import { toolOffers } from "@/lib/agentForm";
import { createClient } from "@/lib/client";
import { placesOf } from "@/lib/place";

// The Computer step's kinds come from GET /v2/computers (each kind, offered or not, with its providers and tools), read
// by the editor's page; capabilities.computers names only the kinds offered, so it is not that list. A server that
// answers no computers list leaves the step on where runs go (places).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const KINDS = [
  { kind: "none", offered: true, groups: [], tools: ["read", "write", "edit", "bash"], providers: [] },
  { kind: "sandbox", offered: true, groups: ["exec", "files", "processes"], tools: ["read", "write", "edit", "bash", "bash_background"], providers: [{ id: "faux-sandbox", name: "Faux sandbox", secrets: [], required: [], ready: true }] },
];
const CAPS = {
  harnesses: [{ id: "pi", available: true }], tools: toolOffers([{ name: "read", available: true, harnesses: ["pi", "claude-agent", "codex", "opencode"] }]), thinking: [],
  places: placesOf({ places: { modes: ["runner", "sandbox"], boxes: [{ id: "docker", available: true }] } }),
};

async function open(computers: () => Response) {
  const asked: string[] = [];
  const fetch = (async (url: string) => {
    const path = new URL(String(url), "http://serve.test").pathname;
    asked.push(path);
    if (path === "/v2/computers") return computers();
    return json(404, { error: { code: "not_found", message: path, retryable: false } });
  }) as typeof globalThis.fetch;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentEditPage, { v2: createClient({ fetch }), caps: CAPS, agentId: null, go: () => {} })));
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { ([...host.querySelectorAll("ol button")].find((b) => /Computer/.test(b.textContent ?? "")) as HTMLButtonElement).click(); });
  return { host, asked };
}

describe("the Computer step's kinds", () => {
  it("are read from GET /v2/computers", async () => {
    const { host, asked } = await open(() => json(200, { kinds: KINDS }));
    expect(asked).toContain("/v2/computers");
    expect([...host.querySelectorAll('input[name="computer-kind"]')].map((x) => (x as HTMLInputElement).value)).toEqual(["none", "sandbox"]);
  });

  it("on a server that answers no computers list, the step shows where runs go", async () => {
    const { host } = await open(() => json(404, { error: { code: "not_found", message: "no route", retryable: false } }));
    expect(host.querySelector('input[name="computer-kind"]')).toBeNull();
    expect(host.querySelector('[aria-label="Where it runs"]')).not.toBeNull();
  });
});
