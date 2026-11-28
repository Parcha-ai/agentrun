// Settings → Computers, the serve side (computers.ts): createComputerRoutes over a real store on a temp file and a
// stand-in kind registry by its own names (fixtures/computer-kinds.mjs), with the account test through computer-keys.ts
// over fake provider modules. The kinds this server offers in each folder mode, each provider's keys saved or not (never
// a value), a key save that takes only a provider's declared names, sealed in the store, and an account test whose
// failures are plain words. No provider is ever called. A run's claim is refused by the resolver
// (workspace-resolve-computer.test.mjs).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { clearArchilSettings, saveArchilSettings } from "../dist/archil-settings.js";
import { PROVIDERS } from "@parcha/agentrun-computer";
import { createComputerRoutes, folderModeOf, hostCommandRefusals, hostCommandWhy, KeysRefused, modeRefusal, networkWords } from "../dist/computers.js";
import { getSealedKey } from "../dist/server-keys.js";
import { fakeFactories, KINDS, tools } from "./fixtures/computer-kinds.mjs";
import { storeOn, T0 } from "./store-helpers.mjs";
import { hostToolDefs } from "@parcha/agentrun-kernel/kernel";
import { hostToolsOf, registryHere, resolveComputer } from "../dist/workspace/resolve-computer.js";
import { KEY_TABLE, settingOptions } from "../dist/computer-keys.js";

/** What a computer that gives the run no shell of its own leaves out: a computer all the same, so never "no computer".
 *  On this server's own disk (Mode 1), and on the owner's (Mode 2). */
const APART_NONE = "This computer gives the run no shell: the agent gets the file tools only. Pick a computer that mounts the run's folder to run commands.";
const APART_LOCAL = "This computer doesn't mount the run's folder: bash runs in a fresh container on the folder's own storage; background commands need a computer that mounts it.";

/** A key's changed_at: the store's clock when it was saved. */
const CHANGED = new Date(T0).toISOString();

async function setup(t, { mode = "local", settings, kinds = KINDS, env, unbuilt = [] } = {}) {
  const sealKey = randomBytes(32);
  const { store } = await storeOn(t);
  const fake = fakeFactories();
  // A provider the server has no module for: the registry offers it, nothing here can make it.
  for (const id of unbuilt) delete fake.factories[id];
  const routes = createComputerRoutes({ store, sealKey, kinds, factories: fake.factories, ...(settings ? { settings } : {}), ...(env ? { env } : {}), tools, mode });
  return { store, sealKey, routes, ...fake };
}

test("an environment variable with a key's name overrides the saved one: source env, and the test takes its value", async (t) => {
  const { routes, built } = await setup(t, { env: { E2B_API_KEY: "fake-test-key", PATH: "/usr/bin" } });
  const view = await routes.view();
  assert.deepEqual(providerOf(view, "sandbox", "e2b").secrets, [{ name: "computer:e2b:E2B_API_KEY", set: true, source: "env", changed_at: null }]);
  assert.equal(providerOf(view, "desktop", "e2b").ready, true, "set by the environment, no save needed");
  assert.deepEqual(await routes.test("e2b"), { ok: true, detail: "e2b: 2 computers" });
  assert.deepEqual(built.at(-1), ["e2b", { apiKey: "fake-test-key" }]);
  await routes.saveKeys("e2b", { E2B_API_KEY: "test-key" });
  assert.equal(providerOf(await routes.view(), "sandbox", "e2b").secrets[0].source, "env", "the environment still wins over a saved value");
  await routes.test("e2b");
  assert.deepEqual(built.at(-1), ["e2b", { apiKey: "fake-test-key" }], "and its value is the one used");
  assert.ok(!JSON.stringify(await routes.view()).includes("fake-test-key"), "never a value");
  const empty = await setup(t, { env: { E2B_API_KEY: "" } });
  assert.equal(providerOf(await empty.routes.view(), "sandbox", "e2b").secrets[0].set, false, "an empty variable sets nothing");
});

const kindOf = (view, kind) => view.kinds.find((one) => one.kind === kind);
const providerOf = (view, kind, id) => kindOf(view, kind).providers.find((one) => one.id === id);

