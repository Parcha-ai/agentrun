import { describe, expect, it } from "vitest";
import { loginServes } from "./claudeLogin";

// The login's model rule is serve's (claude-login.ts loginServes), copied here because the console reads no server code.
// Serve's claude-login test names these same cases: a change to either rule changes both lists.
const CASES: readonly [string | undefined, boolean][] = [
  [undefined, true],
  ["", true],
  ["anthropic/claude-sonnet-5-5", true],
  ["openrouter/anthropic/claude-sonnet-5.5", false],
  ["openai/gpt-6.1-sol", false],
];

describe("loginServes, the login's model rule", () => {
  it("serves no model and Anthropic's own; an OpenRouter model, Anthropic's included, and any other vendor's go on their key", () => {
    for (const [model, served] of CASES) expect(loginServes(model), String(model)).toBe(served);
  });
});
