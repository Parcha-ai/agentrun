import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SignIn } from "./SignIn";

// The setup code field says what it is, a one-time code, with a name and id of its own: a browser or a password manager
// that reads autocomplete knows it holds no login.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

function mount() {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(SignIn, { mode: "setup", code: "AbC-123_xyz", codeNeeded: true, onSubmit: async () => null })));
  return host;
}

describe("SignIn's setup code field", () => {
  it("is a one-time code with a name of its own, never a login's username", () => {
    const host = mount();
    const code = [...host.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent === "Setup code")!.querySelector("input")!;
    expect(code.getAttribute("autocomplete")).toBe("one-time-code");
    expect(code.getAttribute("name")).toBe("setup-code");
    expect(code.id).toBe("setup-code");
    expect(code.value).toBe("AbC-123_xyz");
  });
});
