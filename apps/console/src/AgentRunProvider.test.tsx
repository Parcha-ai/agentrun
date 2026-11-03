import { act, createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunProvider, useAgentRun } from "./AgentRunProvider";
import { createClient } from "./lib/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const capabilities = { harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } };

function PrivateScreen() {
  const { client, session, workspace } = useAgentRun();
  const [draft, setDraft] = useState(false);
  return <div><p>{session.label} {workspace?.label}</p><button onClick={() => setDraft(true)}>Edit</button>{draft && <p>Private draft</p>}<button onClick={() => { void client.getRun("private-run").catch(() => {}); }}>Read run</button></div>;
}

describe("AgentRunProvider private view scope", () => {
  it("lets the initial child read complete when the host supplies capabilities", async () => {
    const client = createClient({ fetch: (async () => new Response(JSON.stringify({ run_id: "first-run" }), { headers: { "content-type": "application/json" } })) as typeof fetch });
    function FirstRead() {
      const { client } = useAgentRun();
      const [answer, setAnswer] = useState("Loading");
      useEffect(() => { void client.getRun("first-run").then((run) => setAnswer(run.run_id), (error) => setAnswer(error.code)); }, [client]);
      return <p>{answer}</p>;
    }
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => { root!.render(<AgentRunProvider client={client} capabilities={capabilities} session={{ id: "host-owner", authenticated: true }}><FirstRead /></AgentRunProvider>); });
    expect(host.textContent).toBe("first-run");
  });

  it.each(["identity", "server", "generation"] as const)("clears private component state when the %s changes", (change) => {
    const client = createClient({ fetch: (async () => new Response("{}")) as typeof fetch });
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const render = (changed: boolean) => act(() => root!.render(<AgentRunProvider client={client} capabilities={capabilities}
      serverId={changed && change === "server" ? "server-two" : "server-one"}
      session={{ id: changed && change === "identity" ? "second-owner" : "first-owner", authenticated: true, generation: changed && change === "generation" ? 2 : 1 }}>
      <PrivateScreen />
    </AgentRunProvider>));
    render(false);
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(host.textContent).toContain("Private draft");
    render(true);
    expect(host.textContent).not.toContain("Private draft");
  });

  it("removes private content on a protected 401 and asks the host to revalidate its session", async () => {
    const client = createClient({ fetch: (async () => new Response(JSON.stringify({ error: { code: "unauthenticated", message: "The session ended.", retryable: false } }), { status: 401, headers: { "content-type": "application/json" } })) as typeof fetch });
    const expired = vi.fn();
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentRunProvider, { client, capabilities, session: { id: "owner", authenticated: true, label: "Private owner" }, workspace: { id: "local", label: "Private workspace" }, onUnauthorized: expired }, createElement(PrivateScreen))));
    expect(host.textContent).toContain("Private owner");
    await act(async () => { host.querySelectorAll<HTMLButtonElement>("button")[1].click(); });
    expect(host.textContent).not.toContain("Private owner");
    expect(host.textContent).not.toContain("Private workspace");
    expect(expired).toHaveBeenCalledOnce();
  });
});
