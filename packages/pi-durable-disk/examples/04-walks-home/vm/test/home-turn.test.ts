// The robot's closing after teaching, said once: the turn that ends teach_skills gives the result, and the server's home
// turn after the move adds only what is new. Over a real pi-durable Harness with the session's own instructions (the code
// mode SOPs), a stub teach_skills, the home turn built as the server builds it (SERVER_TURN + HOME_PROMPT_ROBOT + the
// home check's words from the real checkHomeSkills), and the page's ChatView. The model is scripted to do what each turn
// asks, as gpt-6-sol did in code4: asked "how it went" at home, it said the result a second time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { Type } from "@earendil-works/pi-ai";
import { agentRegistry, rootAgent, setExtraInstructions } from "../../../03-tab-to-cloud/agent.ts";
import { SERVER_TURN } from "../../../03-tab-to-cloud/placement.ts";
import { ROBOT_CODE_INSTRUCTIONS } from "../../../03-tab-to-cloud/robot-sop.ts";
import { ChatView } from "../../../03-tab-to-cloud/tab/chat-view.ts";
import { checkHomeSkills, HOME_PROMPT_ROBOT } from "../placer.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : ((content as { type: string; text?: string }[]) ?? []).flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("");

const RESULT = "Steggy relearned all three skills for its new body: walking, spinning, and waving. Each passed its check.";

/** The cloud model, scripted: it calls teach_skills, gives the result after it, and at home does what the server's turn asks. */
function sol(seen: { system: string; home?: string }[]) {
  const stream = (model: any, context: any) => {
    const last = context.messages[context.messages.length - 1];
    const said = textOf(last?.content);
    // pi-durable sends the agent's instructions as a positional system message's `sections`.
    const system = (context.messages as { role: string; sections?: Record<string, string> }[]).filter((m) => m.role === "system").map((m) => Object.values(m.sections ?? {}).join("\n")).join("\n");
    const turn: { system: string; home?: string } = { system };
    let content: unknown[];
    if (last?.role === "toolResult") content = [{ type: "text", text: RESULT }];
    else if (said.startsWith(SERVER_TURN)) {
      turn.home = said;
      // A turn that asks how it went is answered with the result again (code4); one that says not to repeat it, with one new line.
      content = [{ type: "text", text: /do not repeat/i.test(said) ? "Back in your browser. Try: make it spin." : `I'm back in your browser, and ${RESULT}` }];
    } else content = [{ type: "toolCall", id: "t1", name: "teach_skills", arguments: { skills: [{ name: "walk", brief: "walk forward" }, { name: "spin", brief: "spin in place" }, { name: "wave", brief: "wave a front leg" }] } }];
    seen.push(turn);
    const s = createAssistantMessageEventStream();
    const toolUse = content.some((c) => (c as { type: string }).type === "toolCall");
    const message: any = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: zero, stopReason: toolUse ? "toolUse" : "stop", timestamp: Date.now() };
    queueMicrotask(() => { s.push({ type: "start", partial: message }); s.push({ type: "done", reason: message.stopReason, message }); s.end(); });
    return s;
  };
  return createProvider({ id: "pipe", name: "sol", auth: { apiKey: { name: "k", resolve: async () => ({ auth: { apiKey: "x" } }) } }, models: [{ id: "cloud-big", name: "sol", api: "openai-responses", provider: "pipe", baseUrl: "x", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16000 }], api: { stream, streamSimple: stream } as never });
}

/** teach_skills as the session sees it: the fold, one line per thread. */
const teachStub = defineExtension({
  name: "robot-teach",
  tools: [defineTool({
    name: "teach_skills",
    description: "Teach the robot new skills on the GPU cluster.",
    parameters: Type.Object({ skills: Type.Array(Type.Object({ name: Type.String(), brief: Type.String() })) }),
    execute: async () => ({ content: [{ type: "text", text: "3 threads finished: 3 passed.\n- GPU 1 · walk: passed at checkpoint 4 in 51 s.\n- GPU 2 · spin: passed at checkpoint 5 in 60 s.\n- GPU 3 · wave: passed at checkpoint 3 in 90 s.\nHome: 3 skills (spin, walk, wave)." }] }),
  })],
});

/** The home check's own words over the files a round of three leaves home. */
async function homeCheckWords(): Promise<string> {
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  const files: Record<string, Uint8Array> = {
    "home/skills.json": enc({ version: 1, default: "walk", skills: { walk: { label: "walk" }, spin: { label: "spin" }, wave: { label: "wave" } } }),
    "home/skills/walk.json": enc({}), "home/skills/spin.json": enc({}), "home/skills/wave.json": enc({}),
    "home/round.json": enc({ skills: { walk: {}, spin: {}, wave: {} } }),
  };
  const check = await checkHomeSkills(async (path) => files[path], 3);
  assert.equal(check.ok, true, check.reason);
  return `\n\nChecked by the server just now: yes. ${check.reason}`;
}

test("after teaching the result is said once: the home turn after the move adds only that it is back and what to try", async () => {
  setExtraInstructions(ROBOT_CODE_INSTRUCTIONS);
  try {
    const registry = agentRegistry(async () => undefined, { switchTool: false });
    registry.install(teachStub);
    const models = createModels();
    const seen: { system: string; home?: string }[] = [];
    models.setProvider(sol(seen));
    // `models as never`: the workspace has two copies of pi-ai (pi-durable's own, and this package's), the same at runtime.
    const harness = await Harness.open(new MemoryStorage(), { models: models as never, registry, settings: { extensions: [teachStub] } }, ctx);
    const root = await harness.root(ctx, { agent: rootAgent("cloud-big") });
    await (await root.submit({ type: "input", content: "teach it to walk, spin and wave", requestId: "u1" }, ctx)).wait(ctx);
    // The server's home turn after the move, as server.ts builds it.
    await (await root.submit({ type: "input", content: `${SERVER_TURN}${HOME_PROMPT_ROBOT}${await homeCheckWords()}`, requestId: "server-s1" }, ctx)).wait(ctx);

    // What the page shows: the result once, then one short line from home.
    const entries = [];
    for (let cursor: any; ;) {
      const page = await root.commit((tx) => tx.scanEntries({ conversationId: root.id }, 100, cursor), ctx);
      entries.push(...page.items);
      if (!page.next) break;
      cursor = page.next;
    }
    const view = new ChatView();
    view.apply({ type: "snapshot", entries: entries.reverse(), tools: [] } as never);
    const said = view.items().filter((i) => i.kind === "assistant").map((i) => JSON.stringify(i));
    assert.equal(said.filter((t) => /relearned all three skills/.test(t)).length, 1, `the result is said once: ${said.join(" | ")}`);
    assert.match(said[said.length - 1]!, /Back in your browser\. Try: make it spin\./);
    assert.equal(view.items().some((i) => JSON.stringify(i).includes("Checked by the server")), false, "the server's turn is not drawn");
    // What the model was told: the SOP's rule on every turn, and the home turn's own instruction not to repeat.
    assert.ok(seen.every((t) => t.system.includes("Give the result once")), "the session's instructions carry teach.md's rule");
    const home = seen.find((t) => t.home)?.home ?? "";
    assert.match(home, /do not repeat/i);
    assert.doesNotMatch(home, /how it went for their robot's skills|name how many/);

    await harness.close(ctx);
  } finally {
    setExtraInstructions("");
  }
});
