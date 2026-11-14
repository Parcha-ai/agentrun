// The kind registry, to the agreed shape (SHAPE.md): the setting kind an agent is given (none, sandbox, desktop, phone,
// browser) as its machine kinds and capability groups, no tool names; the protocol's machine kinds with browser; the
// provider entries Settings reads (id, label, keys and their options, mounts, metered), derived from the providers'
// descriptors, with kinds derived by serves() from each provider's static capabilities; and the descriptor's own check.
// No vendor, no Docker.
import assert from "node:assert/strict";
import test from "node:test";
import { DaytonaProvider } from "../dist/daytona.js";
import { ModalProvider } from "../dist/modal.js";
import {
	CHROME_ENV,
	configurationOf,
	DESCRIPTORS,
	defineProvider,
	descriptorProblems,
	entryOf,
	GROUPS,
	imagesOf,
	KIND_SHAPES,
	kindOf,
	kindRefusals,
	PROVIDERS,
	providerIds,
	providerModule,
	SETTING_KINDS,
	serves,
	servingRefusals,
} from "../dist/index.js";
import { Agent37Provider } from "../dist/agent37.js";
import { keyPair } from "./fake-agent37.mjs";
import { BrowserbaseProvider } from "../dist/browserbase.js";
import { E2BProvider } from "../dist/e2b.js";
import { KernelProvider } from "../dist/kernel.js";
import { LocalBrowserProvider } from "../dist/local-chrome.js";
import { BROWSERBASE_KEY, BROWSERBASE_URL, fakeBrowserbase, fakeKernel, KERNEL_KEY, KERNEL_URL } from "./fake-browser.mjs";
import { create as createOrgo } from "../dist/orgo.js";
import { fakeDocker } from "./fake-docker.mjs";
import { PhoneHarnessProvider } from "../dist/phone-harness.js";
import { fakePhoneHarness, KEY as PHONE_KEY } from "./fake-phone-harness.mjs";

const caps = (fields) => ({ kind: "linux", groups: ["exec", "files", "processes"], ...fields });
const SETTINGS = ["none", "sandbox", "desktop", "phone", "browser"];

test("the protocol: browser is a machine kind (os linux, daemon none), and the groups gain cdp, stream and downloads", () => {
	assert.deepEqual(KIND_SHAPES.browser, { os: ["linux"], daemon: ["none"] });
	assert.deepEqual(kindRefusals({ kind: "browser", os: "linux", daemon: "none" }), []);
	assert.equal(kindRefusals({ kind: "browser", os: "linux", daemon: "pid1" }).length, 1);
	for (const group of ["cdp", "stream", "downloads"]) assert.ok(GROUPS.includes(group), group);
});

test("SETTING_KINDS is the agreed table: machine kinds, required and optional groups, and no tool names", () => {
	assert.deepEqual(SETTING_KINDS, {
		none: { machineKinds: [], required: [], optional: [] },
		sandbox: { machineKinds: ["linux"], required: ["exec", "files", "processes"], optional: [] },
		desktop: { machineKinds: ["desktop"], required: ["screen", "input.pointer", "input.keys"], optional: ["exec", "files", "processes", "apps", "ui", "stream"] },
		phone: { machineKinds: ["android", "ios"], required: ["screen", "input.touch", "apps"], optional: ["input.keys", "apps.install", "ui", "stream"] },
		browser: { machineKinds: ["browser"], required: ["cdp"], optional: ["stream", "downloads"] },
	});
	for (const kind of SETTINGS) {
		const { machineKinds, required, optional } = SETTING_KINDS[kind];
		for (const machine of machineKinds) assert.ok(Object.hasOwn(KIND_SHAPES, machine), `${kind}: ${machine} is a machine kind`);
		for (const group of [...required, ...optional]) assert.ok(GROUPS.includes(group), `${kind}: ${group} is a protocol group`);
		assert.deepEqual(required.filter((group) => optional.includes(group)), [], `${kind}: no group both required and optional`);
	}
});

