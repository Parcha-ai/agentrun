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
import { BrowserbaseProvider } from "../dist/browserbase.js";
import { E2BProvider } from "../dist/e2b.js";
import { KernelProvider } from "../dist/kernel.js";
import { BROWSERBASE_KEY, BROWSERBASE_URL, fakeBrowserbase, fakeKernel, KERNEL_KEY, KERNEL_URL } from "./fake-browser.mjs";
import { create as createOrgo } from "../dist/orgo.js";
import { fakeDocker } from "./fake-docker.mjs";
import { fakeE2B } from "./fake-e2b.mjs";
import { fakeModal } from "./fake-modal.mjs";
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
		desktop: { machineKinds: ["desktop"], required: ["screen", "input.pointer", "input.keys"], optional: ["exec", "files", "processes", "apps", "stream"] },
		phone: { machineKinds: ["android", "ios"], required: ["screen", "input.touch", "apps"], optional: ["input.keys", "apps.install", "apps.ui_tree", "stream"] },
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

test("PROVIDERS is the agreed table of ids, labels, key names, mounts and metering", () => {
	const rows = PROVIDERS.map(({ id, label, keys, metered }) => ({ id, label, keys, metered }));
	const key = (name, option, required = true) => ({ name, option, required });
	assert.deepEqual(rows, [
		{ id: "docker", label: "Docker", keys: [], metered: false },
		{ id: "daytona", label: "Daytona", keys: [key("DAYTONA_API_KEY", "apiKey"), key("DAYTONA_API_URL", "apiUrl", false), key("DAYTONA_TARGET", "target", false)], metered: true },
		{ id: "modal", label: "Modal", keys: [key("MODAL_TOKEN_ID", "tokenId"), key("MODAL_TOKEN_SECRET", "tokenSecret")], metered: true },
		{ id: "e2b", label: "E2B", keys: [key("E2B_API_KEY", "apiKey")], metered: true },
		{ id: "orgo", label: "Orgo", keys: [key("ORGO_API_KEY", "apiKey")], metered: true },
		{ id: "phone-harness", label: "Phone harness", keys: [key("PHONE_HARNESS_API_KEY", "apiKey")], metered: true },
		{ id: "browserbase", label: "Browserbase", keys: [key("BROWSERBASE_API_KEY", "apiKey"), key("BROWSERBASE_PROJECT_ID", "projectId")], metered: true },
		{ id: "kernel", label: "Kernel", keys: [key("KERNEL_API_KEY", "apiKey")], metered: true },
	]);
	// What is no key: Modal's app (default the server's own), Docker's image made before the first create on this host, and
	// the phone harness's ledger the server keeps.
	const extra = Object.fromEntries(PROVIDERS.map(({ id, settings, prepareImage, local, ledger }) => [id, { settings, prepareImage, local, ledger }]));
	assert.deepEqual(extra.modal.settings, [{ name: "modalApp", option: "app", default: "agentrun" }]);
	assert.deepEqual([extra.docker.prepareImage, extra.docker.local], [true, true]);
	assert.deepEqual(extra["phone-harness"].ledger, { option: "ledger" });
	for (const [id, fields] of Object.entries(extra)) {
		if (id !== "modal") assert.equal(fields.settings, undefined, id);
		if (id !== "docker") assert.deepEqual([fields.prepareImage, fields.local], [undefined, undefined], id);
		if (id !== "phone-harness") assert.equal(fields.ledger, undefined, id);
	}
	const kinds = Object.fromEntries(PROVIDERS.map((entry) => [entry.id, entry.kinds]));
	assert.deepEqual(kinds, { docker: ["sandbox", "desktop"], daytona: ["sandbox"], modal: ["sandbox"], e2b: ["sandbox", "desktop"], orgo: ["desktop"], "phone-harness": ["phone"], browserbase: ["browser"], kernel: ["browser"] });
	const mounts = Object.fromEntries(PROVIDERS.map((entry) => [entry.id, entry.mounts]));
	assert.deepEqual(mounts.docker, ["bind"]);
	for (const id of ["orgo", "phone-harness", "browserbase", "kernel"]) assert.deepEqual(mounts[id], [], id);
});