test("Mode 1 (run folders on this machine): a sandbox is Docker's alone; a desktop, phone or browser is any provider's, ready once its keys are saved", async (t) => {
  const { routes } = await setup(t);
  const view = await routes.view();
  assert.deepEqual(view.kinds.map((kind) => kind.kind), ["none", "sandbox", "desktop", "phone", "browser"]);
  assert.deepEqual([kindOf(view, "none").offered, kindOf(view, "none").providers], [true, []]);
  assert.deepEqual(kindOf(view, "sandbox").groups, ["exec", "files", "processes"]);
  assert.deepEqual(kindOf(view, "desktop").groups, ["screen", "input.pointer", "input.keys", "exec", "files", "processes", "apps", "ui", "stream"], "required, then optional");
  assert.deepEqual(kindOf(view, "desktop").tools, ["computer_observe", "computer_act"], "the kind's tools, from the kernel registry");
  for (const kind of ["sandbox", "desktop", "phone", "browser"]) {
    assert.deepEqual(kindOf(view, kind).providers.map((one) => one.id), PROVIDERS.filter((one) => one.kinds.includes(kind)).map((one) => one.id), `${kind}: the providers whose capabilities serve the kind, in the registry's order`);
  }
  assert.ok(kindOf(view, "sandbox").providers.some((one) => one.id === "docker"), "Docker serves the sandbox kind");
  assert.deepEqual(providerOf(view, "sandbox", "docker"), { id: "docker", name: "Docker", metered: false, secrets: [], required: [], ready: true, runs_refused: null, folder: "bind", shell: "computer", host_tools: hostToolsOf("computer") });
  assert.equal(providerOf(view, "sandbox", "daytona").metered, true, "metered as the kind registry says");
  assert.equal(providerOf(view, "sandbox", "daytona").ready, false);
  assert.match(providerOf(view, "sandbox", "daytona").why, /Daytona can't mount this server's run folders/);
  assert.deepEqual(providerOf(view, "phone", "phone-harness"), { id: "phone-harness", name: "Phone harness", metered: true, secrets: [{ name: "computer:phone-harness:PHONE_HARNESS_API_KEY", set: false, source: null, changed_at: null }], required: ["computer:phone-harness:PHONE_HARNESS_API_KEY"], ready: false, why: "Phone harness needs PHONE_HARNESS_API_KEY saved: save it in Settings → Computers", runs_refused: null, folder: null, network: "the vendor's own network; this server's allow-list doesn't apply", shell: "none", host_tools: ["read", "write", "edit"], shell_note: APART_NONE });
  assert.equal(kindOf(view, "sandbox").offered, true);
  // What this server's allow-list means for each provider, from its descriptor's network and the kind: none for a sandbox
  // of Docker's or of a hosted computer that runs init's egress proxy (Daytona, Modal, E2B), which takes the list; for
  // their desktops (E2B's, Agent37's), open unless the operator sets the list, as Local Chrome; words for a computer with
  // no network (Orgo's offered Linux desktop: its Windows one is parked), and for one on the vendor's own.
  const networkOf = (kind, id) => providerOf(view, kind, id).network;
  const operatorList = "open unless this server sets AGENTRUN_BOX_ALLOW; then only those hosts";
  assert.deepEqual(
    [networkOf("sandbox", "docker"), networkOf("sandbox", "daytona"), networkOf("sandbox", "modal"), networkOf("sandbox", "e2b"), networkOf("desktop", "e2b"), networkOf("desktop", "agent37"), networkOf("desktop", "orgo"), networkOf("browser", "kernel")],
    [undefined, undefined, undefined, undefined, operatorList, operatorList, "no network, so this server's allow-list isn't offered", "the vendor's own network; this server's allow-list doesn't apply"],
  );
  // Local Chrome, behind its own egress proxy ("open" and "allow", its descriptor's): open, unless the operator sets the
  // list.
  const local = PROVIDERS.find((one) => one.id === "local-chrome");
  assert.equal(networkWords(local.network), "open unless this server sets AGENTRUN_BOX_ALLOW; then only those hosts");
});

test("a provider that offers images by name lists them for the kind, its default first; one that offers none lists none", async (t) => {
  const acme = { id: "acme-desk", label: "Acme Desk", kinds: ["desktop"], keys: [], mounts: [], metered: true, defaultImage: { desktop: "linux" }, capabilities: [
    { kind: "desktop", groups: ["screen", "input.pointer", "input.keys"], image: "windows", options: { os: "windows" } },
    { kind: "desktop", groups: ["screen", "input.pointer", "input.keys"], image: "linux", options: {} },
  ] };
  const { routes } = await setup(t, { kinds: { ...KINDS, PROVIDERS: [...KINDS.PROVIDERS, acme] } });
  const view = await routes.view();
  assert.deepEqual(providerOf(view, "desktop", "acme-desk").images, ["linux", "windows"]);
  assert.equal("images" in providerOf(view, "desktop", "e2b"), false);
});

test("under AGENTRUN_BOX_ALLOW=none a computer that needs a network is not ready, and a kind only such computers serve is not offered, in words; a host list leaves them as they are", async (t) => {
  const keys = { PHONE_HARNESS_API_KEY: "fake", BROWSERBASE_API_KEY: "fake", BROWSERBASE_PROJECT_ID: "project", KERNEL_API_KEY: "fake" };
  const none = await (await setup(t, { env: { ...keys, AGENTRUN_BOX_ALLOW: "none" } })).routes.view();
  for (const [kind, id, label] of [["phone", "phone-harness", "Phone harness"], ["browser", "browserbase", "Browserbase"], ["browser", "kernel", "Kernel"]]) {
    const provider = providerOf(none, kind, id);
    assert.equal(provider.ready, false, `${id} is never usable on a server with no network`);
    assert.equal(provider.why, `${label} needs a network, and this server's AGENTRUN_BOX_ALLOW is none (no network): pick a computer that runs with no network, or restart the server with AGENTRUN_BOX_ALLOW set to a host list`);
    assert.equal(provider.network, "needs a network, which this server refuses: its AGENTRUN_BOX_ALLOW is none");
  }
  for (const kind of ["phone", "browser"]) {
    assert.equal(kindOf(none, kind).offered, false, `${kind}: every provider of it needs a network`);
    assert.equal(kindOf(none, kind).why, `every provider of a ${kind} computer needs a network, and this server's AGENTRUN_BOX_ALLOW is none (no network)`);
  }
  // A computer with no network of its own, or one that takes the list, is as it was.
  assert.deepEqual([kindOf(none, "sandbox").offered, providerOf(none, "sandbox", "docker").ready, providerOf(none, "desktop", "orgo").network], [true, true, "no network, so this server's allow-list isn't offered"]);
  // A host list: the vendor's own network runs, and Settings says the list doesn't reach it.
  const listed = await (await setup(t, { env: { ...keys, AGENTRUN_BOX_ALLOW: "pypi.org" } })).routes.view();
  assert.deepEqual([providerOf(listed, "phone", "phone-harness").ready, kindOf(listed, "phone").offered, providerOf(listed, "phone", "phone-harness").network], [true, true, "the vendor's own network; this server's allow-list doesn't apply"]);
});