test("serves() is the machine kind among the kind's and every required group declared; kindOf() is the kind served", () => {
	assert.equal(serves(caps({}), "sandbox"), true);
	assert.equal(serves(caps({ groups: ["exec", "files"] }), "sandbox"), false, "a provider that drops processes stops serving sandbox");
	assert.equal(serves(caps({ kind: "desktop", groups: ["screen", "input.pointer", "input.keys"] }), "desktop"), true, "a desktop needs no shell");
	assert.equal(serves(caps({ kind: "desktop", groups: ["exec", "files", "processes", "screen", "input.pointer", "input.keys"] }), "sandbox"), false, "only a linux machine serves sandbox");
	assert.equal(serves(caps({ kind: "desktop", groups: ["screen", "input.pointer"] }), "desktop"), false);
	assert.equal(serves(caps({ kind: "android", groups: ["screen", "input.touch", "apps"] }), "phone"), true);
	assert.equal(serves(caps({ kind: "ios", groups: ["screen", "input.touch"] }), "phone"), false);
	assert.equal(serves(caps({ kind: "browser", groups: ["cdp"] }), "browser"), true, "browser serves from its groups, cdp, like every kind");
	assert.equal(serves(caps({ kind: "browser", groups: ["stream"] }), "browser"), false);
	assert.equal(serves(caps({ kind: "browser", groups: [...GROUPS] }), "none"), false, "no machine serves none");
	assert.match(servingRefusals(caps({ groups: ["exec"] }), "sandbox").join("; "), /files, processes/);
	assert.match(servingRefusals(caps({}), "desktop").join("; "), /desktop/);
	assert.equal(kindOf(caps({})), "sandbox");
	assert.equal(kindOf(caps({ kind: "desktop", groups: ["screen", "input.pointer", "input.keys"] })), "desktop");
	assert.equal(kindOf(caps({ kind: "browser", groups: ["cdp", "downloads"] })), "browser");
	assert.equal(kindOf(caps({ groups: ["exec"] })), undefined);
});

