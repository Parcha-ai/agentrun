// Settings → Computers, the serve side (computers.ts): createComputerRoutes over a real store on a temp file and a
// stand-in kind registry by its own names (fixtures/computer-kinds.mjs), with the account test and the claim's options
// through computer-keys.ts over fake provider modules. The kinds this server offers in each folder mode, each provider's
// keys saved or not (never a value), a key save that takes only a provider's declared names, sealed in the store, an
// account test whose failures are plain words, and the refusal a run meets at its claim when its computer cannot be had,
// in words that name the setting to fill, else the options its provider is made with. No provider is ever called.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { clearArchilSettings, saveArchilSettings } from "../dist/archil-settings.js";
import { PROVIDERS } from "@parcha/agentrun-computer";
import { createComputerRoutes, folderModeOf, hostCommandRefusals, hostCommandWhy, KeysRefused, networkWords } from "../dist/computers.js";
import { getSealedKey } from "../dist/server-keys.js";
import { fakeFactories, KINDS, tools } from "./fixtures/computer-kinds.mjs";
import { storeOn, T0 } from "./store-helpers.mjs";
import { hostToolDefs } from "@parcha/agentrun-kernel/kernel";
import { hostToolsOf, SHELL_NOTES } from "../dist/workspace/resolve-computer.js";

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