test("Mode 2: a provider that takes the Archil mount and prepares no image holds a synced folder instead; one that takes neither is refused for its sandbox, saying why, and never for its desktop", () => {
  const e2b = PROVIDERS.find((one) => one.id === "e2b");
  const unprepared = { ...e2b, id: "made-up", label: "Acme", prepareImage: undefined };
  for (const kind of ["sandbox", "desktop"]) assert.equal(modeRefusal(kind, unprepared, "disk"), undefined, `${kind}: a synced folder needs no image`);
  const unsynced = { ...unprepared, mounts: ["archil"], unmounted: { sync: "Acme makes no /workspace yet" } };
  assert.equal(modeRefusal("sandbox", unsynced, "disk"), "Acme can't mount the owner's disk this server keeps run folders on (Acme makes no /workspace yet): set this agent's computer to a sandbox that mounts it, or none (Settings → Computers)");
  assert.equal(modeRefusal("desktop", unsynced, "disk"), undefined, "a desktop that holds no folder runs on Archil's exec");
  for (const kind of ["sandbox", "desktop"]) assert.equal(modeRefusal(kind, e2b, "disk"), undefined, `e2b's ${kind}: it prepares its image`);
});

test("Mode 1: a sandbox provider that could hold the run's folder on an Archil disk (Mode 2) says to turn Archil on, beside Docker or none; one that couldn't keeps to Docker or none", () => {
  const entry = (id) => PROVIDERS.find((one) => one.id === id);
  // No route in the words (a view's why ends at the setting): the console's own place for it, Settings → Workspace.
  const archil = (label) => `${label} can't mount this server's run folders (they are on its own disk): keep run folders on an Archil disk instead (turn on Archil in Settings → Workspace), or set this agent's computer to sandbox on Docker, or none (Settings → Computers)`;
  // E2B, Modal and Agent37 mount the Archil disk; Daytona and boxd hold a synced folder on it.
  for (const id of ["e2b", "modal", "agent37", "daytona", "boxd"]) assert.equal(modeRefusal("sandbox", entry(id), "local"), archil(entry(id).label), id);
  // smol cloud takes neither (its own disk sits at /workspace): Archil on would not seat its sandbox either.
  assert.equal(modeRefusal("sandbox", entry("smolcloud"), "local"), "smol cloud can't mount this server's run folders (they are on its own disk): set this agent's computer to sandbox on Docker, or none (Settings → Computers)");
  assert.equal(modeRefusal("sandbox", entry("docker"), "local"), undefined, "Docker binds the folder");
  assert.equal(modeRefusal("desktop", entry("e2b"), "local"), undefined, "a desktop holds no folder");
});

test("Mode 2: Docker's sandbox can't mount the owner's disk; Daytona's holds a synced folder, so it needs only its key; Modal's sandbox and E2B's and Agent37's sandbox and desktop are ready with their keys (their prepareImage answers the box image); a desktop, phone or browser is offered", async (t) => {
  const env = { MODAL_TOKEN_ID: "good-id", MODAL_TOKEN_SECRET: "good-secret", E2B_API_KEY: "fake-test-key", AGENT37_API_KEY: "not-a-secret", AGENT37_SSH_KEY: "not-a-secret-either" };
  const { routes } = await setup(t, { mode: "disk", env });
  const view = await routes.view();
  assert.match(providerOf(view, "sandbox", "docker").why, /Docker can't mount the owner's disk/);
  assert.equal(providerOf(view, "sandbox", "daytona").why, "Daytona needs DAYTONA_API_KEY saved: save it in Settings → Computers");
  // Modal prepares its image (the box image's public tag, pulled by Modal at the first create): ready once its keys are saved.
  assert.deepEqual([providerOf(view, "sandbox", "modal").ready, providerOf(view, "sandbox", "modal").why], [true, undefined], "modal: its keys are saved, so it is ready");
  assert.equal(kindOf(view, "sandbox").offered, true, "Modal's, E2B's and Agent37's sandboxes mount the owner's disk");
  assert.equal(providerOf(view, "desktop", "docker").ready, true, "a desktop holds no folder unless its provider mounts it");
  // E2B and Agent37 prepare their image (E2B's public box template; Agent37 registers the box image, and the first claim
  // waits on the registration): their sandbox and their desktop, which mounts the disk too, are ready once the keys are saved.
  for (const provider of ["e2b", "agent37"]) {
    for (const kind of ["sandbox", "desktop"]) assert.deepEqual([providerOf(view, kind, provider).ready, providerOf(view, kind, provider).why], [true, undefined], `${provider}'s ${kind}: its keys are saved, so it is ready`);
  }
  assert.equal(providerOf(view, "desktop", "orgo").why, "Orgo needs ORGO_API_KEY saved: save it in Settings → Computers", "Orgo's desktop mounts nothing: only its key");
  assert.equal(kindOf(view, "desktop").offered, true);
  assert.equal(kindOf(view, "phone").offered, true);
});

test("Mode 1: an E2B or Agent37 desktop mounts nothing, so it is never refused for Archil's image; E2B's key is all it needs", async (t) => {
  const { routes } = await setup(t, { env: { E2B_API_KEY: "fake-test-key", AGENT37_API_KEY: "not-a-secret" } });
  const view = await routes.view();
  assert.equal(providerOf(view, "desktop", "e2b").ready, true);
  assert.doesNotMatch(providerOf(view, "desktop", "agent37").why ?? "", /Mode 2|Archil/);
});

