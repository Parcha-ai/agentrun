import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// A server at a public address (on Render, say) takes a setup code at its first visit, and says so on its session read
// (`setup_code: true`, never the code itself). Opened at its plain address, with no #code= in the link, the setup form
// still asks for the code, says where to find it, and sends what was typed. An open setup (`setup_code: false`) asks for
// none.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); history.replaceState(null, "", "/"); });

const NOTE = "Find the setup code in the server's log (on Render, the Logs tab), or open the link the log prints.";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function open(setupCode: boolean) {
  const sent: unknown[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://serve.test").pathname;
    if (path === "/v2/auth/session") return json(200, { password_set: false, signed_in: false, setup_code: setupCode });
    if (path === "/v2/setup") { sent.push(JSON.parse(String(init?.body ?? "{}"))); return json(403, { error: { code: "forbidden", message: "that is not the setup code in the server's log, or it has expired", retryable: false } }); }
    return json(404, { error: { code: "not_found", message: path, retryable: false } });
  });
  history.replaceState(null, "", "/");
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(App)));
  const end = Date.now() + 3000;
  while (!host.querySelector("form") && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  const field = () => [...host.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent === "Setup code");
  return { host, sent, field };
}
const type = async (el: HTMLInputElement, value: string) => {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
};

describe("App, a first visit at a public address opened with no setup link", () => {
  it("asks for the setup code, says where to find it, and sends the typed code", async () => {
    const p = await open(true);
    const field = p.field();
    expect(field, "the Setup code field").toBeTruthy();
    expect(field!.textContent).toContain(NOTE);
    await type(field!.querySelector("input")!, "typed-code-1");
    await type(p.host.querySelector('input[aria-label="New password"]') as HTMLInputElement, "not-a-secret-password");
    await type(p.host.querySelector('input[aria-label="Password again"]') as HTMLInputElement, "not-a-secret-password");
    await act(async () => { (p.host.querySelector("form") as HTMLFormElement).requestSubmit(); });
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(p.sent).toHaveLength(1);
    expect((p.sent[0] as { code?: string }).code).toBe("typed-code-1");
  });

  it("asks for no code on an open setup", async () => {
    const p = await open(false);
    expect(p.host.querySelector('input[aria-label="New password"]')).toBeTruthy();
    expect(p.field()).toBeUndefined();
  });
});
