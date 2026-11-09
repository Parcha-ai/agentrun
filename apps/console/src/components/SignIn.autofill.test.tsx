import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SignIn } from "./SignIn";

// A password manager fills the text field before a password field as the login's username, whatever its autocomplete
// says when it is "off": in setup that was the Setup code, so a saved login could overwrite the code the link brought.
// The code field says it is a one-time code, and the form carries its own username field for a manager to fill.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

function mount() {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(SignIn, { mode: "setup", code: "AbC-123_xyz", codeNeeded: true, onSubmit: async () => null })));
  return host;
}

describe("SignIn's setup code field and password managers", () => {
  it("is a one-time code with a name of its own, never a login's username", () => {
    const host = mount();
    const code = [...host.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent === "Setup code")!.querySelector("input")!;
    expect(code.getAttribute("autocomplete")).toBe("one-time-code");
    expect(code.getAttribute("name")).toBe("setup-code");
    expect(code.value).toBe("AbC-123_xyz");
  });

  it("carries a username field of its own, before the passwords, for a manager to fill instead", () => {
    const host = mount();
    const form = host.querySelector("form")!;
    const inputs = [...form.querySelectorAll("input")];
    const username = inputs.find((i) => i.getAttribute("autocomplete") === "username");
    expect(username, "a username field").toBeTruthy();
    expect(inputs.indexOf(username!)).toBeLessThan(inputs.findIndex((i) => i.type === "password"));
    // Out of sight and out of the tab order, never sent.
    expect(username!.hidden || username!.getAttribute("aria-hidden") === "true" || username!.type === "hidden" || username!.className.includes("sr-only")).toBe(true);
    expect(username!.tabIndex).toBe(-1);
  });
});