test("a kind no provider can serve here is not offered, and says why: in Mode 2 with Docker the only sandbox (it can't mount the owner's disk), and no phone provider", async (t) => {
  const { store } = await storeOn(t);
  // Docker for the sandbox, which can't mount the owner's disk, and Orgo, a desktop with no mounts: no phone provider.
  const kinds = { ...KINDS, PROVIDERS: KINDS.PROVIDERS.filter((one) => one.id === "docker" || one.id === "orgo") };
  const view = await createComputerRoutes({ store, sealKey: randomBytes(32), kinds, factories: fakeFactories().factories, tools, mode: "disk" }).view();
  assert.deepEqual([kindOf(view, "sandbox").offered, kindOf(view, "sandbox").why], [false, "no provider of a sandbox computer can reach this server's run folders"]);
  assert.deepEqual([kindOf(view, "phone").offered, kindOf(view, "phone").why, kindOf(view, "phone").providers], [false, "no provider serves a phone computer", []]);
});

test("each kind says whether its runs can record their screen here: a desktop, phone or browser with ffmpeg on the PATH can; without it, each says ffmpeg is missing; a sandbox and none never can, in words", async (t) => {
  const { store } = await storeOn(t);
  const viewOn = (path) => createComputerRoutes({ store, sealKey: randomBytes(32), kinds: KINDS, factories: fakeFactories().factories, tools, mode: "local", env: { PATH: path } }).view();
  const records = (view) => Object.fromEntries(view.kinds.map((one) => [one.kind, one.record]));
  const bin = await mkdtemp(join(tmpdir(), "record-path-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const noFfmpeg = "ffmpeg isn't installed on this server (no ffmpeg command on PATH)";
  const never = { none: { available: false, why: "with no computer, there is no screen to record" }, sandbox: { available: false, why: "a sandbox has no screen to record (a desktop, a phone or a browser does)" } };
  assert.deepEqual(records(await viewOn(bin)), { ...never, desktop: { available: false, why: noFfmpeg }, phone: { available: false, why: noFfmpeg }, browser: { available: false, why: noFfmpeg } });
  await writeFile(join(bin, "ffmpeg"), "#!/bin/sh\n");
  await chmod(join(bin, "ffmpeg"), 0o755);
  assert.deepEqual(records(await viewOn(`/nowhere${delimiter}${bin}`)), { ...never, desktop: { available: true }, phone: { available: true }, browser: { available: true } });
});

test("a key save takes only the provider's declared names, seals each in the store, answers names and saved flags only, and null removes", async (t) => {
  const { store, sealKey, routes } = await setup(t);
  await assert.rejects(routes.saveKeys("browserbase", { BROWSERBASE_API_KEY: "good-a", OPENAI_API_KEY: "sk-x" }), (error) => error instanceof KeysRefused && error.fields.map((f) => [f.field, f.reason]).join() === "OPENAI_API_KEY,not_allowed");
  await assert.rejects(routes.saveKeys("browserbase", { BROWSERBASE_API_KEY: 7 }), (error) => error instanceof KeysRefused && error.fields[0].reason === "wrong_type");
  // Whitespace alone is no value, as a key in the environment is none (key-meta.ts envValue): refused, never saved as set.
  for (const blank of [" ", "\t\n"]) await assert.rejects(routes.saveKeys("browserbase", { BROWSERBASE_API_KEY: blank }), (error) => error instanceof KeysRefused && error.fields[0].reason === "wrong_type" && /a non-empty string/.test(error.fields[0].message), JSON.stringify(blank));
  assert.deepEqual(await store.sealedKeys.all(), [], "nothing saved when any name is refused");
  const saved = await routes.saveKeys("browserbase", { BROWSERBASE_API_KEY: "good-b1", BROWSERBASE_PROJECT_ID: "good-proj" });
  assert.deepEqual(saved, { id: "browserbase", name: "Browserbase", metered: true, secrets: [{ name: "computer:browserbase:BROWSERBASE_API_KEY", set: true, source: "console", changed_at: CHANGED }, { name: "computer:browserbase:BROWSERBASE_PROJECT_ID", set: true, source: "console", changed_at: CHANGED }], required: ["computer:browserbase:BROWSERBASE_API_KEY", "computer:browserbase:BROWSERBASE_PROJECT_ID"], ready: true, runs_refused: null, folder: null, network: "the vendor's own network; this server's allow-list doesn't apply", shell: "none", host_tools: ["read", "write", "edit"], shell_note: APART_NONE }, "the shared secret shape: set, where from, when changed; never a value; and the shell a browser gives (none: it mounts no folder)");
  assert.ok(!JSON.stringify(saved).includes("good-b1"), "never echoed");
  assert.ok(!JSON.stringify(await routes.view()).includes("good-b1"), "nor in the view");
  assert.equal(await getSealedKey(store, sealKey, "BROWSERBASE_API_KEY"), "good-b1", "sealed, and opens with the server's key");
  assert.ok(!Buffer.from(await store.sealedKeys.get("BROWSERBASE_API_KEY")).toString("latin1").includes("good-b1"), "the store holds ciphertext only");
  assert.equal((await routes.saveKeys("browserbase", { BROWSERBASE_PROJECT_ID: null })).ready, false, "null removes");
  assert.equal(await routes.saveKeys("nope", {}), undefined, "an unknown provider");
});

test("a provider's test opens its saved keys, makes it with them through computer-keys, and reads its account once; failures are its plain words, with no key", async (t) => {
  const { routes, built } = await setup(t, { settings: { modalApp: "runs-app" }, unbuilt: ["browserbase"] });
  assert.deepEqual(await routes.test("e2b"), { ok: false, why: "E2B needs E2B_API_KEY saved: save it in Settings → Computers" });
  assert.deepEqual(built, [], "nothing made with a key missing");
  await routes.saveKeys("e2b", { E2B_API_KEY: "good-e" });
  assert.deepEqual(await routes.test("e2b"), { ok: true, detail: "e2b: 2 computers" });
  assert.deepEqual(built.at(-1), ["e2b", { apiKey: "good-e" }]);
  await routes.saveKeys("e2b", { E2B_API_KEY: "bad-e2b" });
  const refused = await routes.test("e2b");
  assert.equal(refused.ok, false);
  assert.match(refused.why, /^E2B refused the saved key: check E2B_API_KEY in Settings → Computers\./);
  assert.ok(!refused.why.includes("bad-e2b"), "the key never comes back");
  await routes.saveKeys("daytona", { DAYTONA_API_KEY: "down-dt", DAYTONA_API_URL: "https://d.example/api" });
  const unreachable = await routes.test("daytona");
  assert.match(unreachable.why, /^Daytona could not be reached/);
  assert.ok(!unreachable.why.includes("down-dt"));
  assert.deepEqual(built.at(-1), ["daytona", { apiKey: "down-dt", apiUrl: "https://d.example/api" }]);
  await routes.saveKeys("modal", { MODAL_TOKEN_ID: "ak-1", MODAL_TOKEN_SECRET: "good-m" });
  assert.deepEqual(await routes.test("modal"), { ok: true, detail: "modal: 2 computers" });
  assert.deepEqual(built.at(-1), ["modal", { tokenId: "ak-1", tokenSecret: "good-m", app: "runs-app" }], "the server's own setting with the keys");
  assert.deepEqual(await routes.test("docker"), { ok: true, detail: "docker: 2 computers" }, "Docker takes no key");
  await routes.saveKeys("browserbase", { BROWSERBASE_API_KEY: "good-b", BROWSERBASE_PROJECT_ID: "good-p" });
  assert.equal((await routes.test("browserbase")).ok, false, "a provider with no module here is not tested");
  assert.equal(await routes.test("nope"), undefined);
});

test("a provider's test answer that quotes the saved key in another form (base64 in an auth header, hex) comes back with no form of it, failed or ok", async (t) => {
  const sealKey = randomBytes(32);
  const { store } = await storeOn(t);
  const KEY = "fake-test-key";
  const forms = [Buffer.from(KEY).toString("base64"), Buffer.from(KEY).toString("hex")];
  // A vendor that echoes the key it was made with in the forms testConnection's plain cut does not know.
  let answer = "refused";
  const echoing = (options) => ({
    async testConnection() {
      const said = `Authorization: Basic ${Buffer.from(options.apiKey).toString("base64")} (key id ${Buffer.from(options.apiKey).toString("hex")})`;
      return answer === "ok" ? { ok: true, value: { detail: `2 computers for ${said}` } } : { ok: false, error: { code: "unauthorized", message: `401 ${said}` } };
    },
  });
  const routes = createComputerRoutes({ store, sealKey, kinds: KINDS, factories: { e2b: echoing }, tools, mode: "local" });
  await routes.saveKeys("e2b", { E2B_API_KEY: KEY });
  const refused = await routes.test("e2b");
  assert.equal(refused.ok, false);
  assert.match(refused.why, /^E2B refused the saved key: check E2B_API_KEY in Settings → Computers\./, "the plain words stay");
  for (const form of [KEY, ...forms]) assert.ok(!refused.why.includes(form), `no ${form} in the why: ${refused.why}`);
  answer = "ok";
  const ok = await routes.test("e2b");
  assert.equal(ok.ok, true);
  for (const form of [KEY, ...forms]) assert.ok(!ok.detail.includes(form), `no ${form} in the detail: ${ok.detail}`);
});

test("a provider whose host command is not on this machine's PATH is not ready, its key saved or not, in words of what to install", async (t) => {
  const NO_ADB = "adb isn't installed on this server (no adb command on PATH): install Android platform-tools, then restart AgentRun";
  // hostCommandRefusals reads PATH's folders: a folder with an executable adb has it, one without (or a plain file) not.
  const dir = await mkdtemp(join(tmpdir(), "host-command-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "with"));
  await mkdir(join(dir, "plain"));
  await writeFile(join(dir, "with", "adb"), "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(join(dir, "plain", "adb"), "not a program", { mode: 0o644 });
  const phone = PROVIDERS.find((one) => one.id === "phone-harness");
  const docker = PROVIDERS.find((one) => one.id === "docker");
  const on = (path, platform = "linux", arch = "x64") => hostCommandRefusals([phone, docker], path, platform, arch);
  assert.deepEqual(on([join(dir, "plain"), join(dir, "with")].join(delimiter)), {});
  assert.deepEqual(on([join(dir, "plain"), join(dir, "nowhere")].join(delimiter)), { "phone-harness": NO_ADB });
  assert.deepEqual(on(undefined), { "phone-harness": NO_ADB }, "no PATH at all has none");
  assert.deepEqual(on(join(dir, "nowhere"), "darwin", "arm64"), { "phone-harness": NO_ADB }, "macOS on arm64 has a build: install it");
  // On arm64 Linux, platform-tools has no build, and AgentRun's arm64 image carries none: the words say what it needs.
  assert.deepEqual(on(join(dir, "nowhere"), "linux", "arm64"), { "phone-harness": "this server's image has no adb for arm64 (Android platform-tools has no Linux build for arm64): Phone harness needs an x86-64 server" });
  assert.deepEqual(on(join(dir, "with"), "linux", "arm64"), {}, "an adb found there is used");
  // On Windows platform-tools installs adb.exe: found by its extension there, and not on other platforms.
  await mkdir(join(dir, "win"));
  await writeFile(join(dir, "win", "adb.exe"), "MZ", { mode: 0o755 });
  assert.deepEqual(on(join(dir, "win"), "win32"), {}, "adb.exe is adb on Windows");
  assert.deepEqual(Object.keys(on(join(dir, "win"), "linux")), ["phone-harness"], "and no adb elsewhere");
  assert.match(hostCommandWhy("Phone harness", phone.hostCommand, "freebsd", "x64"), /: Phone harness needs a server where Android platform-tools runs \(linux-x64, darwin-x64, darwin-arm64, win32-x64\)$/);
  // The computer package's own registry names adb for the phone, and nothing else.
  assert.deepEqual(Object.keys(hostCommandRefusals(PROVIDERS, join(dir, "nowhere"), "linux", "x64")), ["phone-harness"]);

  const sealKey = randomBytes(32);
  const { store } = await storeOn(t);
  const routes = createComputerRoutes({ store, sealKey, kinds: KINDS, factories: fakeFactories().factories, tools, mode: "local", hostWhy: { "phone-harness": NO_ADB } });
  const phoneView = async () => providerOf(await routes.view(), "phone", "phone-harness");
  assert.deepEqual([(await phoneView()).ready, (await phoneView()).why], [false, NO_ADB]);
  await routes.saveKeys("phone-harness", { PHONE_HARNESS_API_KEY: "good-p" });
  assert.deepEqual([(await phoneView()).ready, (await phoneView()).why], [false, NO_ADB], "its key saved, still not ready");
});

test("the folder mode is read at each call (folderModeOf): turning Archil on or off takes effect without building the routes again", async (t) => {
  const { store } = await storeOn(t);
  const routes = createComputerRoutes({ store, sealKey: randomBytes(32), kinds: KINDS, factories: fakeFactories().factories, tools, mode: folderModeOf(store) });
  const docker = async () => (await routes.view()).kinds.find((one) => one.kind === "sandbox").providers.find((one) => one.id === "docker");
  assert.equal((await docker()).ready, true, "Mode 1: Docker's sandbox");
  await saveArchilSettings(store, { diskId: "dsk-00000000000fake0", region: "aws-us-east-1", s3Url: "https://s3.archil.example" });
  assert.match((await docker()).why, /can't mount the owner's disk/, "Mode 2 at the next call");
  await clearArchilSettings(store);
  assert.equal((await docker()).ready, true, "Mode 1 again");
});

test("the folder mode reads the Archil settings in the server's environment too: Mode 2 with nothing saved", async (t) => {
  const { store } = await storeOn(t);
  const env = { AGENTRUN_ARCHIL_REGION: "aws-us-east-1", AGENTRUN_ARCHIL_S3_URL: "https://s3.archil.example" };
  assert.equal(await folderModeOf(store, env)(), "disk");
  assert.equal(await folderModeOf(store)(), "local", "the same store without it: Mode 1");
});

test("each choice says where its runs have their shell, the host tools that gives (the kernel registry's own list) and what it leaves out: no computer in each mode, a sandbox, and a desktop whose provider does not mount", async (t) => {
  const names = (shell) => hostToolDefs({ maxExecS: 600, shell }).map((def) => def.name);
  assert.deepEqual([names("none"), names("local"), names("computer")], [["read", "write", "edit"], ["read", "write", "edit", "bash"], ["read", "write", "edit", "bash", "bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"]]);
  const choice = (one) => ({ shell: one.shell, host_tools: one.host_tools, shell_note: one.shell_note });
  // Mode 1: the run folders are this server's own.
  const local = await (await setup(t)).routes.view();
  assert.deepEqual(choice(kindOf(local, "none")), { shell: "none", host_tools: names("none"), shell_note: "No computer on this server: the agent gets the file tools only, no shell. Pick a computer to run commands." });
  assert.deepEqual(choice(providerOf(local, "sandbox", "docker")), { shell: "computer", host_tools: names("computer"), shell_note: undefined });
  assert.deepEqual(choice(providerOf(local, "desktop", "e2b")), { shell: "none", host_tools: names("none"), shell_note: APART_NONE }, "E2B's desktop does not bind this server's folder: a computer all the same, never \"no computer\"");
  assert.deepEqual(choice(providerOf(local, "desktop", "docker")), { shell: "computer", host_tools: names("computer"), shell_note: undefined }, "Docker's desktop binds it");
  // Mode 2: the run folders are on the owner's disk.
  const disk = await (await setup(t, { mode: "disk", kinds: KINDS })).routes.view();
  assert.deepEqual(choice(kindOf(disk, "none")), { shell: "local", host_tools: names("local"), shell_note: "No computer: bash runs in a fresh container on the folder's own storage; background commands need a computer." });
  assert.deepEqual(choice(providerOf(disk, "sandbox", "e2b")), { shell: "computer", host_tools: names("computer"), shell_note: undefined });
  assert.deepEqual(choice(providerOf(disk, "desktop", "orgo")), { shell: "local", host_tools: names("local"), shell_note: APART_LOCAL }, "Orgo's desktop does not mount the disk: a computer all the same, never \"no computer\"");
  assert.deepEqual(choice(providerOf(disk, "desktop", "e2b")), { shell: "computer", host_tools: names("computer"), shell_note: undefined }, "E2B's desktop mounts it");
  for (const view of [local, disk]) {
    for (const kind of view.kinds) {
      for (const one of kind.kind === "none" ? [kind] : kind.providers) assert.deepEqual(one.host_tools, names(one.shell), `${kind.kind} ${one.id ?? ""}`);
    }
  }
});

test("each provider's folder is the one a run's claim holds for its computer, per kind, in either mode, with DAYTONA_ARCHIL_EGRESS and Daytona's snapshot each set or not; it names a kind, never a value", async (t) => {
  const EGRESS = "https://egress.not-a-secret.example";
  const SNAPSHOT = "not-a-secret-archil-snapshot";
  // The claim's own path (computer-for-claim.ts computerForClaim): the registry as this server has it (registryHere, with
  // each provider's setting options), then the resolver, with every key saved so no refusal is for a key.
  const claimed = async (env, mode, kind, provider) => {
    const registry = await registryHere(KINDS, async (name) => env[name], (id) => settingOptions(id, {}, KEY_TABLE));
    const keysOf = async (id) => Object.fromEntries(KINDS.PROVIDERS.find((one) => one.id === id).keys.map((key) => [key.name, "fake-test-key"]));
    const resolved = await resolveComputer({ kind, provider }, mode, registry, { keysOf, answers: async () => true, launch: async () => { throw new Error("nothing starts"); } });
    return "refused" in resolved ? null : resolved.folder ?? null;
  };
  const seen = new Set();
  for (const mode of ["local", "disk"]) {
    for (const egress of [false, true]) {
      for (const snapshot of [false, true]) {
        const env = { ...(egress ? { DAYTONA_ARCHIL_EGRESS: EGRESS } : {}), ...(snapshot ? { AGENTRUN_DAYTONA_SNAPSHOT: SNAPSHOT } : {}) };
        const view = await (await setup(t, { mode, env })).routes.view();
        const settings = `${mode}, egress ${egress ? "set" : "unset"}, snapshot ${snapshot ? "named" : "not named"}`;
        for (const kind of view.kinds.filter((one) => one.kind !== "none")) {
          for (const row of kind.providers) {
            assert.equal(row.folder, await claimed(env, mode === "disk" ? 2 : 1, kind.kind, row.id), `${settings}: ${kind.kind} on ${row.id}`);
            seen.add(row.folder);
          }
        }
        const folders = Object.fromEntries([["sandbox", "docker"], ["desktop", "docker"], ["sandbox", "daytona"], ["sandbox", "modal"], ["desktop", "modal"], ["desktop", "e2b"], ["sandbox", "agent37"], ["sandbox", "morph"], ["desktop", "orgo"], ["phone", "phone-harness"], ["browser", "browserbase"]].map(([kind, id]) => [`${kind} ${id}`, providerOf(view, kind, id).folder]));
        const archil = egress && snapshot ? "archil" : "sync";
        assert.deepEqual(folders, mode === "local"
          ? { "sandbox docker": "bind", "desktop docker": "bind", "sandbox daytona": null, "sandbox modal": null, "desktop modal": null, "desktop e2b": null, "sandbox agent37": null, "sandbox morph": null, "desktop orgo": null, "phone phone-harness": null, "browser browserbase": null }
          : { "sandbox docker": null, "desktop docker": null, "sandbox daytona": archil, "sandbox modal": "archil", "desktop modal": "sync", "desktop e2b": "archil", "sandbox agent37": "archil", "sandbox morph": "sync", "desktop orgo": null, "phone phone-harness": null, "browser browserbase": null }, settings);
        const text = JSON.stringify(view);
        assert.ok(!text.includes(EGRESS) && !text.includes(SNAPSHOT), `${settings}: no value in the view`);
      }
    }
  }
  assert.deepEqual([...seen].sort(), ["archil", "bind", "sync", null].sort(), "every kind is reached");
});

/** The words a person reads when no Docker daemon answers here, over the fixture registry: a Mode 1 sandbox (its vendors
 *  need Archil first) and a desktop in either mode. */
const NO_DOCKER_SANDBOX = "No Docker on this server: Render and most hosted services run none. A vendor sandbox (Modal, E2B or Agent37) needs Archil turned on in Settings → Workspace.";
const NO_DOCKER_DESKTOP = "No Docker on this server: Render and most hosted services run none. Use a vendor computer, e.g. Daytona, Modal, E2B, Agent37, Cloudflare, Fly Machines, Orgo, boxd or Groundbox for a desktop.";

test("no Docker daemon here: Docker is not ready, in words that name the vendors of each kind", async (t) => {
  const asked = [];
  const answers = async (provider) => (asked.push(provider), { up: false, absent: true, reason: "docker version failed: exit 1" });
  const { store } = await storeOn(t);
  const routes = createComputerRoutes({ store, sealKey: randomBytes(32), kinds: KINDS, factories: fakeFactories().factories, tools, mode: "local", answers });
  const view = await routes.view();
  assert.deepEqual([providerOf(view, "sandbox", "docker").ready, providerOf(view, "sandbox", "docker").why], [false, NO_DOCKER_SANDBOX]);
  assert.deepEqual([providerOf(view, "desktop", "docker").ready, providerOf(view, "desktop", "docker").why], [false, NO_DOCKER_DESKTOP]);
  assert.deepEqual(asked, ["docker"], "one ask per view, for the one provider that binds a folder of this machine");
  // A daemon that is there but refuses this process says its own reason.
  const denied = createComputerRoutes({ store, sealKey: randomBytes(32), kinds: KINDS, factories: fakeFactories().factories, tools, mode: "local", answers: async () => ({ up: false, absent: false, reason: "This server's process isn't in the docker group" }) });
  assert.equal(providerOf(await denied.view(), "sandbox", "docker").why, "This server's process isn't in the docker group");
  // Mode 2: Docker's sandbox is refused for the mode first (it can't mount the owner's disk); its desktop says the words.
  const archil = createComputerRoutes({ store, sealKey: randomBytes(32), kinds: KINDS, factories: fakeFactories().factories, tools, mode: "disk", answers });
  const inDisk = await archil.view();
  assert.match(providerOf(inDisk, "sandbox", "docker").why, /can't mount the owner's disk/);
  assert.equal(providerOf(inDisk, "desktop", "docker").why, NO_DOCKER_DESKTOP);
});

test("a Docker daemon that answers: Docker is ready", async (t) => {
  const { store } = await storeOn(t);
  const routes = createComputerRoutes({ store, sealKey: randomBytes(32), kinds: KINDS, factories: fakeFactories().factories, tools, mode: "local", answers: async () => ({ up: true }) });
  const view = await routes.view();
  assert.deepEqual(providerOf(view, "sandbox", "docker"), { id: "docker", name: "Docker", metered: false, secrets: [], required: [], ready: true, runs_refused: null, folder: "bind", shell: "computer", host_tools: hostToolsOf("computer") });
  assert.equal(providerOf(view, "desktop", "docker").ready, true);
});

test("no view's why holds a route: the words a person reads end at the setting, in either mode, with no key saved and no Docker", async (t) => {
  // KINDS is the computer package's own registry, as the server serves it, so every provider's words are checked.
  const kinds = KINDS;
  const { store } = await storeOn(t);
  for (const mode of ["local", "disk"]) {
    for (const answers of [async () => ({ up: false, absent: true, reason: "no daemon" }), async () => ({ up: true })]) {
      const view = await createComputerRoutes({ store, sealKey: randomBytes(32), kinds, factories: fakeFactories().factories, tools, mode, answers }).view();
      const whys = view.kinds.flatMap((kind) => [kind.why, ...kind.providers.map((one) => one.why)]).filter((why) => why !== undefined);
      assert.ok(whys.length > 0, `some provider is not ready in ${mode}`);
      for (const why of whys) assert.ok(!why.includes("PUT ") && !why.includes("/v2/"), `a view's why holds a route (${mode}): ${why}`);
    }
  }
});

test("a sandbox provider's GPUs show on GET /v2/computers as its configuration declares them, with why a run here cannot have them", async (t) => {
  const { routes } = await setup(t, { mode: "disk" });
  const view = await routes.view();
  const daytona = providerOf(view, "sandbox", "daytona").gpu;
  assert.deepEqual([daytona.types, daytona.max, daytona.preemptible, daytona.stopDeletes, daytona.region, daytona.perGpu, daytona.mounts], [["H100"], 1, true, true, "earth", { cpus: 16, memoryMb: 102400, diskMb: 409600 }, ["sync"]]);
  // Mode 2's folder in a GPU computer is a synced folder, which Daytona's and Modal's GPU computers take: no why. Each
  // provider's reason for taking no Archil mount stays out of the view.
  assert.equal("unmounted" in daytona, false, "the reason is never a field of its own");
  assert.equal(daytona.why, undefined);
  const modal = providerOf(view, "sandbox", "modal").gpu;
  assert.deepEqual([modal.types.slice(0, 2), modal.isolation, modal.preemptible, modal.mounts], [["T4", "L4"], "gvisor", true, ["sync"]]);
  assert.equal(modal.why, undefined);
  assert.equal(providerOf(view, "sandbox", "docker").gpu, undefined, "Docker declares no GPU");
  assert.equal(providerOf(view, "desktop", "e2b").gpu, undefined, "only a sandbox takes GPUs");
});

test("a picked key (Orgo's workspace): the view lists it under picked, and choices reads its options from the provider made with the saved keys, marking the one saved", async (t) => {
  const sealKey = randomBytes(32);
  const { store } = await storeOn(t);
  const made = [];
  const workspaces = [{ value: "ws-a", label: "alpha" }, { value: "ws-b", label: "beta" }];
  const factories = { orgo: async (options) => (made.push(options), { keyChoices: async (option) => (option === "workspaceId" ? { ok: true, value: workspaces } : { ok: false, error: { code: "unsupported", message: option } }) }) };
  const routes = createComputerRoutes({ store, sealKey, kinds: KINDS, factories, tools, mode: "local" });
  const orgo = providerOf(await routes.view(), "desktop", "orgo");
  assert.deepEqual([orgo.required, orgo.picked], [["computer:orgo:ORGO_API_KEY"], ["computer:orgo:ORGO_WORKSPACE_ID"]]);
  assert.equal(providerOf(await routes.view(), "sandbox", "docker").picked, undefined, "a provider with no picked key has no picked list");
  // No key saved yet: why, naming the key to save; nothing made.
  assert.deepEqual(await routes.choices("orgo"), { choices: [{ key: "ORGO_WORKSPACE_ID", why: "Orgo needs ORGO_API_KEY saved: save it in Settings → Computers" }] });
  assert.deepEqual(made, []);
  await routes.saveKeys("orgo", { ORGO_API_KEY: "fake-test-key" });
  assert.deepEqual(await routes.choices("orgo"), { choices: [{ key: "ORGO_WORKSPACE_ID", options: workspaces }] });
  assert.deepEqual(made, [{ apiKey: "fake-test-key" }]);
  // Picked: saved under the key, as any key is, and marked saved among the options.
  const saved = await routes.saveKeys("orgo", { ORGO_WORKSPACE_ID: "ws-b" });
  assert.equal(saved.secrets.find((one) => one.name === "computer:orgo:ORGO_WORKSPACE_ID").set, true);
  assert.deepEqual(await routes.choices("orgo"), { choices: [{ key: "ORGO_WORKSPACE_ID", options: workspaces, saved: "ws-b" }] });
  assert.deepEqual(await routes.choices("docker"), { choices: [] });
  assert.equal(await routes.choices("nobody"), undefined);
  // An account with none: the provider's words.
  const none = createComputerRoutes({ store, sealKey, kinds: KINDS, factories: { orgo: async () => ({ keyChoices: async () => ({ ok: false, error: { code: "not_found", message: "this Orgo key's account has no workspace: make one at orgo.ai" } }) }) }, tools, mode: "local" });
  assert.deepEqual(await none.choices("orgo"), { choices: [{ key: "ORGO_WORKSPACE_ID", why: "this Orgo key's account has no workspace: make one at orgo.ai" }] });
});
