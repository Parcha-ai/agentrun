// The claim's resolver (serve/src/workspace/resolve-computer.ts resolveComputer): an agent's computer setting
// {kind, provider} in a mode, read against the computer module's kind registry, gives how to start the computer, whether
// it mounts the run's folder and which ports it fills, or a refusal in words that name the setting. Mode 1 refuses a
// sandbox that is not Docker, Mode 2 refuses Docker's; a desktop, a phone and a browser are allowed in both, mounted only
// where the provider mounts the mode's folder. A provider whose keys are not saved is refused. The kind registry here is
// a stand-in in the agreed shape (workspace-kinds-fixture.mjs); every computer is a loopback fake. Where the run's shell
// is, read off the setting (runShellOf), is what the claim's runHands gives over the computer started, for every kind.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { readBackOf } from "@parcha/agentrun-computer";
import { capabilityToolDefs } from "@parcha/agentrun-kernel/kernel";
import { localWorkspace, resolveComputer, runShellOf, runTools } from "../dist/workspace/index.js";
import { runHands } from "../dist/workspace/run-tools.js";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { ARCHIL_KINDS, KINDS, PROVIDERS } from "./workspace-kinds-fixture.mjs";

/** A kind's own tools, as the kernel registry lists them (the hand-over the desktop and phone share among them). */
const kindTools = (kind) => capabilityToolDefs(kind).map((def) => def.name);

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-resolve-")));
  dirs.push(dir);
  const root = join(dir, "work");
  mkdirSync(root);
  return root;
}

const SAVED = { daytona: { DAYTONA_API_KEY: "dk", UNRELATED: "x" }, e2b: { E2B_API_KEY: "ek" }, orgo: { ORGO_API_KEY: "ok", ORGO_WORKSPACE_ID: "ws-1" }, "phone-harness": { PHONE_HARNESS_API_KEY: "pk" }, browserbase: { BROWSERBASE_API_KEY: "bk", BROWSERBASE_PROJECT_ID: "bp" } };
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
/** Resolved against the registry with the remote sandboxes mounting from Archil (ARCHIL_KINDS; since module D6 the
 *  module's own table, KINDS, says the same). */
const resolve = (setting, mode, root = scratch(), saved, kinds = ARCHIL_KINDS) => resolveComputer(setting, mode, kinds, claim(root, saved));
const KIND_REGISTRY = ARCHIL_KINDS;
const shape = (resolved) => ("refused" in resolved ? resolved : { kind: resolved.kind, provider: resolved.provider, mounts: resolved.mounts, ports: resolved.ports });

test("no setting is the server's default: in Mode 1 Docker's sandbox where Docker answers here, else no computer; in Mode 2 no computer", async () => {
  const answering = (ids) => ({ ...claim(scratch()), answers: async (id) => ids.includes(id) });
  const defaulted = await resolveComputer(undefined, 1, KINDS, answering(["docker"]));
  assert.deepEqual(shape(defaulted), { kind: "sandbox", provider: "docker", mounts: true, ports: ["files", "exec", "processes"] });
  assert.deepEqual(shape(await resolveComputer(undefined, 1, KINDS, answering([]))), { kind: "none", provider: null, mounts: false, ports: [] });
  assert.deepEqual(shape(await resolveComputer(undefined, 2, KINDS, answering(["docker"]))), { kind: "none", provider: null, mounts: false, ports: [] });
});

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

test("the module's own table takes archil mounts on Daytona, Modal and E2B (module D6): Mode 2 mounts a Daytona sandbox and an E2B desktop", async () => {
  assert.deepEqual(shape(await resolve({ kind: "sandbox", provider: "daytona" }, 2, scratch(), SAVED, KINDS)), { kind: "sandbox", provider: "daytona", mounts: true, ports: ["files", "exec", "processes"] });
  assert.equal((await resolve({ kind: "desktop", provider: "e2b" }, 2, scratch(), SAVED, KINDS)).mounts, true);
});

test("a setting the registry does not give is refused in words that name the setting, the registry's own reasons in them", async () => {
  assert.deepEqual(await resolve({ kind: "laptop", provider: "docker" }, 1), { refused: "This agent's computer: \"laptop\" is not a setting kind: none, sandbox, desktop, phone, browser. Set it in Settings → Computers." });
  assert.deepEqual(await resolve({ kind: "desktop" }, 1), { refused: "A desktop computer needs a provider: pick one of Docker, E2B, Orgo for this agent's computer in Settings → Computers." });
  assert.deepEqual(await resolve({ kind: "desktop", provider: "daytona" }, 2), {
    refused: "Daytona gives no desktop computer: kind desktop is a desktop machine, not a linux one; kind desktop needs groups screen, input.pointer, input.keys, which the provider does not declare. Pick one of Docker, E2B, Orgo for this agent's computer in Settings → Computers.",
  });
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
  const desktopOf = (id) => KIND_REGISTRY.PROVIDERS.find((one) => one.id === id).capabilities.find((one) => one.kind === "desktop");
  assert.deepEqual(side.launched, [["docker", { kind: "desktop", keys: {}, configuration: desktopOf("docker"), mount: { kind: "bind", path: root } }]]);
  const run = await runTools(localWorkspace(root), started.computer, { mode: 1, context: ctx });
  assert.deepEqual(run.registry.list().map((def) => def.name), ["read", "write", "edit", "bash", "bash_background", "bash_output", "bash_input", "bash_signal", "bash_list", ...kindTools("desktop")]);
  await started.release();
  assert.deepEqual(side.launched.at(-1), ["released", "fake-1"]);
  // A remote sandbox gets its declared keys and nothing else saved beside them.
  const daytona = claim(root);
  await (await resolveComputer({ kind: "sandbox", provider: "daytona" }, 2, KIND_REGISTRY, daytona)).start({ workspace: localWorkspace(root), check: { readBackOf } });
  assert.deepEqual(daytona.launched[0][1].keys, { DAYTONA_API_KEY: "dk" });
});

