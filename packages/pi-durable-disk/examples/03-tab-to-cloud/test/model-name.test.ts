// "what llm are you now?" On Miguel's live run the cloud agent, gpt-6-sol through the broker, said "I'm ChatGPT, an AI
// assistant from OpenAI." while the header said gpt-6-sol: its instructions never named its model. They now name the model
// of the conversation's own config (the modelId the server attached it with), and where the agent runs now, from the host
// that holds the run (its environment's phrase, as the server gives it): in D4's smoke, run in the tab, it said "I'm
// gpt-6-sol, running on the cloud machine right now." Over real pi-durable Harnesses with the cloud model scripted to
// answer from what its instructions say, as a model does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { agentRegistry, cloudAgent, keepPlace, rootAgent, tabPlace } from "../agent.ts";
import { BRAIN_PROVIDER } from "../providers.ts";
import { scriptedCloud } from "../tab/scripted-cloud.ts";
import type { Environment } from "../wire.ts";

const TAB = "your user's browser tab";
const VM = "a Modal VM";

/** The cloud model, scripted: it names the model and the place its instructions name; without them it says what gpt-6-sol said live. */
const answer = (instructions: string) => {
  const named = /Your model is ([\w.:-]+)/.exec(instructions)?.[1];
  const place = /you, the agent, are running in (.+?) now\./.exec(instructions)?.[1];
  if (!named) return "I'm ChatGPT, an AI assistant from OpenAI.";
  return place ? `I'm ${named}, running in ${place}.` : `I'm ${named}, running on the cloud machine right now.`;
};

/** The run's storage as each host sees it: one store that outlives a host (a Harness closes its storage when it closes). */
function runStorage(store: MemoryStorage): MemoryStorage {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === "close") return async () => undefined;
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** A host opening the run (created here, or brought here by a move): its Harness over the run's storage, the agent as this host gives it. */
async function onHost(storage: MemoryStorage, modelId: string, place: string | undefined, question = "what model are you?"): Promise<string> {
  const registry = agentRegistry(async () => undefined, { switchTool: false });
  const models = createModels();
  models.setProvider(scriptedCloud(modelId, [{ reply: answer }], []));
  const harness = await Harness.open(storage, { models, registry }, ctx);
  try {
    const root = await harness.root(ctx, { agent: rootAgent(modelId, { registry, ...(place ? { place } : {}) }) });
    await keepPlace(root, place, ctx);
    await (await root.submit({ type: "input", content: question }, ctx)).wait(ctx);
    const items = (await root.entries({}, 50, undefined, ctx)).items as unknown as { model?: { role?: string; content?: { type: string; text?: string }[] }[] }[];
    return items.flatMap((e) => (e.model ?? []).filter((m) => m.role === "assistant").map((m) => (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join(""))).find((t) => t.length > 0) ?? "";
  } finally {
    await harness.close(ctx);
  }
}

test("asked which LLM it is, the cloud agent names its configured model and where it runs now: the tab, or the Modal VM", async () => {
  assert.equal(await onHost(new MemoryStorage(), "gpt-6-sol", TAB, "what llm are you now?"), "I'm gpt-6-sol, running in your user's browser tab.");
  assert.equal(await onHost(new MemoryStorage(), "gpt-6-sol", VM), "I'm gpt-6-sol, running in a Modal VM.");
  assert.equal(await onHost(new MemoryStorage(), "luna-2", TAB), "I'm luna-2, running in your user's browser tab.", "the model is read from the conversation's config, not written in");
});

test("a run that moves keeps the line current: made in the tab, then on the Modal VM, then home in the tab again", async () => {
  const storage = runStorage(new MemoryStorage());
  assert.equal(await onHost(storage, "gpt-6-sol", TAB), "I'm gpt-6-sol, running in your user's browser tab.");
  assert.equal(await onHost(storage, "gpt-6-sol", VM), "I'm gpt-6-sol, running in a Modal VM.", "the VM opened a conversation the tab made");
  assert.equal(await onHost(storage, "gpt-6-sol", TAB), "I'm gpt-6-sol, running in your user's browser tab.");
});

test("keepPlace changes only the model line, and leaves the browser's brain alone", async () => {
  const registry = agentRegistry(async () => undefined, { switchTool: false });
  const models = createModels();
  models.setProvider(scriptedCloud("gpt-6-sol", [{ text: "ok" }], []));
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  try {
    const root = await harness.root(ctx, { agent: rootAgent("gpt-6-sol", { registry, place: TAB }) });
    const before = (await root.agent(ctx)).instructions!;
    await root.configure({ instructions: `${before}\n\nA host's own extra line.` }, ctx);
    await keepPlace(root, VM, ctx);
    const moved = (await root.agent(ctx)).instructions!;
    assert.match(moved, /you, the agent, are running in a Modal VM now\./);
    assert.doesNotMatch(moved, /browser tab now/);
    assert.ok(moved.endsWith("A host's own extra line."), "the rest of the instructions is the conversation's own");
    await root.configure({ model: { provider: BRAIN_PROVIDER, modelId: "v5" }, instructions: "the serving file's system text" }, ctx);
    await keepPlace(root, VM, ctx);
    assert.equal((await root.agent(ctx)).instructions, "the serving file's system text", "the brain's instructions are its own");
  } finally {
    await harness.close(ctx);
  }
});

test("the cloud model coming back after the brain carries the line with the tab's place; the tab's place is its environment's phrase", () => {
  const environments: Environment[] = [{ id: "modal-vm", label: "Modal VM", kind: "cloud", phrase: VM }, { id: "tab", label: "your browser", kind: "tab", phrase: TAB }];
  assert.equal(tabPlace(environments), TAB);
  const agent = cloudAgent("gpt-6-sol", { place: TAB });
  assert.match(agent.instructions ?? "", /Your model is gpt-6-sol, which runs in the cloud and is reached through your user's server; you, the agent, are running in your user's browser tab now\./);
});

test("keepPlace writes only when the place changes: an open on the host the line already names, or a second open, writes nothing (the prompt cache holds)", async () => {
  const registry = agentRegistry(async () => undefined, { switchTool: false });
  const models = createModels();
  models.setProvider(scriptedCloud("gpt-6-sol", [{ text: "ok" }], []));
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  try {
    const root = await harness.root(ctx, { agent: rootAgent("gpt-6-sol", { registry, place: TAB }) });
    const writes: unknown[] = [];
    const spy = { agent: (c: typeof ctx) => root.agent(c), configure: (change: Parameters<typeof root.configure>[0], c: typeof ctx) => (writes.push(change), root.configure(change, c)) };
    await keepPlace(spy, TAB, ctx);
    await keepPlace(spy, TAB, ctx);
    assert.equal(writes.length, 0, "the tab opening a run whose line names the tab");
    await keepPlace(spy, VM, ctx);
    await keepPlace(spy, VM, ctx);
    assert.equal(writes.length, 1, "one write for the move to the VM, none for opening there again");
  } finally {
    await harness.close(ctx);
  }
});