test("PROVIDERS is one entry per descriptor, in the registry's order, with the descriptor's own ids, labels, key names, mounts and metering", () => {
	// Derived from DESCRIPTORS, so a new vendor's descriptor is its row here with no line to add.
	assert.deepEqual(PROVIDERS.map(({ id }) => id), DESCRIPTORS.map(({ id }) => id));
	assert.deepEqual(providerIds, DESCRIPTORS.map(({ id }) => id));
	assert.equal(new Set(providerIds).size, providerIds.length, "each id once");
	for (const [index, descriptor] of DESCRIPTORS.entries()) {
		const { id, label, keys, metered, mounts } = PROVIDERS[index];
		assert.deepEqual({ id, label, keys, metered, mounts }, { id: descriptor.id, label: descriptor.label, keys: descriptor.keys, metered: descriptor.metered, mounts: descriptor.mounts }, id);
		assert.ok(label.length > 0, `${id} has a label`);
		for (const key of keys) assert.match(key.name, /^[A-Z][A-Z0-9_]*$/, `${id}: ${key.name} is a setting's name`);
	}
	// The local providers ask for no key and are not metered; Orgo's workspace is picked from what the key can reach.
	for (const id of ["docker", "local-chrome"]) assert.deepEqual(PROVIDERS.filter((one) => one.id === id).map(({ keys, metered }) => [keys, metered]), [[[], false]], id);
	assert.deepEqual(PROVIDERS.find((one) => one.id === "orgo").keys.find((key) => key.name === "ORGO_WORKSPACE_ID"), { name: "ORGO_WORKSPACE_ID", option: "workspaceId", required: false, picked: true });
	// What is no key: Modal's app (default the server's own), Docker's image made before the first create on this host, and
	// the ledgers the server keeps: the phone harness's sessions, and Orgo's agents' computers.
	const extra = Object.fromEntries(PROVIDERS.map(({ id, settings, prepareImage, imageEnv, local, ledger, hostEnv, parked }) => [id, { settings, prepareImage, imageEnv, local, ledger, hostEnv, parked }]));
	assert.deepEqual(extra.modal.settings, [{ name: "modalApp", option: "app", default: "agentrun" }]);
	assert.deepEqual([extra.docker.prepareImage, extra.docker.local], [true, true]);
	// Daytona's image is the operator's snapshot when the server names one (an Archil mount needs box/Dockerfile's); no
	// other provider declares one.
	assert.deepEqual(Object.entries(extra).filter(([, one]) => one.imageEnv !== undefined).map(([id, one]) => [id, one.imageEnv]), [["daytona", "AGENTRUN_DAYTONA_SNAPSHOT"]]);
	assert.deepEqual(extra["phone-harness"].ledger, { option: "ledger" });
	assert.deepEqual(extra.orgo.ledger, { option: "ledger" });
	// Local Chrome reads where Chrome is from the server's own environment: the names its findChrome reads, then PATH.
	assert.deepEqual(extra["local-chrome"].hostEnv, [...CHROME_ENV, "PATH"]);
	// The cloud browsers read the gateway a server reaches them through.
	assert.deepEqual(extra.browserbase.hostEnv, ["BROWSERBASE_BASE_URL", "BROWSERBASE_CONNECT_BASE_URL"]);
	assert.deepEqual(extra.kernel.hostEnv, ["KERNEL_BASE_URL"]);
	// Orgo offers its Linux desktop; its Windows and macOS desktops are parked, each with why, and offered by no
	// configuration.
	assert.deepEqual(extra.orgo.parked.map((one) => one.image), ["windows", "macos"]);
	assert.ok(extra.orgo.parked.every((one) => /parked/.test(one.why)));
	assert.deepEqual(PROVIDERS.find((one) => one.id === "orgo").capabilities.map((one) => one.image), ["linux"]);
	for (const [id, fields] of Object.entries(extra)) {
		if (id !== "modal") assert.equal(fields.settings, undefined, id);
		if (id !== "docker") assert.deepEqual([fields.prepareImage, fields.local], [undefined, undefined], id);
		if (id !== "phone-harness" && id !== "orgo") assert.equal(fields.ledger, undefined, id);
		if (!["local-chrome", "browserbase", "kernel"].includes(id)) assert.equal(fields.hostEnv, undefined, id);
		if (id !== "orgo") assert.equal(fields.parked, undefined, id);
	}
	// Kinds are derived by serves() (the test below); every kind but none has a provider that serves it.
	for (const kind of SETTINGS.filter((kind) => kind !== "none")) {
		assert.ok(PROVIDERS.some((entry) => entry.kinds.includes(kind)), `some provider serves ${kind}`);
	}
	assert.deepEqual(PROVIDERS.find((entry) => entry.id === "docker").kinds, ["sandbox", "desktop"]);
	const mounts = Object.fromEntries(PROVIDERS.map((entry) => [entry.id, entry.mounts]));
	assert.deepEqual(mounts.docker, ["bind"]);
	for (const id of ["orgo", "phone-harness", "browserbase", "kernel", "local-chrome"]) assert.deepEqual(mounts[id], [], id);
});

