// "what llm are you now?" On Miguel's live run the cloud agent, gpt-6-sol through the broker, said "I'm ChatGPT, an AI
// assistant from OpenAI." while the header said gpt-6-sol: its instructions never named its model. They now name the model
// of the conversation's own config (the modelId the server attached it with), so the answer comes from the instructions.
// Over a real pi-durable Harness with the cloud model scripted to answer from what its instructions say, as a model does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { agentRegistry, cloudAgent, rootAgent } from "../agent.ts";
import { scriptedCloud } from "../tab/scripted-cloud.ts";

/** The cloud model, scripted: it names the model its instructions name; with none named it says what gpt-6-sol said live. */
const answer = (instructions: string) => {
  const named = /Your model is ([\w.:-]+)/.exec(instructions)?.[1];
  return named ? `I'm ${named}.` : "I'm ChatGPT, an AI assistant from OpenAI.";
};

async function ask(modelId: string, question: string): Promise<string> {
  const registry = agentRegistry(async () => undefined, { switchTool: false });
  const models = createModels();
  models.setProvider(scriptedCloud(modelId, [{ reply: answer }], []));
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  try {
    const root = await harness.root(ctx, { agent: rootAgent(modelId, { registry }) });
    await (await root.submit({ type: "input", content: question }, ctx)).wait(ctx);
    const items = (await root.entries({}, 50, undefined, ctx)).items as unknown as { model?: { role?: string; content?: { type: string; text?: string }[] }[] }[];
    return items.flatMap((e) => (e.model ?? []).filter((m) => m.role === "assistant").map((m) => (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join(""))).find((t) => t.length > 0) ?? "";
  } finally {
    await harness.close(ctx);
  }
}

test("asked which LLM it is, the cloud agent names the model its conversation is configured with, not another assistant", async () => {
  assert.equal(await ask("gpt-6-sol", "what llm are you now?"), "I'm gpt-6-sol.");
  assert.equal(await ask("luna-2", "what llm are you now?"), "I'm luna-2.", "read from the conversation's model, not written in");
});

test("the agent change that brings the cloud model back after the browser's brain carries its name again", () => {
  for (const id of ["gpt-6-sol", "luna-2"]) {
    const agent = cloudAgent(id);
    assert.equal(agent.model?.modelId, id);
    assert.match(agent.instructions ?? "", new RegExp(`Your model is ${id.replace(/[.-]/g, "\\$&")}\\b`));
  }
});