test("PROVIDERS' default images: each kind is one of the entry's own, and each value is its descriptor's constant", async () => {
	const all = await import("../dist/descriptors/index.js");
	const [daytona, modal, e2b, orgo, phone, browser] = [all, all, all, all, all, all];
	// The values serve uses when a computer setting names no image, each its descriptor's.
	const expected = {
		docker: undefined,
		daytona: { sandbox: daytona.DAYTONA_DEFAULT_SNAPSHOT },
		modal: { sandbox: modal.MODAL_DEFAULT_IMAGE },
		e2b: { sandbox: e2b.E2B_BASE_TEMPLATE, desktop: e2b.E2B_DESKTOP_TEMPLATE },
		orgo: { desktop: orgo.ORGO_BASE_IMAGE },
		"phone-harness": { phone: phone.PHONE_IMAGE },
		browserbase: { browser: browser.BROWSER_IMAGE },
		kernel: { browser: browser.BROWSER_IMAGE },
	};
	assert.deepEqual(PROVIDERS.map((entry) => entry.id).sort(), Object.keys(expected).sort(), "every provider is named here");
	for (const entry of PROVIDERS) {
		assert.deepEqual(entry.defaultImage, expected[entry.id], `${entry.id}: its default images are its modules' constants`);
		for (const kind of Object.keys(entry.defaultImage ?? {})) assert.ok(entry.kinds.includes(kind), `${entry.id}: a default image for ${kind}, which it serves`);
	}
	// What each module's constant is: a constant that drifts shows here.
	assert.deepEqual(
		[daytona.DAYTONA_DEFAULT_SNAPSHOT, modal.MODAL_DEFAULT_IMAGE, e2b.E2B_BASE_TEMPLATE, e2b.E2B_DESKTOP_TEMPLATE, orgo.ORGO_BASE_IMAGE, phone.PHONE_IMAGE, browser.BROWSER_IMAGE],
		["default", "debian:bookworm-slim", "base", "desktop", "linux", "android", "chromium"],
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

test("PROVIDERS is derived from the descriptors, and each provider module's MOUNT and CAPABILITIES are its descriptor's own", async () => {
	assert.deepEqual(PROVIDERS, DESCRIPTORS.map(entryOf), "every entry is its descriptor through entryOf");
	assert.deepEqual(PROVIDERS.map((entry) => entry.id), [...providerIds], "one entry per registry provider, in the descriptors' order");
	for (const descriptor of DESCRIPTORS) {
		const module = await providerModule(descriptor.id);
		assert.equal(module.CAPABILITIES, descriptor.capabilities, `${descriptor.id}: its module's CAPABILITIES are its descriptor's, not a copy`);
		assert.equal(module.MOUNT, descriptor.mounts, `${descriptor.id}: its module's MOUNT is its descriptor's mounts, not a copy`);
		assert.equal("load" in PROVIDERS.find((entry) => entry.id === descriptor.id), false, `${descriptor.id}: an entry is data, without load()`);
	}
});

test("a descriptor is checked when it is defined: its id, keys, settings and configurations, in words", () => {
	const good = { id: "acme-cloud", label: "Acme", keys: [{ name: "ACME_KEY", option: "apiKey", required: true }], metered: true, mounts: [], capabilities: [{ kind: "linux", groups: ["exec"] }], load: async () => ({}) };
	assert.equal(defineProvider(good), good);
	assert.deepEqual(descriptorProblems(good), []);
	for (const [change, words] of [
		[{ id: "Acme Cloud" }, /id "Acme Cloud" is not lowercase letters, digits and hyphens/],
		[{ label: " " }, /label is not a name in words/],
		[{ keys: [{ name: "ACME_KEY", option: "apiKey", required: true }, { name: "ACME_KEY", option: "other", required: false }] }, /keys names ACME_KEY or fills other twice/],
		[{ keys: [{ name: "ACME_KEY", option: "", required: true }] }, /each of keys has a name and the option it fills/],
		[{ keys: [{ name: "ACME_KEY", option: "apiKey" }] }, /each key says whether it is required/],
		[{ capabilities: [] }, /capabilities is not a list of one configuration or more/],
		[{ mounts: ["nfs"] }, /mounts is not a list of mount kinds/],
		[{ load: "./acme.js" }, /load is not a function/],
		[{ ledger: {} }, /ledger names the option it fills/],
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

/** Each provider built as the registry offers it, from the unit tests' fakes. */
const BUILT = {
	docker: [() => fakeDocker().provider, () => fakeDocker({ desktop: {} }).provider],
	e2b: [() => new E2BProvider({ apiKey: "fake-test-key", Sandbox: fakeE2B().Sandbox, kind: "linux" }), () => new E2BProvider({ apiKey: "fake-test-key", Sandbox: fakeE2B().Sandbox })],
	daytona: [() => new DaytonaProvider({ apiKey: "fake-test-key", apiUrl: "https://api.daytona.test/api", daemonPath: "/nonexistent/computerd", fetch: async () => new Response(null, { status: 500 }) })],
	modal: [() => new ModalProvider({ sdk: fakeModal().sdk, app: "computers", daemonImage: `ghcr.io/example/computerd@sha256:${"a".repeat(64)}` })],
	browserbase: [() => new BrowserbaseProvider({ apiKey: BROWSERBASE_KEY, apiUrl: BROWSERBASE_URL, fetch: fakeBrowserbase().fetch })],
	kernel: [() => new KernelProvider({ apiKey: KERNEL_KEY, apiUrl: KERNEL_URL, fetch: fakeKernel().fetch })],
	"phone-harness": [
		() => {
			const fake = fakePhoneHarness();
			return new PhoneHarnessProvider({ apiKey: PHONE_KEY, fetch: fake.fetch, adb: fake.adb });
		},
	],
	// Each configuration built by its own create() options, as serve builds the one a setting's image selects.
	orgo: PROVIDERS.find((one) => one.id === "orgo").capabilities.map(({ options }) => () => createOrgo({ ...options, apiKey: "fake-test-key", workspaceId: "ws-test", fetch: async () => new Response(null, { status: 500 }) })),
};

test("a built provider's capabilities, in each configuration, are its entry's static capabilities", () => {
	assert.deepEqual(Object.keys(BUILT).sort(), [...providerIds].sort(), "every registry provider is built here");
	for (const [id, builds] of Object.entries(BUILT)) {
		const entry = PROVIDERS.find((one) => one.id === id);
		const seen = builds.map((build) => {
			const { kind, groups } = build().capabilities();
			return { kind, groups };
		});
		assert.deepEqual(seen, entry.capabilities.map(({ kind, groups }) => ({ kind, groups })), `${id}: each configuration's kind and groups`);
	}
});
