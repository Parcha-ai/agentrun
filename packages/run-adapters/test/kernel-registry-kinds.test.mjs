// The kernel registry's computer tools: a run whose computer is a desktop or a phone sees the host tools of its shell
// plus the computer's tools its groups offer (computer_observe, computer_act, computer_screenshot, computer_script where
// the host runs scripts, and the hand-over), under its kind's settings key, and nothing else. Each runs on the hands'
// one computer port, its value back as the answer's structured value with images' data left out, its images in the
// answer's images. A computer tool the run does not have is refused in words. A browser computer is no kind of the
// registry's: its tools are the host's browser tool's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPABILITY_KINDS, COMPUTER_TOOL_SCHEMAS, computerDeclarations, computerToolDefs, computerToolsFor, createRegistry, hostToolDefs, NEEDS_A_COMPUTER } from "@parcha/agentrun-kernel/kernel";
import { fakeComputerPort, PNG, refusal } from "./registry-ports.mjs";
import { localHands } from "./registry-support.mjs";

const answer = (text) => async () => ({ text });
const script = async (args) => ({ text: `ran ${args.code}` });
const injected = { read: answer("read"), write: answer("write"), edit: answer("edit"), bash: answer("bash") };
const LOCAL = ["read", "write", "edit", "bash"];
const HANDOFF = "computer_request_handoff";
const MAC = ["ui", "screen", "input.pointer", "input.keys", "apps", "exec", "files"];
const handsWith = (ports) => ({ ...localHands().hands, ...ports });

test("the computer's tools follow the host tools, as its groups offer them; computer_script only where the host runs scripts", () => {
  assert.deepEqual(CAPABILITY_KINDS, ["desktop", "phone"], "a browser is no kind of the registry's");
  const mac = createRegistry({ maxExecS: 600, shell: "local", kinds: ["desktop"], groups: MAC, executors: { ...injected, computer_script: script } });
  assert.deepEqual(mac.list().map((def) => def.name), [...LOCAL, "computer_observe", "computer_act", "computer_screenshot", "computer_script", HANDOFF]);
  const noScripts = createRegistry({ maxExecS: 600, shell: "local", kinds: ["desktop"], groups: MAC, executors: injected });
  assert.deepEqual(noScripts.list().map((def) => def.name), [...LOCAL, "computer_observe", "computer_act", "computer_screenshot", HANDOFF]);
  // No screen: no screenshot; nothing to observe or act on: only the hand-over.
  assert.deepEqual(computerToolsFor(["ui"]), ["computer_observe", "computer_act", "computer_script", HANDOFF]);
  assert.deepEqual(computerToolsFor(["exec"]), [HANDOFF]);
  // No kinds: today's rows, unchanged.
  assert.deepEqual(createRegistry({ maxExecS: 600, shell: "local", executors: injected }).list(), hostToolDefs({ maxExecS: 600, shell: "local" }));
});

test("each tool's definition: its kind's gate name and settings key, the generated schema; a look is replay-safe, an act or a script is not", () => {
  for (const kind of ["desktop", "phone"]) {
    const defs = computerToolDefs(kind, MAC);
    assert.deepEqual(defs.map((def) => [def.name, def.gateName, def.settingsKey, def.replaySafe]), [
      ["computer_observe", `host:${kind}/computer_observe`, kind, true],
      ["computer_act", `host:${kind}/computer_act`, kind, false],
      ["computer_screenshot", `host:${kind}/computer_screenshot`, kind, true],
      ["computer_script", `host:${kind}/computer_script`, kind, false],
      [HANDOFF, `host:${kind}/${HANDOFF}`, kind, false],
    ]);
    for (const def of defs.slice(0, 4)) assert.equal(def.parameters, COMPUTER_TOOL_SCHEMAS[def.name]);
  }
});

test("computer_script's words declare the computer object for its groups only", () => {
  const shell = computerToolDefs("desktop", ["exec"]).find((def) => def.name === "computer_script").description;
  assert.ok(shell.includes(computerDeclarations(["exec"])));
  assert.ok(shell.includes("readonly shell:"));
  assert.ok(!shell.includes("app(id?: string): App;"), "no app() without the ui group");
  assert.ok(computerToolDefs("desktop", MAC).find((def) => def.name === "computer_script").description.includes("app(id?: string): App;"));
});