test("an environment variable with a key's name overrides the saved one: source env, and the test and the claim take its value", async (t) => {
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
  assert.equal(await routes.claimRefusal({ kind: "desktop", provider: "e2b" }), undefined);
  assert.deepEqual(await routes.claimOptions({ kind: "desktop", provider: "e2b" }), { ok: true, options: { apiKey: "fake-test-key" } });
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
  assert.deepEqual(providerOf(view, "sandbox", "docker"), { id: "docker", name: "Docker", metered: false, secrets: [], required: [], ready: true, shell: "computer", host_tools: hostToolsOf("computer") });
  assert.equal(providerOf(view, "sandbox", "daytona").metered, true, "metered as the kind registry says");
  assert.equal(providerOf(view, "sandbox", "daytona").ready, false);
  assert.match(providerOf(view, "sandbox", "daytona").why, /Daytona can't mount this server's run folders/);
  assert.deepEqual(providerOf(view, "phone", "phone-harness"), { id: "phone-harness", name: "Phone harness", metered: true, secrets: [{ name: "computer:phone-harness:PHONE_HARNESS_API_KEY", set: false, source: null, changed_at: null }], required: ["computer:phone-harness:PHONE_HARNESS_API_KEY"], ready: false, why: "Phone harness needs PHONE_HARNESS_API_KEY saved: save it in Settings → Computers", network: "the vendor's own network; this server's allow-list doesn't apply", shell: "none", host_tools: ["read", "write", "edit"], shell_note: SHELL_NOTES.none });
  assert.equal(kindOf(view, "sandbox").offered, true);
  // What this server's allow-list means for each provider, from its descriptor's network: none for Docker, which takes
  // the list; words for a computer with no network (Orgo's offered Linux desktop among them: its Windows one is parked),
  // and for one on the vendor's own.
  const networkOf = (kind, id) => providerOf(view, kind, id).network;
  assert.deepEqual(
    [networkOf("sandbox", "docker"), networkOf("sandbox", "daytona"), networkOf("sandbox", "modal"), networkOf("sandbox", "e2b"), networkOf("desktop", "orgo"), networkOf("browser", "kernel")],
    [undefined, "no network, so this server's allow-list isn't offered", "no network, so this server's allow-list isn't offered", "no network, so this server's allow-list isn't offered", "no network, so this server's allow-list isn't offered", "the vendor's own network; this server's allow-list doesn't apply"],
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
    assert.equal(provider.why, `${label} needs a network, and this server's AGENTRUN_BOX_ALLOW is none (no network): pick a computer that runs with no network, or set AGENTRUN_BOX_ALLOW to a host list`);
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

/** Why a Daytona sandbox is refused in Mode 2: it takes no Archil mount, and its descriptor says why. */
const DAYTONA_NO_DISK = "Daytona can't mount the owner's disk this server keeps run folders on (Archil mounts don't work on Daytona yet: Archil's client hangs on its sandboxes): set this agent's computer to a sandbox that mounts it, or none (Settings → Computers)";

test("Mode 2 today: Docker's sandbox can't mount the owner's disk, nor can Daytona's (saying why); Modal and E2B mount it from Archil, so the sandbox is offered, each waiting on its own key; a desktop, phone or browser is", async (t) => {
  const { routes } = await setup(t, { mode: "disk" });
  const view = await routes.view();
  assert.match(providerOf(view, "sandbox", "docker").why, /Docker can't mount the owner's disk/);
  assert.equal(providerOf(view, "sandbox", "daytona").why, DAYTONA_NO_DISK);
  for (const [id, needs] of [["modal", "Modal needs MODAL_TOKEN_ID and MODAL_TOKEN_SECRET saved: save them"], ["e2b", "E2B needs E2B_API_KEY saved: save it"]]) {
    assert.equal(providerOf(view, "sandbox", id).why, `${needs} in Settings → Computers`, `${id} mounts the owner's disk, so only its keys are missing`);
  }
  assert.equal(kindOf(view, "sandbox").offered, true);
  assert.equal(providerOf(view, "desktop", "docker").ready, true, "a desktop holds no folder unless its provider mounts it");
  assert.equal(kindOf(view, "phone").offered, true);
});

test("Mode 2 once the remote sandboxes mount the owner's disk: Docker's sandbox is refused, one that mounts the disk is offered", async (t) => {
  const { routes } = await setup(t, { mode: "disk", kinds: KINDS });
  const view = await routes.view();
  assert.match(providerOf(view, "sandbox", "docker").why, /Docker can't mount the owner's disk/);
  assert.equal(providerOf(view, "sandbox", "e2b").why, "E2B needs E2B_API_KEY saved: save it in Settings → Computers");
  assert.equal(kindOf(view, "sandbox").offered, true);
});

test("a kind no provider can serve here is not offered, and says why: in Mode 2 with Docker the only sandbox (it can't mount the owner's disk), and no phone provider", async (t) => {
  const { store } = await storeOn(t);
  // Docker for the sandbox, which can't mount the owner's disk, and Orgo, a desktop with no mounts: no phone provider.
  const kinds = { ...KINDS, PROVIDERS: KINDS.PROVIDERS.filter((one) => one.id === "docker" || one.id === "orgo") };
  const view = await createComputerRoutes({ store, sealKey: randomBytes(32), kinds, factories: fakeFactories().factories, tools, mode: "disk" }).view();
  assert.deepEqual([kindOf(view, "sandbox").offered, kindOf(view, "sandbox").why], [false, "no provider of a sandbox computer can reach this server's run folders"]);
  assert.deepEqual([kindOf(view, "phone").offered, kindOf(view, "phone").why, kindOf(view, "phone").providers], [false, "no provider serves a phone computer", []]);
});

test("a key save takes only the provider's declared names, seals each in the store, answers names and saved flags only, and null removes", async (t) => {
  const { store, sealKey, routes } = await setup(t);
  await assert.rejects(routes.saveKeys("browserbase", { BROWSERBASE_API_KEY: "good-a", OPENAI_API_KEY: "sk-x" }), (error) => error instanceof KeysRefused && error.fields.map((f) => [f.field, f.reason]).join() === "OPENAI_API_KEY,not_allowed");
  await assert.rejects(routes.saveKeys("browserbase", { BROWSERBASE_API_KEY: 7 }), (error) => error instanceof KeysRefused && error.fields[0].reason === "wrong_type");
  assert.deepEqual(await store.sealedKeys.all(), [], "nothing saved when any name is refused");
  const saved = await routes.saveKeys("browserbase", { BROWSERBASE_API_KEY: "good-b1", BROWSERBASE_PROJECT_ID: "good-proj" });
  assert.deepEqual(saved, { id: "browserbase", name: "Browserbase", metered: true, secrets: [{ name: "computer:browserbase:BROWSERBASE_API_KEY", set: true, source: "console", changed_at: CHANGED }, { name: "computer:browserbase:BROWSERBASE_PROJECT_ID", set: true, source: "console", changed_at: CHANGED }], required: ["computer:browserbase:BROWSERBASE_API_KEY", "computer:browserbase:BROWSERBASE_PROJECT_ID"], ready: true, network: "the vendor's own network; this server's allow-list doesn't apply", shell: "none", host_tools: ["read", "write", "edit"], shell_note: SHELL_NOTES.none }, "the shared secret shape: set, where from, when changed; never a value; and the shell a browser gives (none: it mounts no folder)");
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

test("the claim's options: computer_unavailable with the refusal's words, else the provider's create() options from its saved keys", async (t) => {
  const { routes } = await setup(t);
  assert.equal(await routes.claimOptions({ kind: "none" }), undefined);
  assert.deepEqual(await routes.claimOptions({ kind: "phone", provider: "phone-harness" }), { ok: false, error: { code: "computer_unavailable", message: "Phone harness needs PHONE_HARNESS_API_KEY saved: save it in Settings → Computers (PUT /v2/computers/phone-harness/keys)" } });
  await routes.saveKeys("phone-harness", { PHONE_HARNESS_API_KEY: "good-p" });
  assert.deepEqual(await routes.claimOptions({ kind: "phone", provider: "phone-harness" }), { ok: true, options: { apiKey: "good-p" } });
  assert.deepEqual(await routes.claimOptions({ kind: "sandbox", provider: "docker" }), { ok: true, options: {} });
  assert.equal((await routes.claimOptions({ kind: "sandbox", provider: "daytona" })).error.code, "computer_unavailable");
});

test("at the claim: a computer this server cannot give is refused in words that name the setting to fill", async (t) => {
  const { routes } = await setup(t);
  assert.equal(await routes.claimRefusal({ kind: "none" }), undefined);
  assert.equal(await routes.claimRefusal({ kind: "sandbox", provider: "docker" }), undefined);
  assert.match(await routes.claimRefusal({ kind: "sandbox", provider: "daytona" }), /can't mount this server's run folders.*Settings → Computers/);
  assert.equal(await routes.claimRefusal({ kind: "phone", provider: "phone-harness" }), "Phone harness needs PHONE_HARNESS_API_KEY saved: save it in Settings → Computers (PUT /v2/computers/phone-harness/keys)");
  assert.equal(await routes.claimRefusal({ kind: "browser", provider: "e2b" }), "E2B does not serve a browser computer (kind browser is a browser machine, not a linux one; kind browser needs groups cdp, which the provider does not declare; kind browser is a browser machine, not a desktop one): set this agent's computer to one it serves (Settings → Computers)", "servingRefusals' words");
  assert.match(await routes.claimRefusal({ kind: "desktop", provider: "nobody" }), /names the provider nobody, which this server does not have/);
  // ORGO_WORKSPACE_ID is picked, not required: unsaved, the provider uses the key's account's one workspace.
  assert.equal(await routes.claimRefusal({ kind: "desktop", provider: "orgo" }), "Orgo needs ORGO_API_KEY saved: save it in Settings → Computers (PUT /v2/computers/orgo/keys)");
  await routes.saveKeys("phone-harness", { PHONE_HARNESS_API_KEY: "good-p" });
  assert.equal(await routes.claimRefusal({ kind: "phone", provider: "phone-harness" }), undefined);
});

test("a provider whose host command is not on this machine's PATH is not ready, its key saved or not, and its claim is refused in words of what to install", async (t) => {
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
  assert.equal(await routes.claimRefusal({ kind: "phone", provider: "phone-harness" }), NO_ADB);
  await routes.saveKeys("phone-harness", { PHONE_HARNESS_API_KEY: "good-p" });
  assert.deepEqual([(await phoneView()).ready, (await phoneView()).why], [false, NO_ADB], "its key saved, still not ready");
  assert.equal(await routes.claimRefusal({ kind: "phone", provider: "phone-harness" }), NO_ADB);
  assert.equal(await routes.claimRefusal({ kind: "sandbox", provider: "docker" }), undefined, "another provider is not touched");
});

test("the folder mode is read at each call (folderModeOf): turning Archil on or off takes effect without building the routes again", async (t) => {
  const { store } = await storeOn(t);
  const routes = createComputerRoutes({ store, sealKey: randomBytes(32), kinds: KINDS, factories: fakeFactories().factories, tools, mode: folderModeOf(store) });
  const docker = async () => (await routes.view()).kinds.find((one) => one.kind === "sandbox").providers.find((one) => one.id === "docker");
  assert.equal((await docker()).ready, true, "Mode 1: Docker's sandbox");
  assert.equal(await routes.claimRefusal({ kind: "sandbox", provider: "docker" }), undefined);
  await saveArchilSettings(store, { diskId: "dsk-00000000000fake0", region: "aws-us-east-1", s3Url: "https://s3.archil.example" });
  assert.match((await docker()).why, /can't mount the owner's disk/, "Mode 2 at the next call");
  assert.match(await routes.claimRefusal({ kind: "sandbox", provider: "docker" }), /can't mount the owner's disk/);
  await clearArchilSettings(store);
  assert.equal((await docker()).ready, true, "Mode 1 again");
});

test("the folder mode reads the Archil settings in the server's environment too: Mode 2 with nothing saved", async (t) => {
  const { store } = await storeOn(t);
  const env = { AGENTRUN_ARCHIL_REGION: "aws-us-east-1", AGENTRUN_ARCHIL_S3_URL: "https://s3.archil.example" };
  assert.equal(await folderModeOf(store, env)(), "disk");
  assert.equal(await folderModeOf(store)(), "local", "the same store without it: Mode 1");
});

test("at the claim in Mode 2: Docker's sandbox is refused", async (t) => {
  const { routes } = await setup(t, { mode: "disk" });
  assert.match(await routes.claimRefusal({ kind: "sandbox", provider: "docker" }), /can't mount the owner's disk/);
  assert.equal(await routes.claimRefusal({ kind: "desktop", provider: "docker" }), undefined);
});

test("each choice says where its runs have their shell, the host tools that gives (the kernel registry's own list) and what it leaves out: no computer in each mode, a sandbox, and a desktop whose provider does not mount", async (t) => {
  const names = (shell) => hostToolDefs({ maxExecS: 600, shell }).map((def) => def.name);
  assert.deepEqual([names("none"), names("local"), names("computer")], [["read", "write", "edit"], ["read", "write", "edit", "bash"], ["read", "write", "edit", "bash", "bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"]]);
  const choice = (one) => ({ shell: one.shell, host_tools: one.host_tools, shell_note: one.shell_note });
  // Mode 1: the run folders are this server's own.
  const local = await (await setup(t)).routes.view();
  assert.deepEqual(choice(kindOf(local, "none")), { shell: "none", host_tools: names("none"), shell_note: "No computer on this server: the agent gets the file tools only, no shell. Pick a computer to run commands." });
  assert.deepEqual(choice(providerOf(local, "sandbox", "docker")), { shell: "computer", host_tools: names("computer"), shell_note: undefined });
  assert.deepEqual(choice(providerOf(local, "desktop", "e2b")), { shell: "none", host_tools: names("none"), shell_note: SHELL_NOTES.none }, "E2B's desktop does not bind this server's folder");
  assert.deepEqual(choice(providerOf(local, "desktop", "docker")), { shell: "computer", host_tools: names("computer"), shell_note: undefined }, "Docker's desktop binds it");
  // Mode 2: the run folders are on the owner's disk.
  const disk = await (await setup(t, { mode: "disk", kinds: KINDS })).routes.view();
  assert.deepEqual(choice(kindOf(disk, "none")), { shell: "local", host_tools: names("local"), shell_note: "No computer: bash runs in a fresh container on the folder's own storage; background commands need a computer." });
  assert.deepEqual(choice(providerOf(disk, "sandbox", "e2b")), { shell: "computer", host_tools: names("computer"), shell_note: undefined });
  assert.deepEqual(choice(providerOf(disk, "desktop", "orgo")), { shell: "local", host_tools: names("local"), shell_note: SHELL_NOTES.local }, "Orgo's desktop does not mount the disk");
  assert.deepEqual(choice(providerOf(disk, "desktop", "e2b")), { shell: "computer", host_tools: names("computer"), shell_note: undefined }, "E2B's desktop mounts it");
  for (const view of [local, disk]) {
    for (const kind of view.kinds) {
      for (const one of kind.kind === "none" ? [kind] : kind.providers) assert.deepEqual(one.host_tools, names(one.shell), `${kind.kind} ${one.id ?? ""}`);
    }
  }
});

/** The words a person reads when no Docker daemon answers here, over the fixture registry: a Mode 1 sandbox (its vendors
 *  need Archil first) and a desktop in either mode. */
const NO_DOCKER_SANDBOX = "No Docker on this server: Render and most hosted services run none. A vendor sandbox (Modal, E2B or Agent37) needs Archil turned on in Settings → Workspace.";
const NO_DOCKER_DESKTOP = "No Docker on this server: Render and most hosted services run none. Use a vendor computer, e.g. E2B, Agent37, Orgo or boxd for a desktop.";

test("no Docker daemon here: Docker is not ready, in words that name the vendors of each kind, and the claim refuses it in the same words", async (t) => {
  const asked = [];
  const answers = async (provider) => (asked.push(provider), { up: false, absent: true, reason: "docker version failed: exit 1" });
  const { store } = await storeOn(t);
  const routes = createComputerRoutes({ store, sealKey: randomBytes(32), kinds: KINDS, factories: fakeFactories().factories, tools, mode: "local", answers });
  const view = await routes.view();
  assert.deepEqual([providerOf(view, "sandbox", "docker").ready, providerOf(view, "sandbox", "docker").why], [false, NO_DOCKER_SANDBOX]);
  assert.deepEqual([providerOf(view, "desktop", "docker").ready, providerOf(view, "desktop", "docker").why], [false, NO_DOCKER_DESKTOP]);
  assert.deepEqual(asked, ["docker"], "one ask per view, for the one provider that binds a folder of this machine");
  assert.equal(await routes.claimRefusal({ kind: "sandbox", provider: "docker" }), NO_DOCKER_SANDBOX);
  assert.deepEqual(await routes.claimOptions({ kind: "desktop", provider: "docker" }), { ok: false, error: { code: "computer_unavailable", message: NO_DOCKER_DESKTOP } });
  // A daemon that is there but refuses this process says its own reason.
  const denied = createComputerRoutes({ store, sealKey: randomBytes(32), kinds: KINDS, factories: fakeFactories().factories, tools, mode: "local", answers: async () => ({ up: false, absent: false, reason: "This server's process isn't in the docker group" }) });
  assert.equal(providerOf(await denied.view(), "sandbox", "docker").why, "This server's process isn't in the docker group");
  // Mode 2: Docker's sandbox is refused for the mode first (it can't mount the owner's disk); its desktop says the words.
  const archil = createComputerRoutes({ store, sealKey: randomBytes(32), kinds: KINDS, factories: fakeFactories().factories, tools, mode: "disk", answers });
  const inDisk = await archil.view();
  assert.match(providerOf(inDisk, "sandbox", "docker").why, /can't mount the owner's disk/);
  assert.equal(providerOf(inDisk, "desktop", "docker").why, NO_DOCKER_DESKTOP);
  assert.equal(await archil.claimRefusal({ kind: "desktop", provider: "docker" }), NO_DOCKER_DESKTOP);
});

test("a Docker daemon that answers: Docker is ready, and the claim takes it", async (t) => {
  const { store } = await storeOn(t);
  const routes = createComputerRoutes({ store, sealKey: randomBytes(32), kinds: KINDS, factories: fakeFactories().factories, tools, mode: "local", answers: async () => ({ up: true }) });
  const view = await routes.view();
  assert.deepEqual(providerOf(view, "sandbox", "docker"), { id: "docker", name: "Docker", metered: false, secrets: [], required: [], ready: true, shell: "computer", host_tools: hostToolsOf("computer") });
  assert.equal(providerOf(view, "desktop", "docker").ready, true);
  assert.equal(await routes.claimRefusal({ kind: "sandbox", provider: "docker" }), undefined);
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
  // The claim's refusal, for a caller, still names the route that saves the keys.
  const routes = createComputerRoutes({ store, sealKey: randomBytes(32), kinds, factories: fakeFactories().factories, tools, mode: "local" });
  assert.equal(await routes.claimRefusal({ kind: "phone", provider: "phone-harness" }), "Phone harness needs PHONE_HARNESS_API_KEY saved: save it in Settings → Computers (PUT /v2/computers/phone-harness/keys)");
});

test("a sandbox provider's GPUs show on GET /v2/computers as its configuration declares them, with why a run here cannot have them; the claim holds a sandbox's gpu to them in checkGpu's words", async (t) => {
  const { routes } = await setup(t, { mode: "disk" });
  const view = await routes.view();
  const daytona = providerOf(view, "sandbox", "daytona").gpu;
  assert.deepEqual([daytona.types, daytona.max, daytona.preemptible, daytona.stopDeletes, daytona.region, daytona.perGpu, daytona.mounts], [["H100"], 1, true, true, "earth", { cpus: 16, memoryMb: 102400, diskMb: 409600 }, []]);
  // Mode 2 mounts the run's folder from Archil, which no GPU computer can yet: why, and what to use instead.
  // Each provider's own reason, from its descriptor; never a field of the view.
  const noFolder = (label) =>
    ({
      Daytona: "A Daytona GPU computer can't mount this run's folder: Daytona's GPU runtime gives it no /dev/fuse. Use a GPU computer from the library, or this sandbox without a GPU.",
      Modal: "A Modal GPU computer can't mount this run's folder yet: Archil's FUSE mount isn't proven on Modal's gVisor runtime (#2279). Use a GPU computer from the library, or this sandbox without a GPU.",
    })[label];
  assert.equal("unmounted" in daytona, false, "the reason is in why, not a field of its own");
  assert.equal(daytona.why, noFolder("Daytona"));
  const modal = providerOf(view, "sandbox", "modal").gpu;
  assert.deepEqual([modal.types.slice(0, 2), modal.isolation, modal.preemptible, modal.mounts], [["T4", "L4"], "gvisor", true, []]);
  assert.equal(modal.why, noFolder("Modal"));
  assert.equal(providerOf(view, "sandbox", "docker").gpu, undefined, "Docker declares no GPU");
  assert.equal(providerOf(view, "desktop", "e2b").gpu, undefined, "only a sandbox takes GPUs");

  await routes.saveKeys("daytona", { DAYTONA_API_KEY: "good-d" });
  await routes.saveKeys("modal", { MODAL_TOKEN_ID: "good-i", MODAL_TOKEN_SECRET: "good-s" });
  // A Daytona sandbox takes no Archil mount at all, so in Mode 2 it is refused for that first, GPUs or none.
  for (const gpu of [{ type: "H100", count: 1 }, { type: "T4", count: 1 }, { type: "H100", count: 2 }, undefined]) {
    assert.equal(await routes.claimRefusal({ kind: "sandbox", provider: "daytona", ...(gpu ? { gpu } : {}) }), DAYTONA_NO_DISK, JSON.stringify(gpu));
  }
  assert.equal(await routes.claimRefusal({ kind: "sandbox", provider: "modal", gpu: { type: "T4", count: 1 } }), `${noFolder("Modal")} (Settings → Computers)`);
  assert.equal(await routes.claimRefusal({ kind: "sandbox", provider: "modal" }), undefined, "a Modal sandbox with no GPU is as before");
  const local = (await setup(t)).routes;
  assert.match(await local.claimRefusal({ kind: "sandbox", provider: "docker", gpu: { type: "T4", count: 1 } }), /^Docker can't give this agent's computer its GPUs: this provider offers no GPU/);
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