test("start: an unmounted desktop, a phone and a browser launch with no mount; their runs keep the runner's folder, with no shell in Mode 1 and Archil's exec in Mode 2", async () => {
  const root = scratch();
  for (const [setting, mode, tools] of [
    [{ kind: "desktop", provider: "e2b" }, 1, kindTools("desktop")],
    [{ kind: "phone", provider: "phone-harness" }, 2, ["bash", ...kindTools("phone")]],
  ]) {
    const side = claim(root);
    const started = await (await resolveComputer(setting, mode, KIND_REGISTRY, side)).start({ workspace: localWorkspace(root), check: { readBackOf } });
    assert.equal(side.launched[0][1].mount, undefined, setting.kind);
    const run = await runTools(localWorkspace(root), started.computer, { mode, context: ctx });
    assert.deepEqual(run.registry.list().map((def) => def.name), ["read", "write", "edit", ...tools], setting.kind);
  }
  const side = claim(root);
  const browser = await (await resolveComputer({ kind: "browser", provider: "browserbase" }, 1, KIND_REGISTRY, side)).start({ workspace: localWorkspace(root), check: { readBackOf } });
  assert.equal(browser.computer.kind, "browser");
  assert.equal(typeof (await browser.computer.connect()).send, "function");
  const browserbase = KIND_REGISTRY.PROVIDERS.find((one) => one.id === "browserbase").capabilities[0];
  assert.deepEqual(side.launched[0], ["browserbase", { kind: "browser", keys: { BROWSERBASE_API_KEY: "bk", BROWSERBASE_PROJECT_ID: "bp" }, configuration: browserbase }]);
});

test("start: a computer that cannot be had fails as computer_unavailable, in the provider's words", async () => {
  const side = { keysOf: async () => SAVED.e2b, launch: async () => { throw new Error("E2B answered 503: no capacity"); } };
  const resolved = await resolveComputer({ kind: "desktop", provider: "e2b" }, 2, KIND_REGISTRY, side);
  await assert.rejects(resolved.start({ workspace: localWorkspace(scratch()), check: { readBackOf } }), (error) => error.code === "computer_unavailable" && error.message === "E2B could not start a desktop computer: E2B answered 503: no capacity");
});

test("runShellOf, read off the setting, is the shell runHands gives the run over the computer started, for every kind in both modes; a refused setting has none", async () => {
  // [setting, mode, where its shell is]: a computer that mounts the folder has it; with none, Mode 2 has Archil's exec
  // ("local", bash only) and Mode 1 none at all, the folder being one of this server's own.
  const table = [
    [{ kind: "none" }, 1, "none"],
    [{ kind: "none" }, 2, "local"],
    [{ kind: "sandbox", provider: "docker" }, 1, "computer"],
    [{ kind: "sandbox", provider: "daytona" }, 2, "computer"],
    [{ kind: "desktop", provider: "docker" }, 1, "computer"],
    [{ kind: "desktop", provider: "e2b" }, 1, "none"],
    [{ kind: "desktop", provider: "e2b" }, 2, "computer"],
    [{ kind: "desktop", provider: "orgo" }, 2, "local"],
    [{ kind: "phone", provider: "phone-harness" }, 1, "none"],
    [{ kind: "phone", provider: "phone-harness" }, 2, "local"],
    [{ kind: "browser", provider: "browserbase" }, 1, "none"],
    [{ kind: "browser", provider: "browserbase" }, 2, "local"],
  ];
  for (const [setting, mode, shell] of table) {
    const label = `${setting.kind} ${setting.provider ?? ""} in Mode ${mode}`;
    assert.equal(runShellOf(setting, mode, KIND_REGISTRY), shell, `runShellOf: ${label}`);
    const root = scratch();
    const started = await (await resolve(setting, mode, root)).start({ workspace: localWorkspace(root), check: { readBackOf } });
    const run = await runHands(localWorkspace(root), started.computer, { mode, context: ctx });
    assert.equal(run.shell, shell, `runHands: ${label}`);
    assert.equal(run.executors.bash === undefined, shell === "none", `a bash executor only with a shell: ${label}`);
    await started.release();
  }
  assert.deepEqual(new Set(table.map(([setting]) => setting.kind)), new Set(Object.keys(KIND_REGISTRY.SETTING_KINDS)), "every setting kind is in the table");
  for (const [setting, mode] of [[{ kind: "sandbox", provider: "daytona" }, 1], [{ kind: "sandbox", provider: "docker" }, 2], [{ kind: "laptop", provider: "docker" }, 1], [{ kind: "desktop" }, 2], [{ kind: "phone", provider: "nokia" }, 2]]) {
    assert.ok("refused" in (await resolve(setting, mode)), `${setting.kind} in Mode ${mode} is refused`);
    assert.equal(runShellOf(setting, mode, KIND_REGISTRY), "none", `a refused setting runs nothing: ${setting.kind} ${setting.provider ?? ""} in Mode ${mode}`);
  }
});

