// The kind registry: the computer an agent is given (none, sandbox, desktop, phone, browser) as data the serve side reads,
// each kind's required and optional capability groups and the tools a loop gets for it, the provider ids that offer it,
// and serves()/kindOf() computed from a provider's capabilities, never from a list beside them. No vendor, no Docker.
import assert from "node:assert/strict";
import test from "node:test";
import { GROUPS, KIND_PROVIDERS, KIND_SPECS, KINDS, kindOf, providerIds, serves, toolsFor } from "../dist/index.js";

/** Capabilities as a provider declares them, with only what serves() and kindOf() read changed per case. */
const caps = (fields) => ({ kind: "linux", lifetime: "vendor", network: ["none"], isolation: "container", os: "linux", daemon: "pid1", groups: ["exec", "files", "processes"], maxLifetimeMs: 3_600_000, release: ["delete"], ...fields });
const SANDBOX = ["exec", "files", "processes"];
const DESKTOP = [...SANDBOX, "screen", "input.pointer", "input.keys"];
const PHONE = ["screen", "input.touch", "apps"];

test("the kinds are none, sandbox, desktop, phone and browser, each with its spec", () => {
	assert.deepEqual(KINDS, ["none", "sandbox", "desktop", "phone", "browser"]);
	assert.deepEqual(Object.keys(KIND_SPECS), KINDS);
	for (const kind of KINDS) assert.equal(KIND_SPECS[kind].kind, kind);
});

test("each kind's required and optional groups are the protocol's own, and never both", () => {
	assert.deepEqual(KIND_SPECS.none.required, []);
	assert.deepEqual(KIND_SPECS.sandbox.required, SANDBOX);
	assert.deepEqual(KIND_SPECS.desktop.required, DESKTOP, "desktop is sandbox's groups plus a screen, a pointer and keys");
	assert.deepEqual(KIND_SPECS.phone.required, PHONE);
	assert.deepEqual(KIND_SPECS.phone.optional, ["input.keys", "apps.ui_tree", "apps.install"]);
	assert.deepEqual(KIND_SPECS.browser.required, [], "a browser answers CDP, no computerd group");
	assert.equal(KIND_SPECS.browser.plane, "cdp");
	assert.equal(KIND_SPECS.sandbox.plane, "computerd");
	assert.equal(KIND_SPECS.none.plane, "none");
	for (const kind of KINDS) {
		const { required, optional } = KIND_SPECS[kind];
		for (const group of [...required, ...optional]) assert.ok(GROUPS.includes(group), `${kind}: ${group} is a protocol group`);
		assert.deepEqual(required.filter((group) => optional.includes(group)), [], `${kind}: no group both required and optional`);
	}
});

test("each kind's tools need only its groups; a desktop gets every sandbox tool; none gets none", () => {
	const names = (kind) => KIND_SPECS[kind].tools.map((tool) => tool.name);
	assert.deepEqual(names("none"), []);
	assert.deepEqual(names("sandbox"), ["bash", "read", "write", "edit", "bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"]);
	for (const name of names("sandbox")) assert.ok(names("desktop").includes(name), `desktop has ${name}`);
	assert.ok(names("desktop").includes("screen_shot") && names("desktop").includes("desktop_input"));
	assert.ok(names("phone").includes("screen_shot") && names("phone").includes("touch") && names("phone").includes("apps"));
	assert.ok(!names("phone").includes("bash"), "a phone has no shell tool");
	for (const kind of KINDS) {
		const allowed = [...KIND_SPECS[kind].required, ...KIND_SPECS[kind].optional];
		assert.equal(new Set(names(kind)).size, names(kind).length, `${kind}: tool names are unique`);
		for (const tool of KIND_SPECS[kind].tools) for (const group of tool.groups) assert.ok(allowed.includes(group), `${kind}: ${tool.name} needs ${group}, which the kind neither requires nor allows`);
	}
});

test("serves() is computed from the capabilities: every required group declared, and the protocol kind the kind allows", () => {
	assert.equal(serves(caps({}), "sandbox"), true);
	assert.equal(serves(caps({ groups: ["exec", "files"] }), "sandbox"), false, "a provider that drops processes stops serving sandbox");
	assert.equal(serves(caps({ kind: "desktop", groups: DESKTOP }), "desktop"), true);
	assert.equal(serves(caps({ kind: "desktop", groups: DESKTOP }), "sandbox"), true, "a desktop is a sandbox with a screen");
	assert.equal(serves(caps({ kind: "desktop", groups: DESKTOP.filter((group) => group !== "input.keys") }), "desktop"), false);
	assert.equal(serves(caps({}), "desktop"), false);
	assert.equal(serves(caps({ kind: "android", os: "android", daemon: "none", groups: PHONE }), "phone"), true);
	assert.equal(serves(caps({ kind: "android", os: "android", daemon: "none", groups: ["screen", "input.touch"] }), "phone"), false, "a phone without apps does not serve phone");
	assert.equal(serves(caps({ kind: "desktop", groups: [...DESKTOP, "input.touch", "apps"] }), "phone"), false, "only an android or ios computer serves phone");
	assert.equal(serves(caps({}), "browser"), false, "no provider declares a CDP plane yet");
	assert.equal(serves(caps({}), "none"), false, "none is no computer: no provider serves it");
});

test("kindOf() is the richest kind the capabilities serve, or undefined", () => {
	assert.equal(kindOf(caps({})), "sandbox");
	assert.equal(kindOf(caps({ kind: "desktop", groups: DESKTOP })), "desktop");
	assert.equal(kindOf(caps({ kind: "ios", os: "ios", daemon: "none", groups: [...PHONE, "apps.ui_tree"] })), "phone");
	assert.equal(kindOf(caps({ kind: "desktop", groups: ["screen", "input.pointer", "input.keys"], daemon: "none" })), undefined, "a screen with no shell serves no kind yet");
	assert.equal(kindOf(caps({ groups: ["exec"] })), undefined);
});

test("toolsFor() gives a kind's tools whose groups the capabilities declare, and nothing for a kind they do not serve", () => {
	const phone = caps({ kind: "android", os: "android", daemon: "none", groups: PHONE });
	assert.ok(!toolsFor("phone", phone).some((tool) => tool.name === "ui_tree"), "an optional tool needs its group declared");
	assert.ok(toolsFor("phone", caps({ ...phone, groups: [...PHONE, "apps.ui_tree"] })).some((tool) => tool.name === "ui_tree"));
	assert.deepEqual(toolsFor("desktop", caps({})), [], "a sandbox is given no desktop tools");
	assert.deepEqual(toolsFor("sandbox", caps({})).map((tool) => tool.name), KIND_SPECS.sandbox.tools.map((tool) => tool.name));
});

test("the registry names, per kind, provider ids the registry holds; sandbox is every one of today's", () => {
	assert.deepEqual(Object.keys(KIND_PROVIDERS), KINDS);
	assert.deepEqual([...KIND_PROVIDERS.sandbox].sort(), ["daytona", "docker", "e2b", "modal"]);
	assert.deepEqual([...KIND_PROVIDERS.desktop].sort(), ["docker", "e2b"], "the Docker and E2B desktops declare screen and input today");
	assert.deepEqual(KIND_PROVIDERS.none, []);
	for (const kind of KINDS) for (const id of KIND_PROVIDERS[kind]) assert.ok(providerIds.includes(id), `${kind}: ${id} is a registry id`);
});
