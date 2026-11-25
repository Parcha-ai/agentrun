import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "./App";

// A new agent's place through the real path: the Agents page reads capabilities and GET /v2/computers, and the editor's
// Computer step shows the computers' kinds. With no default place (default_place null: no Docker box, and a runner with
// no shell), no kind is picked until the person picks one, every kind (None, the runner, included) sets the agent's
// computer when clicked, and Create sends it. Where the server has a default (Docker's box, or the runner in Mode 2),
// the step starts on it, as before.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); localStorage.clear(); location.hash = ""; });

const NAME_A_BOX = "name a box: this server has no Docker box for a new agent. Set place to {mode: sandbox, box: <one of: daytona>}, or to {mode: runner} to run without a shell.";
const harnesses = ["pi"];
const TOOLS = [{ name: "read", available: true, harnesses }, { name: "write", available: true, harnesses }, { name: "bash", available: true, sandbox_only: true, harnesses }];
const KINDS = [
  { kind: "none", offered: true, groups: [], tools: ["read", "write"], settings: [], record: { available: false, why: "fixture: no computer" }, providers: [] },
  { kind: "sandbox", offered: true, groups: ["exec", "files", "processes"], tools: ["read", "write", "bash"], settings: ["image", "persistent", "gpu"], record: { available: false, why: "fixture: a sandbox has no screen to record" }, providers: [
    { id: "docker", name: "Docker", secrets: [], required: [], ready: false, why: "fixture: Docker isn't running", metered: false },
    { id: "daytona", name: "Daytona", secrets: [], required: [], ready: true, metered: true },
  ] },
];

async function open(places: Record<string, unknown>, dockerReady = false) {
  const writes: { definition: Record<string, unknown> }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const kinds = dockerReady ? KINDS.map((k) => ({ ...k, providers: k.providers.map((p) => (p.id === "docker" ? { ...p, ready: true, why: undefined } : p)) })) : KINDS;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://serve.test").pathname;
    if (init?.method === "POST" && path === "/v2/agents") {
      const body = JSON.parse(String(init.body)); writes.push(body);
      return json({ agent_id: "shelly", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: body.definition });
    }
    if (path === "/v2/auth/session") return json({ password_set: true, signed_in: true, secrets_writable: true });
    if (path === "/v2/capabilities") return json({ models: { ready: true }, harnesses: [{ id: "pi", available: true }], tools: TOOLS, features: {}, places: { modes: ["runner", "sandbox"], allow: [], ...places } });
    if (path === "/v2/agents" || path === "/v2/runs") return json({ agents: [], runs: [], next_cursor: null });
    if (path === "/v2/computers") return json({ kinds });
    if (path === "/v2/settings/tools") return json({});
    return json({ error: { code: "not_found", message: path, retryable: false } }, 404);
  });
  location.hash = `#/agents/new?${new URLSearchParams({ editor: "true", instructions: "Probe." })}`;
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => { root!.render(createElement(App)); });
  const settle = async () => { for (let i = 0; i < 20; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  await settle();
  await act(async () => {
    const name = host.querySelector<HTMLInputElement>("#agent-name")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Shelly");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { [...host.querySelectorAll("button")].find((b) => /Computer/.test(b.textContent ?? ""))!.click(); });
  await settle();
  const radio = (name: string, value: string) => host.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
  const create = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Create")!;
  const click = async (el: HTMLElement | null) => { await act(async () => { el!.click(); }); };
  return { host, writes, radio, create, click };
}

it("with no default place and the computers read, no kind is picked and Create waits; None, clicked, makes the agent on the runner", async () => {
  const form = await open({ default_place: null, default_reason: NAME_A_BOX, boxes: [{ id: "docker", available: false, state: "unavailable", reason: "fixture: Docker isn't running" }, { id: "daytona", available: true, state: "ready" }] });
  expect(form.radio("computer-kind", "none")).not.toBeNull();
  expect(form.host.querySelector('input[name="computer-kind"]:checked')).toBeNull();
  expect(form.create().disabled).toBe(true);
  await form.click(form.radio("computer-kind", "none"));
  expect(form.radio("computer-kind", "none")!.checked).toBe(true);
  expect(form.create().disabled).toBe(false);
  await form.click(form.create());
  expect(form.writes).toHaveLength(1);
  expect(form.writes[0].definition.computer).toEqual({ kind: "none" });
});

it("with no default place, a box picked in the Computer step is the box Create sends", async () => {
  const form = await open({ default_place: null, default_reason: NAME_A_BOX, boxes: [{ id: "docker", available: false, state: "unavailable", reason: "fixture: Docker isn't running" }, { id: "daytona", available: true, state: "ready" }] });
  await form.click(form.radio("computer-kind", "sandbox"));
  expect(form.radio("computer-provider", "daytona")!.checked).toBe(true);
  expect(form.create().disabled).toBe(false);
  await form.click(form.create());
  expect(form.writes).toHaveLength(1);
  expect(form.writes[0].definition.computer).toEqual({ kind: "sandbox", provider: "daytona" });
});

it("where the server has a default, the Computer step starts on it as before: Docker's box, or None on Mode 2's runner", async () => {
  const docker = await open({ default_place: { mode: "sandbox", box: "docker" }, boxes: [{ id: "docker", available: true, state: "ready" }] }, true);
  expect(docker.radio("computer-kind", "sandbox")!.checked).toBe(true);
  expect(docker.radio("computer-provider", "docker")!.checked).toBe(true);
  expect(docker.create().disabled).toBe(false);
  act(() => root?.unmount()); root = undefined; document.body.innerHTML = "";
  const runner = await open({ default_place: { mode: "runner" }, boxes: [{ id: "docker", available: false, state: "unavailable", reason: "fixture: Docker isn't running" }] });
  expect(runner.radio("computer-kind", "none")!.checked).toBe(true);
  expect(runner.create().disabled).toBe(false);
});
