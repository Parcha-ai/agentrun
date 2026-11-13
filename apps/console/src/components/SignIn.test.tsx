import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SignIn } from "./SignIn";

// The sign-in card's forgot line: the command where the server runs, the npx wrapper's first (it takes reset-password, on
// its own store, ~/.agentrun), then the server's own, with the data directory as a placeholder (DIR) and the image's
// (/data). The page is public, so it never names the real one. Read from the DOM: the line's text and its commands, in order.
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });
const shown = (mode: "sign_in" | "setup") => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(SignIn, { mode, onSubmit: async () => null } as never)));
  const line = [...host.querySelectorAll("p")].find((p) => p.textContent?.startsWith("Forgot it?"));
  return { host, line, commands: line ? [...line.querySelectorAll("code")].map((c) => c.textContent) : [] };
};
describe("SignIn", () => {
  it("says how to reset a forgotten password: the npx command first, then the server's own, and the image's /data", () => {
    const { line, commands } = shown("sign_in");
    expect(line?.textContent).toBe("Forgot it? Where the server runs: npx @parcha/agentrun reset-password (add --data DIR if you started it with one). For a server you started yourself: agentrun-serve reset-password --data DIR (in the image: --data /data). The next visit here sets a new one.");
    expect(commands).toEqual(["npx @parcha/agentrun reset-password", "--data DIR", "agentrun-serve reset-password --data DIR", "--data /data"]);
  });
  it("has no forgot line where there is no password yet", () => {
    const { host, line } = shown("setup");
    expect(host.querySelector("form")).not.toBeNull();
    expect(line).toBeUndefined();
    expect(host.textContent).not.toContain("reset-password");
  });
});