test("observe, act and screenshot run on the computer port: the surface's text, its images, its value with image data left out", async () => {
  const image = { type: "image", mimeType: "image/png", data: PNG, width: 1, height: 1 };
  const computer = fakeComputerPort({
    answers: {
      observe: () => ({ value: { id: "s1", outline: "state s1", image }, text: "state s1\n@e1 button \"Save\"", images: [image] }),
      act: (args) => ({ value: { steps: [{ route: "semantic", verified: true }], state: "s2", changed: true }, text: `1. press: semantic, verified (${args.steps.length})`, images: [] }),
    },
  });
  const registry = createRegistry({ maxExecS: 600, shell: "local", kinds: ["phone"], groups: MAC, executors: injected });
  const hands = handsWith({ computer });
  const seen = await registry.invoke("computer_observe", { image: true }, { hands });
  assert.equal(seen.text, "state s1\n@e1 button \"Save\"");
  assert.deepEqual(seen.images, [image]);
  assert.deepEqual(seen.structured, { id: "s1", outline: "state s1", image: { type: "image", mimeType: "image/png", width: 1, height: 1 } });
  const acted = await registry.invoke("computer_act", { steps: [{ press: "@e1" }] }, { hands });
  assert.equal(acted.text, "1. press: semantic, verified (1)");
  assert.equal(acted.images, undefined);
  await registry.invoke("computer_screenshot", { region: [0, 0, 10, 10] }, { hands });
  assert.deepEqual(computer.calls, [["observe", { image: true }], ["act", { steps: [{ press: "@e1" }] }], ["screenshot", { region: [0, 0, 10, 10] }]]);
});

test("the computer's refusal is the answer's error, in its words", async () => {
  const registry = createRegistry({ maxExecS: 600, shell: "local", kinds: ["desktop"], groups: MAC, executors: injected });
  const said = await registry.invoke("computer_act", { steps: [{ click: [1, 2] }] }, { hands: handsWith({ computer: fakeComputerPort({ refuse: refusal("stale", "the window changed since s1") }) }) });
  assert.equal(said.error, "the window changed since s1");
});

test("a computer tool the run does not have is refused in words, and nothing runs", async () => {
  const { hands } = localHands();
  const local = createRegistry({ maxExecS: 600, shell: "local", executors: injected });
  assert.equal((await local.invoke("computer_observe", {}, { hands })).error, "computer_observe needs a desktop computer: set this agent's computer to desktop (Settings → Computers). A phone computer has it too.");
  assert.equal((await local.invoke("nothing_here", {}, { hands })).error, "there is no host tool nothing_here in this run");
  const noScreen = createRegistry({ maxExecS: 600, shell: "local", kinds: ["phone"], groups: ["ui", "input.touch"], executors: injected });
  assert.equal((await noScreen.invoke("computer_screenshot", {}, { hands })).error, "computer_screenshot is not offered by this phone computer: it offers ui, input.touch");
  // Listed, but the hands have no port: the kind's words.
  const desktop = createRegistry({ maxExecS: 600, shell: "local", kinds: ["desktop"], groups: MAC, executors: injected });
  assert.equal((await desktop.invoke("computer_observe", {}, { hands })).error, "computer_observe needs a desktop computer: set this agent's computer to desktop (Settings → Computers).");
});

test("the background tools' refusal with no computer names the setting", async () => {
  assert.equal(NEEDS_A_COMPUTER, "Background programs need a computer: run this agent with a sandbox computer (Settings → Computers; place sandbox in the v2 API).");
  const { hands } = localHands();
  const registry = createRegistry({ maxExecS: 600, shell: "local", kinds: ["desktop"], groups: MAC, executors: injected });
  assert.equal((await registry.invoke("bash_background", { command: "true" }, { hands })).error, NEEDS_A_COMPUTER);
});

test("only an abort throws: a computer tool whose call has aborted rejects", async () => {
  const registry = createRegistry({ maxExecS: 600, shell: "local", kinds: ["desktop"], groups: MAC, executors: injected });
  const hands = handsWith({ computer: fakeComputerPort() });
  await assert.rejects(registry.invoke("computer_observe", {}, { hands, signal: AbortSignal.abort(Object.assign(new Error("aborted"), { name: "AbortError" })) }), (error) => error.name === "AbortError");
});

test("the generated schemas are what model APIs take: inline, closed, no draft-04 tuples", () => {
  const text = JSON.stringify(COMPUTER_TOOL_SCHEMAS);
  assert.ok(!text.includes("$ref") && !text.includes('"items":['));
  for (const schema of Object.values(COMPUTER_TOOL_SCHEMAS)) assert.deepEqual([schema.type, schema.additionalProperties], ["object", false]);
  assert.deepEqual(COMPUTER_TOOL_SCHEMAS.computer_act.required, ["steps"]);
  assert.deepEqual(COMPUTER_TOOL_SCHEMAS.computer_script.required, ["code"]);
});
