// Every host registers the same tools in the same order, and a host that cannot serve one refuses it when called: pi resolves a
// task against the registry where it runs, so a run that moves mid-call must find the definition of the tool it was in.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentRegistry } from "../agent.ts";
import { COMPUTER_TOOL, type ComputerDriver } from "../computer-tool.ts";
import { GO_OFFLINE_TOOL, GO_ONLINE_TOOL, OfflineRefusedError, type OfflineChannel } from "../offline-tools.ts";
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
    assert.ok(placed.some((t) => t.endsWith(`/${GO_OFFLINE_TOOL}`)) && placed.some((t) => t.endsWith(`/${GO_ONLINE_TOOL}`)), "the offline tools are the tab's, not the server's placement");
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
    const at = (name: string) => tab.findIndex((t) => t.endsWith(`/${name}`));
    assert.ok(at(SWITCH_TOOL) < at(GO_OFFLINE_TOOL) && at(GO_OFFLINE_TOOL) + 1 === at(GO_ONLINE_TOOL) && at(GO_ONLINE_TOOL) < at(COMPUTER_TOOL), "switch, go_offline, go_online, computer, in every host");
    const withChannel = shape({ offlineChannel: { goOffline: async () => undefined, goOnline: async () => undefined } });
    assert.deepEqual(withChannel, tab, "a channel changes what the tools do, never which tools there are");
  });

  it("go_offline and go_online end the turn when the page took the request, and refuse as error results when it will not or there is no page", async () => {
    const calls: string[] = [];
    const channel: OfflineChannel = { goOffline: async () => void calls.push("offline"), goOnline: async () => void calls.push("online") };
    const off = await run(toolOf({ offlineChannel: channel }, GO_OFFLINE_TOOL), {});
    const on = await run(toolOf({ offlineChannel: channel }, GO_ONLINE_TOOL), {});
    assert.deepEqual(calls, ["offline", "online"]);
    assert.equal(off.isError, undefined);
    assert.deepEqual(off.control, { terminate: true });
    assert.deepEqual(on.control, { terminate: true });
    assert.match(JSON.stringify(on.content), /Going online: your work is being handed back to the server\. This turn ends here\./);
    const refusing: OfflineChannel = { goOffline: async () => Promise.reject(new OfflineRefusedError("a step is running")), goOnline: async () => Promise.reject(new OfflineRefusedError("the run is not checked out here")) };
    const no = await run(toolOf({ offlineChannel: refusing }, GO_OFFLINE_TOOL), {});
    assert.equal(no.isError, true);
    assert.equal(no.control, undefined, "a refusal does not end the turn: the agent reads why and goes on");
    assert.match(JSON.stringify(no.content), /You did not go offline: a step is running/);
    for (const name of [GO_OFFLINE_TOOL, GO_ONLINE_TOOL]) {
      const bare = await run(toolOf({}, name), {});
      assert.equal(bare.isError, true);
      assert.equal(bare.control, undefined);
      assert.match(JSON.stringify(bare.content), /not a browser tab|not the browser tab/);
    }
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
