// The kind registry, to the agreed shape (SHAPE.md): the setting kind an agent is given (none, sandbox, desktop, phone,
// browser) as its machine kinds and capability groups, no tool names; the protocol's machine kinds with browser; the
// provider entries Settings reads (id, label, key names, mounts, metered) with kinds derived by serves() from each
// provider's static capabilities; and entries for providers whose file lands later, held to it once it does.
// No vendor, no Docker.
import assert from "node:assert/strict";
import test from "node:test";
import {
	DaytonaProvider,
	GROUPS,
	KIND_SHAPES,
	kindOf,
	kindRefusals,
	ModalProvider,
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
	assert.deepEqual(rows, [
		{ id: "docker", label: "Docker", keys: [], metered: false },
		{ id: "daytona", label: "Daytona", keys: [{ name: "DAYTONA_API_KEY", required: true }, { name: "DAYTONA_API_URL", required: false }, { name: "DAYTONA_TARGET", required: false }], metered: true },
		{ id: "modal", label: "Modal", keys: [{ name: "MODAL_TOKEN_ID", required: true }, { name: "MODAL_TOKEN_SECRET", required: true }], metered: true },
		{ id: "e2b", label: "E2B", keys: [{ name: "E2B_API_KEY", required: true }], metered: true },
		{ id: "orgo", label: "Orgo", keys: [{ name: "ORGO_API_KEY", required: true }], metered: true },
		{ id: "phone-harness", label: "Phone harness", keys: [{ name: "PHONE_HARNESS_API_KEY", required: true }], metered: true },
		{ id: "browserbase", label: "Browserbase", keys: [{ name: "BROWSERBASE_API_KEY", required: true }, { name: "BROWSERBASE_PROJECT_ID", required: true }], metered: true },
		{ id: "kernel", label: "Kernel", keys: [{ name: "KERNEL_API_KEY", required: true }], metered: true },
	]);
	const kinds = Object.fromEntries(PROVIDERS.map((entry) => [entry.id, entry.kinds]));
	assert.deepEqual(kinds, { docker: ["sandbox", "desktop"], daytona: ["sandbox"], modal: ["sandbox"], e2b: ["sandbox", "desktop"], orgo: ["desktop"], "phone-harness": ["phone"], browserbase: ["browser"], kernel: ["browser"] });
	const mounts = Object.fromEntries(PROVIDERS.map((entry) => [entry.id, entry.mounts]));
	assert.deepEqual(mounts.docker, ["bind"]);
	for (const id of ["orgo", "phone-harness", "browserbase", "kernel"]) assert.deepEqual(mounts[id], [], id);
});

test("PROVIDERS' default images: each kind is one of the entry's own, and each value is its module's constant", async () => {
	const [daytona, modal, e2b, orgo, phone, browser] = await Promise.all(
		["daytona", "modal", "e2b", "orgo", "phone-harness", "browser"].map((name) => import(`../dist/${name}.js`)),
	);
	// The values serve uses when a computer setting names no image, each from the module that owns it.
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

test("every registry provider has an entry, and its module's static capabilities and mounts are the entry's", async () => {
	for (const id of providerIds) {
		const entry = PROVIDERS.find((one) => one.id === id);
		assert.ok(entry, `${id} has a PROVIDERS entry`);
		const module = await providerModule(id);
		assert.deepEqual(module.CAPABILITIES, entry.capabilities, `${id}: its module's CAPABILITIES are its entry's`);
		assert.deepEqual(module.MOUNT, entry.mounts, `${id}: its module's MOUNT is its entry's mounts`);
	}
});

test("an entry whose provider file has not landed is data alone; once it lands, the test above holds it to its file", () => {
	const pending = PROVIDERS.filter((entry) => !providerIds.includes(entry.id)).map((entry) => entry.id);
	assert.deepEqual(pending, [], "every entry's provider file has landed: none is data alone");
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
	orgo: [() => createOrgo({ apiKey: "fake-test-key", workspaceId: "ws-test", fetch: async () => new Response(null, { status: 500 }) })],
};

test("a built provider's capabilities, in each configuration, are its entry's static capabilities", () => {
	assert.deepEqual(Object.keys(BUILT).sort(), [...providerIds].sort(), "every registry provider is built here");
	for (const [id, builds] of Object.entries(BUILT)) {
		const entry = PROVIDERS.find((one) => one.id === id);
		const seen = builds.map((build) => {
			const { kind, groups, gpu } = build().capabilities();
			return { kind, groups, ...(gpu === undefined ? {} : { gpu }) };
		});
		assert.deepEqual(seen, entry.capabilities, `${id}: each configuration's kind, groups and GPUs`);
	}
});
