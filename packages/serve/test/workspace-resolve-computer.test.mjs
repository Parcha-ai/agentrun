// The claim's resolver (serve/src/workspace/resolve-computer.ts resolveComputer): an agent's computer setting
// {kind, provider} in a mode, read against the computer module's kind registry, gives how to start the computer, whether
// it mounts the run's folder and which ports it fills, or a refusal in words that name the setting. Mode 1 refuses a
// sandbox that is not Docker, Mode 2 refuses Docker's; a desktop, a phone and a browser are allowed in both, mounted only
// where the provider mounts the mode's folder. A provider whose keys are not saved is refused. The kind registry here is
// a stand-in in the agreed shape (workspace-kinds-fixture.mjs); every computer is a loopback fake.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { readBackOf } from "@parcha/agentrun-computer";
import { localWorkspace, resolveComputer, runTools } from "../dist/workspace/index.js";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { KIND_REGISTRY } from "./workspace-kinds-fixture.mjs";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-resolve-")));
  dirs.push(dir);
  const root = join(dir, "work");
  mkdirSync(root);
  return root;
}

const SAVED = { daytona: { DAYTONA_API_KEY: "dk", UNRELATED: "x" }, e2b: { E2B_API_KEY: "ek" }, orgo: { ORGO_API_KEY: "ok" }, "phone-harness": { PHONE_HARNESS_API_KEY: "pk" }, browserbase: { BROWSERBASE_API_KEY: "bk", BROWSERBASE_PROJECT_ID: "bp" } };
/** The claim's side: the saved keys by provider, and a launch that makes a loopback fake of the kind asked. */
function claim(root, saved = SAVED) {
  const launched = [];
  return {
    launched,
    keysOf: async (id) => saved[id] ?? {},
    launch: async (entry, spec) => {
      launched.push([entry.id, spec]);
      if (spec.kind === "browser") return { id: "b1", groups: ["cdp"], connect: async () => ({ send: async () => ({}), on: () => () => {}, close: () => {} }), release: async () => void launched.push(["released", "b1"]) };
      const computer = fakeComputer(root);
      const groups = entry.capabilities.find((one) => (spec.kind === "phone" ? one.kind === "android" : spec.kind === "desktop" ? one.kind === "desktop" : one.kind === "linux")).groups;
      return { id: computer.id, client: computer.client, readBack: () => computer.readBack(), groups, release: async () => void launched.push(["released", computer.id]) };
    },
  };
}
const resolve = (setting, mode, root = scratch(), saved) => resolveComputer(setting, mode, KIND_REGISTRY, claim(root, saved));
const shape = (resolved) => ("refused" in resolved ? resolved : { kind: resolved.kind, provider: resolved.provider, mounts: resolved.mounts, ports: resolved.ports });

test("kind none is no computer: nothing to start, nothing mounted", async () => {
  const none = await resolve({ kind: "none" }, 1);
  assert.deepEqual(shape(none), { kind: "none", provider: null, mounts: false, ports: [] });
  const started = await none.start({ workspace: localWorkspace(scratch()), check: { readBackOf } });
  assert.equal(started.computer, undefined);
  await started.release();
});

test("Mode 1: a sandbox only on Docker, mounted; a desktop, a phone and a browser on any provider, mounted only where the provider binds", async () => {
  assert.deepEqual(shape(await resolve({ kind: "sandbox", provider: "docker" }, 1)), { kind: "sandbox", provider: "docker", mounts: true, ports: ["files", "exec", "processes"] });
  assert.deepEqual(shape(await resolve({ kind: "sandbox", provider: "daytona" }, 1)), {
    refused: "Mode 1 runs a sandbox only on Docker: a Daytona sandbox can't reach the run's folder on this machine. Pick Docker for this agent's computer in Settings → Computers, or another kind of computer.",
  });
  assert.deepEqual(shape(await resolve({ kind: "desktop", provider: "docker" }, 1)), { kind: "desktop", provider: "docker", mounts: true, ports: ["files", "exec", "processes", "screen", "input"] });
  assert.deepEqual(shape(await resolve({ kind: "desktop", provider: "e2b" }, 1)), { kind: "desktop", provider: "e2b", mounts: false, ports: ["screen", "input"] });
  assert.deepEqual(shape(await resolve({ kind: "phone", provider: "phone-harness" }, 1)), { kind: "phone", provider: "phone-harness", mounts: false, ports: ["phone"] });
  assert.deepEqual(shape(await resolve({ kind: "browser", provider: "browserbase" }, 1)), { kind: "browser", provider: "browserbase", mounts: false, ports: ["browser"] });
});

test("Mode 2: Docker's sandbox is refused; a remote sandbox mounts from Archil; a desktop mounts only where its provider mounts Archil and has files and exec", async () => {
  assert.deepEqual(shape(await resolve({ kind: "sandbox", provider: "docker" }, 2)), {
    refused: "Mode 2 keeps workspaces on Archil; a local Docker computer can't mount them. Pick a remote sandbox for this agent's computer in Settings → Computers, or no computer.",
  });
  assert.deepEqual(shape(await resolve({ kind: "sandbox", provider: "daytona" }, 2)), { kind: "sandbox", provider: "daytona", mounts: true, ports: ["files", "exec", "processes"] });
  assert.equal((await resolve({ kind: "desktop", provider: "docker" }, 2)).mounts, false, "Docker binds a folder of this machine, and Mode 2's is on Archil");
  assert.equal((await resolve({ kind: "desktop", provider: "e2b" }, 2)).mounts, true);
  assert.deepEqual(shape(await resolve({ kind: "desktop", provider: "orgo" }, 2)), { kind: "desktop", provider: "orgo", mounts: false, ports: ["screen", "input"] });
});