/** A provider no serve file names, with two desktop images: Linux (the default, computerd's groups) and Windows, built by
 *  create()'s os option. */
const LINUX_GROUPS = PROVIDERS.find((one) => one.id === "e2b").capabilities.find((one) => one.kind === "desktop").groups;
const ACME = { id: "acme-desk", label: "Acme Desk", kinds: ["desktop"], keys: [], mounts: [], metered: true, defaultImage: { desktop: "linux" }, capabilities: [
  { kind: "desktop", groups: LINUX_GROUPS, image: "linux", options: {} },
  { kind: "desktop", groups: ["exec", "files", "screen", "input.pointer", "input.keys"], image: "windows", options: { os: "windows" } },
] };
const IMAGED = { ...KINDS, PROVIDERS: [...KINDS.PROVIDERS, ACME] };

test("a setting's image selects the provider's configuration of that image, whose options go to the launch; none named, the kind's default", async () => {
  const root = scratch();
  for (const [image, expected] of [["windows", ACME.capabilities[1]], [undefined, ACME.capabilities[0]], ["linux", ACME.capabilities[0]]]) {
    const side = claim(root);
    const resolved = await resolveComputer({ kind: "desktop", provider: "acme-desk", ...(image ? { image } : {}) }, 1, IMAGED, side);
    assert.equal(resolved.kind, "desktop", JSON.stringify(resolved));
    await resolved.start({ workspace: localWorkspace(root), check: { readBackOf } });
    assert.deepEqual(side.launched[0], ["acme-desk", { kind: "desktop", keys: {}, configuration: expected }], String(image));
  }
  // A provider whose configurations name no image launches the one that serves the kind.
  const e2b = claim(root);
  await (await resolveComputer({ kind: "desktop", provider: "e2b" }, 1, IMAGED, e2b)).start({ workspace: localWorkspace(root), check: { readBackOf } });
  assert.deepEqual(e2b.launched[0][1].configuration, PROVIDERS.find((one) => one.id === "e2b").capabilities.find((one) => one.kind === "desktop"));
});

test("Orgo's own descriptor: windows launches its configuration with its os, no image launches the Linux desktop; another image (macos too, until a server runs the janitor) is refused naming the two", async () => {
  const root = scratch();
  for (const [image, os] of [["windows", "windows"], [undefined, undefined]]) {
    const side = claim(root);
    const resolved = await resolveComputer({ kind: "desktop", provider: "orgo", ...(image ? { image } : {}) }, 1, KINDS, side);
    await resolved.start({ workspace: localWorkspace(root), check: { readBackOf } });
    const { configuration } = side.launched[0][1];
    assert.deepEqual([configuration.image, configuration.options.os], [image ?? "linux", os], String(image));
  }
  for (const image of ["beos", "macos"]) {
    assert.match((await resolveComputer({ kind: "desktop", provider: "orgo", image }, 1, KINDS, claim(root))).refused, new RegExp(`^Orgo has no desktop image "${image}"\\. It offers the desktop images linux, windows: pick one`));
  }
});

test("an image the provider does not offer for the kind is refused before anything starts, in words naming the ones it offers", async () => {
  const side = claim(scratch());
  assert.deepEqual(await resolveComputer({ kind: "desktop", provider: "acme-desk", image: "beos" }, 1, IMAGED, side), { refused: 'Acme Desk has no desktop image "beos". It offers the desktop images linux, windows: pick one for this agent\'s computer in Settings → Computers.' });
  assert.deepEqual(await resolveComputer({ kind: "desktop", provider: "e2b", image: "windows" }, 1, IMAGED, side), { refused: 'E2B has no desktop image "windows". It offers no desktop image to choose: remove the image for this agent\'s computer in Settings → Computers.' });
  assert.deepEqual(side.launched, [], "nothing was launched");
  assert.equal(runShellOf({ kind: "desktop", provider: "acme-desk", image: "beos" }, 2, IMAGED), "none", "a refused setting runs nothing");
});
