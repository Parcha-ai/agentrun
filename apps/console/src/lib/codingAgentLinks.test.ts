import { afterEach, describe, expect, it, vi } from "vitest";
import { codingAgentLink, CODING_AGENT_PREFERENCE, readCodingAgent, rememberCodingAgent } from "./codingAgentLinks";

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe("coding-agent handoff", () => {
  it("prefills the app without sending the prompt, and never invents a CLI deep link", () => {
    const prompt = "Import this project's sessions. Keep a & b separate.\nAsk first.";
    expect(new URL(codingAgentLink("codex", prompt)!).searchParams.get("prompt")).toBe(prompt);
    expect(new URL(codingAgentLink("claude", prompt)!).searchParams.get("q")).toBe(prompt);
    expect(new URL(codingAgentLink("cursor", prompt)!).searchParams.get("text")).toBe(prompt);
    for (const agent of ["codex-cli", "claude-cli", "other", ""] as const) expect(codingAgentLink(agent, prompt)).toBeNull();
    expect(codingAgentLink("codex", "a".repeat(9000))).toBeNull();
  });

  it("remembers only a known provider preference", () => {
    expect(readCodingAgent()).toBe("");
    rememberCodingAgent("claude-cli");
    expect(readCodingAgent()).toBe("claude-cli");
    expect(localStorage.length).toBe(1);
    localStorage.setItem(CODING_AGENT_PREFERENCE, "invalid");
    expect(readCodingAgent()).toBe("");
  });

  it("storage restrictions do not stop a handoff", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(readCodingAgent()).toBe("");
    expect(() => rememberCodingAgent("codex-cli")).not.toThrow();
  });
});