test("PROVIDERS' default images: each kind is one of the entry's own, and each value is its descriptor's constant", async () => {
	const all = await import("../dist/descriptors/index.js");
	const [daytona, modal, e2b, orgo, phone, browser] = [all, all, all, all, all, all];
	// Every entry's default images are its descriptor's, each for a kind it serves.
	for (const [index, entry] of PROVIDERS.entries()) {
		assert.deepEqual(entry.defaultImage, DESCRIPTORS[index].defaultImage, entry.id);
		for (const [kind, image] of Object.entries(entry.defaultImage ?? {})) {
			assert.ok(entry.kinds.includes(kind), `${entry.id}: a default image for ${kind}, which it serves`);
			assert.ok(typeof image === "string" && image.length > 0, `${entry.id}: its ${kind} default image is a name`);
		}
	}
	// The values serve uses when a computer setting names no image are the descriptors' exported constants, for the built-in
	// providers that export them; a new provider is checked by the loop above alone.
	const expected = {
		docker: undefined,
		daytona: { sandbox: daytona.DAYTONA_DEFAULT_SNAPSHOT },
		modal: { sandbox: modal.MODAL_DEFAULT_IMAGE },
		e2b: { sandbox: e2b.E2B_BASE_TEMPLATE, desktop: e2b.E2B_DESKTOP_TEMPLATE },
		agent37: { sandbox: all.AGENT37_BASE_TEMPLATE, desktop: all.AGENT37_BOX_TEMPLATE },
		orgo: { desktop: orgo.ORGO_BASE_IMAGE },
		"phone-harness": { phone: phone.PHONE_IMAGE },
		browserbase: { browser: browser.BROWSER_IMAGE },
		kernel: { browser: browser.BROWSER_IMAGE },
		"local-chrome": { browser: browser.BROWSER_IMAGE },
	};
	for (const [id, images] of Object.entries(expected)) {
		assert.deepEqual(PROVIDERS.find((entry) => entry.id === id)?.defaultImage, images, `${id}: its default images are its modules' constants`);
	}
	// What each module's constant is: a constant that drifts shows here.
	assert.deepEqual(
		[daytona.DAYTONA_DEFAULT_SNAPSHOT, modal.MODAL_DEFAULT_IMAGE, e2b.E2B_BASE_TEMPLATE, e2b.E2B_DESKTOP_TEMPLATE, all.AGENT37_BASE_TEMPLATE, all.AGENT37_BOX_TEMPLATE, orgo.ORGO_BASE_IMAGE, phone.PHONE_IMAGE, browser.BROWSER_IMAGE],
		["default", "debian:bookworm-slim", "base", "desktop", "agent37-base", "agentrun-box", "linux", "android", "chromium"],
	);
	// Docker's sandbox has none: serve builds its own image (DOCKER_RECIPE).
	assert.equal(PROVIDERS.find((entry) => entry.id === "docker").defaultImage, undefined);
});

test("each entry's kinds are derived by serves() from its static capabilities, never written beside them", () => {
	for (const entry of PROVIDERS) {
		const derived = SETTINGS.filter((kind) => entry.capabilities.some((one) => serves(one, kind)));
		assert.deepEqual(entry.kinds, derived, entry.id);
		assert.ok(entry.kinds.length > 0, `${entry.id} serves some kind`);
	}
});

test("PROVIDERS is derived from the descriptors, and a provider module declares no mounts, capabilities or network beside its descriptor", async () => {
	assert.deepEqual(PROVIDERS, DESCRIPTORS.map(entryOf), "every entry is its descriptor through entryOf, its network included");
	assert.deepEqual(PROVIDERS.map((entry) => entry.id), [...providerIds], "one entry per registry provider, in the descriptors' order");
	for (const descriptor of DESCRIPTORS) {
		const module = await providerModule(descriptor.id);
		for (const copy of ["MOUNT", "CAPABILITIES", "NETWORK"]) assert.equal(copy in module, false, `${descriptor.id}: its ${copy} is its descriptor's alone`);
		assert.equal("load" in PROVIDERS.find((entry) => entry.id === descriptor.id), false, `${descriptor.id}: an entry is data, without load()`);
	}
});

test("the phone's descriptor names adb as the program its server needs, built for x86-64 Linux, macOS and x86-64 Windows; no other names one", () => {
	// Docker's daemon is the server's own daemon check, so Docker names none here.
	assert.deepEqual(PROVIDERS.filter((entry) => entry.hostCommand).map((entry) => [entry.id, entry.hostCommand]), [
		["phone-harness", { command: "adb", from: "Android platform-tools", builds: ["linux-x64", "darwin-x64", "darwin-arm64", "win32-x64"] }],
	]);
});

