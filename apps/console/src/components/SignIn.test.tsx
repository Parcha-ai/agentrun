import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SignIn } from "./SignIn";

// The sign-in card's forgot line, as the server's own sign-in page had it: the command, where the server runs, with the
// data directory as a placeholder (DIR) and the image's own (/data). The page is public, so it never names the real one.
describe("SignIn", () => {
  it("says how to reset a forgotten password: reset-password --data DIR, and the image's /data", () => {
    const html = renderToStaticMarkup(createElement(SignIn, { mode: "sign_in" }));
    expect(html).toContain("agentrun-serve reset-password --data DIR");
    expect(html).toContain("reset-password --data /data");
  });
  it("has no forgot line where there is no password yet", () => {
    expect(renderToStaticMarkup(createElement(SignIn, { mode: "setup" }))).not.toContain("reset-password");
  });
});
