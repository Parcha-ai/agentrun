import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createClient, type Capabilities } from "@/lib/client";
import { SettingsPage } from "./SettingsPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

// A server with no tool-key extension still has connection and capability settings; it must never receive a key call.
it("shows the signed-in server and unavailable capabilities without calling unsupported key routes", async () => {
  const fetch = vi.fn().mockRejectedValue(new Error("unsupported route"));
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const capabilities = {
    contract: "agentrun.v2/0", server: { name: "AgentRun Server", version: "0.1.0", platform: "linux" },
    harnesses: [{ id: "pi", available: true }, { id: "codex", available: false, reason: "Not installed" }],
    features: { messages: { answer: true, follow_up: true, steer: false, steer_workflow_runs: false } },
  } as Capabilities;
  await act(async () => root!.render(createElement(SettingsPage, {
    client: createClient({ fetch }), capabilities,
    session: { id: "local-owner", authenticated: true, label: "Local owner", kind: "local-owner" },
    serverLabel: "http://localhost:7340", onCapabilitiesChange: () => {},
  })));
  expect(host.textContent).toContain("http://localhost:7340");
  expect(host.textContent).toContain("Local owner");
  expect(host.textContent).toContain("agentrun.v2/0");
  expect(host.textContent).toContain("Not installed");
  expect(host.textContent).toContain("Steer: unavailable");
  expect(fetch).not.toHaveBeenCalled();
});