test("a descriptor is checked when it is defined: its id, keys, settings and configurations, in words", () => {
	const good = { id: "acme-cloud", label: "Acme", keys: [{ name: "ACME_KEY", option: "apiKey", required: true }], metered: true, mounts: [], network: ["none"], capabilities: [{ kind: "linux", groups: ["exec"] }], load: async () => ({}) };
	assert.equal(defineProvider(good), good);
	assert.deepEqual(descriptorProblems(good), []);
	assert.deepEqual(descriptorProblems({ ...good, unmounted: { archil: "Archil's client hangs here" } }), [], "a kind it doesn't take, with why");
	for (const [change, words] of [
		[{ id: "Acme Cloud" }, /id "Acme Cloud" is not lowercase letters, digits and hyphens/],
		[{ label: " " }, /label is not a name in words/],
		[{ keys: [{ name: "ACME_KEY", option: "apiKey", required: true }, { name: "ACME_KEY", option: "other", required: false }] }, /keys names ACME_KEY or fills other twice/],
		[{ keys: [{ name: "ACME_KEY", option: "", required: true }] }, /each of keys has a name and the option it fills/],
		[{ keys: [{ name: "ACME_KEY", option: "apiKey" }] }, /each key says whether it is required/],
		[{ capabilities: [] }, /capabilities is not a list of one configuration or more/],
		[{ mounts: ["nfs"] }, /mounts is not a list of mount kinds/],
		[{ unmounted: { nfs: "no NFS here" } }, /unmounted maps mount kinds \(bind, archil\) to why, in words/],
		[{ unmounted: { archil: " " } }, /unmounted maps mount kinds \(bind, archil\) to why, in words/],
		[{ unmounted: ["archil"] }, /unmounted maps mount kinds \(bind, archil\) to why, in words/],
		[{ mounts: ["archil"], unmounted: { archil: "it hangs" } }, /unmounted names a mount kind that mounts declares/],
		[{ network: [] }, /network is not a list of the network forms/],
		[{ network: ["vpn"] }, /network is not a list of the network forms/],
		[{ load: "./acme.js" }, /load is not a function/],
		[{ ledger: {} }, /ledger names the option it fills/],
		[{ imageEnv: "acme image" }, /imageEnv is an environment variable name/],
		[{ imageEnv: "" }, /imageEnv is an environment variable name/],
		[{ hostCommand: { command: "/usr/bin/adb", from: "Android platform-tools" } }, /hostCommand's command is a program's name, with no path/],
		[{ hostCommand: { command: "adb", from: " " } }, /hostCommand says in words what installs it/],
		[{ hostCommand: { command: "adb", from: "Android platform-tools", builds: ["linux x64"] } }, /hostCommand's builds are machines as Node names them/],
		[{ capabilities: [{ kind: "desktop", groups: [], image: " windows" }] }, /a configuration's image " windows" is not a name/],
		[{ capabilities: [{ kind: "desktop", groups: [], image: "windows" }, { kind: "desktop", groups: ["exec"], image: "windows" }] }, /two desktop configurations have the image windows/],
		[{ capabilities: [{ kind: "desktop", groups: [], image: "windows", options: "os=windows" }] }, /a configuration's options are an object/],
	]) {
		assert.throws(() => defineProvider({ ...good, ...change }), (error) => words.test(error.message), JSON.stringify(change));
	}
	assert.deepEqual(descriptorProblems(null), ["it is not an object"]);
});

test("a kind's images, and the configuration a setting selects: by its image; none named, the default's, else one with no image, else the first", () => {
	const linux = { kind: "desktop", groups: [], image: "linux", options: {} };
	const windows = { kind: "desktop", groups: [], image: "windows", options: { os: "windows" } };
	const plain = { kind: "desktop", groups: [] };
	assert.deepEqual(imagesOf([windows, linux], "linux"), ["linux", "windows"], "the default first");
	assert.deepEqual(imagesOf([windows, linux], undefined), ["windows", "linux"]);
	assert.deepEqual(imagesOf([plain], "e2b-desktop"), [], "no configuration names an image");
	assert.equal(configurationOf([linux, windows], "windows", "linux"), windows);
	assert.equal(configurationOf([linux, windows], "beos", "linux"), undefined);
	assert.equal(configurationOf([windows, linux], undefined, "linux"), linux, "the default's");
	assert.equal(configurationOf([windows, plain], undefined, "linux"), plain, "else one with no image");
	assert.equal(configurationOf([windows], undefined, undefined), windows, "else the first");
});

/** The E2B SDK's Sandbox slice, never called: these build a provider only to read what it declares. */
const E2B_SANDBOX = Object.fromEntries(["create", "connect", "getInfo", "setTimeout", "kill", "list"].map((name) => [name, () => assert.fail(`Sandbox.${name} was called`)]));
/** ssh2's Client slice for Agent37, never constructed here; and a fresh key, never used. */
const AGENT37_SSH2 = {
	Client: class {
		constructor() {
			assert.fail("ssh2's Client was constructed");
		}
	},
};
const FAKE_SSH_KEY = keyPair().private;

/** The Modal SDK's slice, never called: these build a provider only to read what it declares. */
const MODAL_SDK = {
	apps: { fromName: () => assert.fail("apps.fromName was called") },
	images: { fromRegistry: () => assert.fail("images.fromRegistry was called") },
	sandboxes: Object.fromEntries(["create", "fromId", "list"].map((name) => [name, () => assert.fail(`sandboxes.${name} was called`)])),
};

/** Each provider built as the registry offers it, from the unit tests' fakes. */
const BUILT = {
	docker: [() => fakeDocker().provider, () => fakeDocker({ desktop: {} }).provider],
	e2b: [() => new E2BProvider({ apiKey: "fake-test-key", Sandbox: E2B_SANDBOX, kind: "linux" }), () => new E2BProvider({ apiKey: "fake-test-key", Sandbox: E2B_SANDBOX })],
	// Each configuration built by its own create() options, as serve builds the one a setting selects.
	agent37: PROVIDERS.find((one) => one.id === "agent37").capabilities.map(({ options }) => () => new Agent37Provider({ ...options, apiKey: "fake-test-key", sshKey: FAKE_SSH_KEY, ssh2: AGENT37_SSH2, fetch: async () => new Response(null, { status: 500 }) })),
	daytona: [() => new DaytonaProvider({ apiKey: "fake-test-key", apiUrl: "https://api.daytona.test/api", daemonPath: "/nonexistent/computerd", fetch: async () => new Response(null, { status: 500 }) })],
	modal: [() => new ModalProvider({ sdk: MODAL_SDK, app: "computers" })],
	browserbase: [() => new BrowserbaseProvider({ apiKey: BROWSERBASE_KEY, apiUrl: BROWSERBASE_URL, fetch: fakeBrowserbase().fetch })],
	kernel: [() => new KernelProvider({ apiKey: KERNEL_KEY, apiUrl: KERNEL_URL, fetch: fakeKernel().fetch })],
	"local-chrome": [() => new LocalBrowserProvider({ executablePath: "/nonexistent/chrome" })],
	"phone-harness": [
		() => {
			const fake = fakePhoneHarness();
			return new PhoneHarnessProvider({ apiKey: PHONE_KEY, fetch: fake.fetch, adb: fake.adb });
		},
	],
	// Each configuration built by its own create() options, as serve builds the one a setting's image selects.
	orgo: PROVIDERS.find((one) => one.id === "orgo").capabilities.map(({ options }) => () => createOrgo({ ...options, apiKey: "fake-test-key", workspaceId: "ws-test", fetch: async () => new Response(null, { status: 500 }) })),
};

test("a built provider's capabilities, in each configuration, are its entry's static capabilities, and its network forms its entry's", () => {
	// The built-in providers' unit fakes, the one per-vendor table here: fakes are test code, not descriptor data. A provider
	// with none here is held to its declared kinds and groups by conformance's health.declared, which every vendor runs.
	for (const id of Object.keys(BUILT)) assert.ok(providerIds.includes(id), `${id} is a registry provider`);
	for (const [id, builds] of Object.entries(BUILT)) {
		const entry = PROVIDERS.find((one) => one.id === id);
		const built = builds.map((build) => build().capabilities());
		// Each configuration's kind, groups, GPUs and persistence are its entry's (an image and create() options are the
		// descriptor's alone): Settings offers a persistent computer only where the built provider keeps one.
		const shape = ({ kind, groups, gpu, persistence }) => ({ kind, groups, ...(gpu === undefined ? {} : { gpu }), ...(persistence === undefined ? {} : { persistence }) });
		assert.deepEqual(built.map(shape), entry.capabilities.map(shape), `${id}: each configuration's kind, groups, GPUs and persistence`);
		// Each configuration's network is among its entry's, and together they are all of it (Orgo: Linux none, Windows open).
		for (const { network } of built) assert.ok(network.every((form) => entry.network.includes(form)), `${id}: ${network} is among ${entry.network}`);
		assert.deepEqual([...new Set(built.flatMap(({ network }) => network))].sort(), [...entry.network].sort(), `${id}: its configurations make every form its entry declares`);
	}
});