test("a setting the registry does not give is refused in words that name the setting", async () => {
  assert.deepEqual(await resolve({ kind: "laptop", provider: "docker" }, 1), { refused: "This agent's computer kind \"laptop\" is not one of none, sandbox, desktop, phone, browser: set it in Settings → Computers." });
  assert.deepEqual(await resolve({ kind: "desktop" }, 1), { refused: "A desktop computer needs a provider: pick one of Docker, E2B, Orgo for this agent's computer in Settings → Computers." });
  assert.deepEqual(await resolve({ kind: "desktop", provider: "daytona" }, 2), { refused: "Daytona gives no desktop computer: pick one of Docker, E2B, Orgo for this agent's computer in Settings → Computers." });
  assert.deepEqual(await resolve({ kind: "phone", provider: "nokia" }, 2), { refused: "\"nokia\" is no computer provider this server knows: pick one of Phone harness for this agent's computer in Settings → Computers." });
});

test("a provider whose required keys are not saved is refused at the claim, naming the keys and Settings → Computers; an optional key may be absent", async () => {
  assert.deepEqual(await resolve({ kind: "sandbox", provider: "daytona" }, 2, scratch(), {}), { refused: "Daytona needs its key DAYTONA_API_KEY saved: add it in Settings → Computers." });
  assert.deepEqual(await resolve({ kind: "browser", provider: "browserbase" }, 2, scratch(), { browserbase: { BROWSERBASE_API_KEY: "bk", BROWSERBASE_PROJECT_ID: "" } }), { refused: "Browserbase needs its key BROWSERBASE_PROJECT_ID saved: add it in Settings → Computers." });
  assert.deepEqual(await resolve({ kind: "browser", provider: "browserbase" }, 2, scratch(), {}), { refused: "Browserbase needs its keys BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID saved: add them in Settings → Computers." });
  assert.equal("refused" in (await resolve({ kind: "sandbox", provider: "daytona" }, 2, scratch(), { daytona: { DAYTONA_API_KEY: "dk" } })), false, "DAYTONA_API_URL is optional");
});

test("start: a mounted desktop launches with the run's folder as its mount and only its declared keys, and runTools gives the shell, the background tools and the desktop's", async () => {
  const root = scratch();
  const side = claim(root);
  const resolved = await resolveComputer({ kind: "desktop", provider: "docker" }, 1, KIND_REGISTRY, side);
  const started = await resolved.start({ workspace: localWorkspace(root), check: { readBackOf } });
  assert.deepEqual(side.launched, [["docker", { kind: "desktop", keys: {}, mount: { kind: "bind", path: root } }]]);
  const run = await runTools(localWorkspace(root), started.computer, { mode: 1, context: ctx });
  assert.deepEqual(run.registry.list().map((def) => def.name), ["read", "write", "edit", "bash", "bash_background", "bash_output", "bash_input", "bash_signal", "bash_list", "desktop_screen", "desktop_input"]);
  await started.release();
  assert.deepEqual(side.launched.at(-1), ["released", "fake-1"]);
  // A remote sandbox gets its declared keys and nothing else saved beside them.
  const daytona = claim(root);
  await (await resolveComputer({ kind: "sandbox", provider: "daytona" }, 2, KIND_REGISTRY, daytona)).start({ workspace: localWorkspace(root), check: { readBackOf } });
  assert.deepEqual(daytona.launched[0][1].keys, { DAYTONA_API_KEY: "dk" });
});

test("start: an unmounted desktop, a phone and a browser launch with no mount; their runs keep the runner's folder", async () => {
  const root = scratch();
  for (const [setting, mode, tools] of [
    [{ kind: "desktop", provider: "e2b" }, 1, ["desktop_screen", "desktop_input"]],
    [{ kind: "phone", provider: "phone-harness" }, 2, ["phone_screen", "phone_tap", "phone_swipe", "phone_type", "phone_apps", "phone_open"]],
  ]) {
    const side = claim(root);
    const started = await (await resolveComputer(setting, mode, KIND_REGISTRY, side)).start({ workspace: localWorkspace(root), check: { readBackOf } });
    assert.equal(side.launched[0][1].mount, undefined, setting.kind);
    const run = await runTools(localWorkspace(root), started.computer, { mode, context: ctx });
    assert.deepEqual(run.registry.list().map((def) => def.name), ["read", "write", "edit", "bash", ...tools], setting.kind);
  }
  const side = claim(root);
  const browser = await (await resolveComputer({ kind: "browser", provider: "browserbase" }, 1, KIND_REGISTRY, side)).start({ workspace: localWorkspace(root), check: { readBackOf } });
  assert.equal(browser.computer.kind, "browser");
  assert.equal(typeof (await browser.computer.connect()).send, "function");
  assert.deepEqual(side.launched[0], ["browserbase", { kind: "browser", keys: { BROWSERBASE_API_KEY: "bk", BROWSERBASE_PROJECT_ID: "bp" } }]);
});

test("start: a computer that cannot be had fails as computer_unavailable, in the provider's words", async () => {
  const side = { keysOf: async () => SAVED.e2b, launch: async () => { throw new Error("E2B answered 503: no capacity"); } };
  const resolved = await resolveComputer({ kind: "desktop", provider: "e2b" }, 2, KIND_REGISTRY, side);
  await assert.rejects(resolved.start({ workspace: localWorkspace(scratch()), check: { readBackOf } }), (error) => error.code === "computer_unavailable" && error.message === "E2B could not start a desktop computer: E2B answered 503: no capacity");
});
