import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useSecretsWritable } from "./secrets";

// This base's session read has no secrets_writable and its server does not gate secret writes: a session may change
// secrets unless the read says false. The secrets slice drops this default when it lands.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

async function writableFor(answer: { status: number; body: unknown } | Error): Promise<boolean> {
  let seen: boolean | undefined;
  function Probe() { seen = useSecretsWritable({ session: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)) }); return null; }
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => { root!.render(createElement(Probe)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return seen!;
}

describe("useSecretsWritable on this base", () => {
  it("is true when the session read says nothing about secrets", async () => {
    expect(await writableFor({ status: 200, body: { password_set: true, signed_in: true } })).toBe(true);
  });
  it("is false when the session read says secrets_writable: false", async () => {
    expect(await writableFor({ status: 200, body: { password_set: true, signed_in: true, secrets_writable: false } })).toBe(false);
  });
  it("is true when the session read says secrets_writable: true", async () => {
    expect(await writableFor({ status: 200, body: { signed_in: true, secrets_writable: true } })).toBe(true);
  });
  it("stays true when the read fails: this base's server does not gate the write", async () => {
    expect(await writableFor(new Error("offline"))).toBe(true);
  });
});
