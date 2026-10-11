// Every host registers the same tools in the same order, and a host that cannot serve one refuses it when called: pi resolves a
// task against the registry where it runs, so a run that moves mid-call must find the definition of the tool it was in.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentRegistry } from "../agent.ts";
import { COMPUTER_TOOL, type ComputerDriver } from "../computer-tool.ts";
import { cleanReason, FrameSwitchChannel, SWITCH_TOOL } from "../switch-tool.ts";

const durable = async () => undefined;
const shape = (host: Parameters<typeof agentRegistry>[1]) =>
  agentRegistry(durable, host)
    .snapshot()
    .tools()
    .map((t) => `${t.extension.name}/${t.tool.name}`);

const toolOf = (host: Parameters<typeof agentRegistry>[1], name: string) => agentRegistry(durable, host).snapshot().tools().find((t) => t.tool.name === name)!.tool;
const run = (tool: ReturnType<typeof toolOf>, args: Record<string, unknown>) => tool.execute(args as never, {} as never, {} as never);
const fakeDriver: ComputerDriver = { display: ":1", act: async (a) => ({ did: `did ${a.action}`, jpegBase64: "AAAA" }) };

describe("a run the server places", () => {
  it("is not offered switch_environment, and the rest of the registry is the same in the same order", () => {
    const normal = shape({});
    const placed = shape({ switchTool: false });
    assert.ok(normal.some((t) => t.endsWith(`/${SWITCH_TOOL}`)));
    assert.ok(!placed.some((t) => t.endsWith(`/${SWITCH_TOOL}`)), "the move tool is not in the list");
    assert.deepEqual(placed, normal.filter((t) => !t.endsWith(`/${SWITCH_TOOL}`)));
    assert.deepEqual(shape({ switchTool: false, environments: ["tab", "modal-gpu"] }), placed, "whatever else a host knows, every host of the run agrees");
  });
});

describe("the registry every host installs", () => {
  it("has the same extensions and tools in the same order whatever the host can serve", () => {
    const tab = shape({});
    const cloud = shape({ switchChannel: new FrameSwitchChannel(() => true), computer: fakeDriver, environments: ["a", "b"] });
    assert.deepEqual(tab, cloud);
    assert.ok(tab.some((t) => t.endsWith(`/${SWITCH_TOOL}`)) && tab.some((t) => t.endsWith(`/${COMPUTER_TOOL}`)));
    assert.ok(tab.indexOf(tab.find((t) => t.endsWith(`/${SWITCH_TOOL}`))!) < tab.indexOf(tab.find((t) => t.endsWith(`/${COMPUTER_TOOL}`))!), "always switch, then computer");
  });

  it("a host without a channel refuses the move, and one without a desktop refuses the computer, as error results (never a missing definition)", async () => {
    const move = await run(toolOf({}, SWITCH_TOOL), { target: "x", reason: "y" });
    assert.equal(move.isError, true);
    assert.match(JSON.stringify(move.content), /cannot reach your user's server/);
    const see = await run(toolOf({}, COMPUTER_TOOL), { action: "screenshot" });
    assert.equal(see.isError, true);
    assert.match(JSON.stringify(see.content), /no desktop/);
  });

  it("a host with a desktop serves the computer tool: a text line and the picture", async () => {
    const result = await run(toolOf({ computer: fakeDriver }, COMPUTER_TOOL), { action: "click", x: 10, y: 20 });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.content?.map((c) => c.type), ["text", "image"]);
    assert.deepEqual(result.details, { action: "click", x: 10, y: 20 });
    const failing = await run(toolOf({ computer: { display: ":1", act: async () => Promise.reject(new Error("no X")) } }, COMPUTER_TOOL), { action: "screenshot" });
    assert.match(JSON.stringify(failing.content), /The screenshot failed: no X/);
  });

  it("the move tool's description lists the host's environments, and never names one the host does not have", () => {
    const withList = toolOf({ environments: ["tab", "far-vm"] }, SWITCH_TOOL).description;
    assert.match(withList, /target is one of: tab, far-vm\./);
    const without = toolOf({}, SWITCH_TOOL).description;
    assert.ok(!/modal|daytona/i.test(without), "no environment id is guessed");
    assert.match(without, /interrupted, that notice tells you where you are/);
  });
});

describe("the reason an agent gives for a move", () => {
  it("is one line of at most 300 characters without control characters", () => {
    assert.equal(cleanReason("  needs\n\ta   GPU\u0000\u001b[31m now  "), "needs a GPU [31m now");
    assert.equal(cleanReason("x".repeat(1000)).length, 300);
    assert.equal(cleanReason(undefined), "");
    assert.equal(cleanReason("line one line two"), "line one line two");
  });
});
