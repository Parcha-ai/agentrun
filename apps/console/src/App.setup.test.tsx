import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// The setup link's code is taken from the address once and kept, even where React runs a state initializer twice
// (StrictMode, in development): the setup form still has the code, and the address no longer does.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); history.replaceState(null, "", "/"); });

describe("App, a setup link under StrictMode", () => {
  it("keeps the setup code for the form and takes it out of the address", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const path = new URL(url, "http://serve.test").pathname;
      const body = path === "/v2/auth/session" ? { password_set: false, signed_in: false } : { error: { code: "not_found", message: path, retryable: false } };
      return new Response(JSON.stringify(body), { status: path === "/v2/auth/session" ? 200 : 404, headers: { "content-type": "application/json" } });
    });
    history.replaceState(null, "", "/setup#code=abc123");
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(StrictMode, null, createElement(App))));
    const end = Date.now() + 3000;
    while (!host.querySelector("form") && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const inputs = [...host.querySelectorAll<HTMLInputElement>("input:not([type=password])")];
    expect(inputs.map((i) => i.value)).toContain("abc123");
    expect(location.hash).not.toContain("abc123");
  });
});
