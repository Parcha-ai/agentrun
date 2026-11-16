import { describe, expect, it } from "vitest";
import { kindWithModel, ranOnWords } from "./nodeModel";

// What a run's model node ran on, on its Timeline row, its graph card and its hover: a model on the server's ChatGPT plan
// (chatgpt/<id>) reads as the Model picker and the agent's page say it, "<id> · on your ChatGPT plan".
describe("what a node ran on", () => {
  it("a key's model as the server names it, with the tier it asked for", () => {
    expect(kindWithModel("extract", { model: "gpt-6-luna", tier: "fast" })).toBe("extract · fast · gpt-6-luna");
    expect(ranOnWords({ model: "gpt-6-luna", tier: "fast" })).toBe("ran on gpt-6-luna (the fast tier)");
    expect(kindWithModel("call", {})).toBe("call");
    expect(ranOnWords({})).toBe("");
  });
  it("a plan model says the plan", () => {
    expect(kindWithModel("extract", { model: "chatgpt/gpt-6.1-sol", tier: "fast" })).toBe("extract · fast · gpt-6.1-sol · on your ChatGPT plan");
    expect(kindWithModel("extract", { model: "chatgpt/gpt-6.1-sol" })).toBe("extract · gpt-6.1-sol · on your ChatGPT plan");
    expect(ranOnWords({ model: "chatgpt/gpt-6.1-sol", tier: "strong" })).toBe("ran on gpt-6.1-sol · on your ChatGPT plan (the strong tier)");
  });
});
