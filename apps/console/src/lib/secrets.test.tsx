import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { type SecretsWhyNot, useSecrets } from "./secrets";

// The one hook every page holding a secret reads (Keys, MCP servers, Computers, Workspace): the session read's
// secrets_writable alone, required. The base's default (writable unless told otherwise) is gone: a read without the flag,
// or one that fails, may not change secrets.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

async function secretsFor(answer: { status: number; body: unknown } | Error): Promise<{ writable: boolean; whyNot: SecretsWhyNot }> {
  let seen: { writable: boolean; whyNot: SecretsWhyNot } | undefined;
  // One client for the page's life, as App holds it: the hook reads the session once per client.
  const v2 = { session: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)) };
  function Probe() { seen = useSecrets(v2); return null; }
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => { root!.render(createElement(Probe)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return seen!;
}

describe("useSecrets", () => {
  it("may not when the session read says nothing about secrets", async () => {
    expect((await secretsFor({ status: 200, body: { accounts: true, password_set: true, signed_in: true } })).writable).toBe(false);
  });
  it("may not when it says secrets_writable: false, and says why", async () => {
    expect(await secretsFor({ status: 200, body: { accounts: true, signed_in: true, secrets_writable: false, secrets_reason: "sign_in" } })).toEqual({ writable: false, whyNot: "sign_in" });
  });
  it("may when it says secrets_writable: true", async () => {
    expect((await secretsFor({ status: 200, body: { accounts: true, signed_in: true, secrets_writable: true } })).writable).toBe(true);
  });
  it("may not when the read fails", async () => {
    expect((await secretsFor(new Error("offline"))).writable).toBe(false);
  });
});
