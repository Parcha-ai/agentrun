import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Playground, startFailure } from "./Playground";
import { agentFixture, recorded } from "@/fixtures";
import { ClientError, createClient } from "@/lib/client";

// A start the server refuses keeps everything the server said: a sandbox agent's run on a box this server does not
// have is a 409 agent_not_runnable whose details name the box, and the playground says its reason and that box.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const refused = recorded<{ error: { code: string; message: string; details: { box: string } } }>("start.run-on-unavailable-box");
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

/** The recorded refusal, as the client throws it. */
async function thrown(): Promise<ClientError> {
  const v2 = createClient({ fetch: (async () => new Response(JSON.stringify(refused.body), { status: refused.status, headers: { "content-type": "application/json" } })) as typeof fetch });
  return v2.startRun("sandboxed", { input: { content: "List the files here." } }, "k-1").then(() => { throw new Error("started"); }, (e) => e as ClientError);
}

describe("a refused start", () => {
  it("keeps the server's details on the client's error, the box a 409 agent_not_runnable names included", async () => {
    const e = await thrown();
    expect(e).toBeInstanceOf(ClientError);
    expect([e.status, e.code, e.details?.box]).toEqual([409, "agent_not_runnable", "daytona"]);
    expect(e.toApiError().details).toEqual(refused.body.error.details);
  });

  it("is said in the playground: the server's reason and the box it lacks, above the whole answer", async () => {
    const result = startFailure(await thrown(), 12);
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(Playground, { agents: [agentFixture("invoice-checker")], efforts: [], origin: "http://serve.test", agentId: "invoice-checker", result })));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(`The run did not start: ${refused.body.error.message} (box: daytona)`);
    expect(refused.body.error.message).toContain("daytona is not set up on this server");
    expect(JSON.parse(host.querySelector("pre")!.textContent!).error.details).toEqual({ unbound: [], missing: {}, box: "daytona" });
  });

  it("a refused input (#1926) says the schema path and reason, each further field under it", async () => {
    const first = "the workflow does not take this input: #/properties/b: must not have fewer than 1 characters";
    const second = "the workflow does not take this input: #/properties/c: must be integer";
    const body = { error: { code: "input_invalid", message: first, retryable: false, fields: [{ field: "input at #/properties/b", reason: "invalid", message: first }, { field: "input at #/properties/c", reason: "invalid", message: second }] } };
    const v2 = createClient({ fetch: (async () => new Response(JSON.stringify(body), { status: 422, headers: { "content-type": "application/json" } })) as typeof fetch });
    const e = await v2.startRun("invoice-checker", { input: { a: "x" } }, "k-2").then(() => { throw new Error("started"); }, (x) => x as ClientError);
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(Playground, { agents: [agentFixture("invoice-checker")], efforts: [], origin: "http://serve.test", agentId: "invoice-checker", result: startFailure(e, 9) })));
    const alert = host.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain(`The run did not start: ${first}`);
    expect(alert.textContent).toContain(`input at #/properties/c: ${second}`);
    expect(alert.textContent?.split(first).length).toBe(2);
  });
});
