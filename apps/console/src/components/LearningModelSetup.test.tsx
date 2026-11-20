import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LearningModelSetup } from "./LearningModelSetup";
import type { LearningModelAccess } from "@/lib/learning";

const show = (access?: LearningModelAccess) => renderToStaticMarkup(createElement(LearningModelSetup, { access }));
const missing: LearningModelAccess = { location: "server", ready: false, model: "anthropic/claude-example", needs: "key", reason: "Add the selected provider's key." };
describe("learning model setup", () => {
  it("names the actual learning model, explains the credential boundary and links to API Keys", () => {
    const html = show(missing);
    expect(html).toContain('aria-label="Learning model setup"');
    expect(html).toContain("anthropic/claude-example");
    expect(html).toContain("tool API key or the AgentRun connection key does not provide model access");
    expect(html).toContain('href="#/settings/keys"');
    expect(html).toContain("separate model usage");
  });
  it("does not demand server keys from native runtimes or claim an unread server is missing a key", () => {
    const native = show({ ...missing, location: "native", ready: true, model: null, needs: null, reason: null });
    expect(native).toContain("runtime&#x27;s existing model access");
    expect(native).not.toContain('href="#/settings/keys"');
    expect(show()).not.toContain('aria-label="Learning model setup"');
  });
  it("distinguishes an unsupported model from a missing credential, and clears the warning when configured", () => {
    expect(show({ ...missing, needs: "model" })).toContain("Choose a model for learning");
    const ready = show({ ...missing, ready: true, needs: null, reason: null });
    expect(ready).toContain("anthropic/claude-example");
    expect(ready).not.toContain('aria-label="Learning model setup"');
    expect(ready).not.toContain("verified");
  });
});
