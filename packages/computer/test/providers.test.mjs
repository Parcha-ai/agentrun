// The provider registry (src/providers.ts) pins the rule that a new computer is one provider file and one registry line:
// every provider file has its line, every line resolves to a module of the registry's shape, the conformance CLI
// resolves every id through the registry and names each in its usage, and loading the registry loads no provider. A
// provider builds itself from COMPUTER_<ID>_* variables alone (fromEnv), so serve needs no edit for a new computer.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { main } from "../dist/conformance/cli.js";
import * as index from "../dist/index.js";
import { providerFromEnv, providerIds, providerModule, providers } from "../dist/providers.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = new URL("../src/", import.meta.url);
/** The registry's ids as an unknown id's refusal lists them: "docker, modal, ...", in registry order. */
const KNOWN = new RegExp(providerIds.join(", "));
const dir = mkdtempSync(join(tmpdir(), "computer-registry-"));
const DAEMON = join(dir, "computerd");
writeFileSync(DAEMON, "a stand-in for computerd\n");
after(() => rmSync(dir, { recursive: true, force: true }));

const sink = () => {
	let text = "";
	return {
		write: (chunk, done) => {
			text += chunk;
			done?.();
			return true;
		},
		text: () => text,
	};
};

/** Every registry line as written: id, and the provider file it imports. */
function registryLines() {
	const source = readFileSync(new URL("../dist/providers.js", import.meta.url), "utf8");
	return [...source.matchAll(/^\s*([a-z][a-z0-9-]*):\s*\(\)\s*=>\s*import\("\.\/([a-z][a-z0-9-]*)\.js"\),?$/gm)].map(([, id, file]) => ({ id, file }));
}

/** Every provider file under src/: one that declares a class implementing ComputerProvider, with the id it reports. */
function providerFiles() {
	const found = [];
	for (const name of readdirSync(SRC)) {
		if (!name.endsWith(".ts")) continue;
		const source = readFileSync(new URL(name, SRC), "utf8");
		if (!/\bclass\s+\w+\s+implements\s+ComputerProvider\b/.test(source)) continue;
		const id = /\breadonly id = "([^"]+)"/.exec(source)?.[1];
		found.push({ file: name.replace(/\.ts$/, ""), id });
	}
	return found;
}

test("the registry is one line per computer, one per provider file, each a lazy import of that file", () => {
	// The provider files decide the ids, not a list here: a new provider is its file and its registry line, nothing else.
	assert.deepEqual([...providerIds].sort(), providerFiles().map((f) => f.id).sort(), "one registry id per provider file, under the id it reports");
	assert.deepEqual(Object.keys(providers), providerIds);
	for (const id of providerIds) assert.equal(typeof providers[id], "function", `${id} is () => import(...)`);
	assert.deepEqual(registryLines(), providerIds.map((id) => ({ id, file: id })), "each line is id: () => import(\"./<file>.js\")");
});

test("loading the registry loads no provider and no vendor SDK: it imports nothing at load", () => {
	const source = readFileSync(new URL("../dist/providers.js", import.meta.url), "utf8");
	assert.doesNotMatch(source, /^\s*import\s[^(]/m, "no static import");
	assert.doesNotMatch(source, /^\s*export\s[^\n]*\sfrom\s/m, "no re-export");
});

test("every provider file under src/ has its registry line, under the id its provider reports", () => {
	const files = providerFiles();
	assert.ok(files.length >= 3, `found ${files.map((f) => f.file).join(", ")}`);
	const lines = registryLines();
	for (const { file, id } of files) {
		assert.ok(id, `${file}.ts declares its provider's id as readonly id = "..."`);
		assert.deepEqual(lines.find((line) => line.file === file), { id, file }, `src/${file}.ts implements ComputerProvider: the registry needs the line ${id}: () => import("./${file}.js")`);
	}
	assert.equal(lines.length, files.length, "and no line names a file that is not a provider");
});

test("every id resolves to a module of the registry's shape: ENV of COMPUTER_<ID>_ names only, fromEnv(), and an optional conformance module", async () => {
	for (const id of providerIds) {
		const module = await providerModule(id);
		assert.equal(typeof module.fromEnv, "function", `${id} exports fromEnv()`);
		assert.ok(module.ENV !== null && typeof module.ENV === "object", `${id} exports ENV`);
		const names = Object.values(module.ENV);
		assert.ok(names.length > 0, `${id}'s ENV names what fromEnv reads`);
		const prefix = `COMPUTER_${id.toUpperCase().replace(/-/g, "_")}_`;
		for (const name of names) assert.match(name, new RegExp(`^${prefix}[A-Z0-9_]+$`), `${id} reads ${name}: every name is ${prefix}*, never a vendor's bare variable`);
		if (module.conformance !== undefined) {
			assert.equal(typeof module.conformance, "function", `${id}'s conformance is () => import(...)`);
			const conformance = await module.conformance();
			assert.equal(typeof conformance.createProvider, "function", `${id}'s conformance module exports createProvider()`);
		}
	}
});

test("providerFromEnv() names the known ids for an id it does not know", async () => {
	for (const id of ["nope", "constructor", "__proto__", "toString", ""]) {
		await assert.rejects(providerFromEnv(id, {}), (error) => {
			assert.match(error.message, new RegExp(`unknown computer provider ${JSON.stringify(id).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
			assert.match(error.message, KNOWN);
			return true;
		});
	}
	await assert.rejects(providerModule("nope"), KNOWN);
});

test("providerFromEnv() reads COMPUTER_<VENDOR>_* only: a bare vendor variable is never a fallback", async () => {
	await assert.rejects(providerFromEnv("daytona", { DAYTONA_API_KEY: "fake-test-key" }), (error) => {
		assert.match(error.message, /COMPUTER_DAYTONA_API_KEY/);
		assert.doesNotMatch(error.message, /fake-test-key/);
		return true;
	});
	await assert.rejects(providerFromEnv("modal", { MODAL_TOKEN_ID: "prod-id-must-not-be-used", MODAL_TOKEN_SECRET: "prod-token-must-not-be-used", COMPUTER_MODAL_APP: "computers" }), (error) => {
		assert.match(error.message, /COMPUTER_MODAL_TOKEN_ID and COMPUTER_MODAL_TOKEN_SECRET/);
		assert.doesNotMatch(error.message, /prod-(id|token)-must-not-be-used/);
		return true;
	});
	const docker = await providerFromEnv("docker", { COMPUTER_DOCKER_DAEMON: DAEMON });
	assert.equal(docker.id, "docker");
});

test("the package's index exports the registry, so serve resolves a provider without naming a vendor", () => {
	assert.equal(index.providers, providers);
	assert.equal(index.providerFromEnv, providerFromEnv);
	assert.deepEqual(index.providerIds, providerIds);
});

test("Docker's fromEnv takes the daemon from COMPUTER_DOCKER_DAEMON without asking Docker, and refuses a root COMPUTER_DOCKER_USER", async () => {
	const docker = await import("../dist/docker.js");
	assert.deepEqual(docker.ENV, { daemon: "COMPUTER_DOCKER_DAEMON", user: "COMPUTER_DOCKER_USER" });
	const provider = await docker.fromEnv({ COMPUTER_DOCKER_DAEMON: DAEMON }, { docker: join(dir, "no-such-docker") });
	assert.equal(provider.id, "docker", "built without running the docker CLI, which does not exist");
	await assert.rejects(docker.fromEnv({ COMPUTER_DOCKER_DAEMON: DAEMON, COMPUTER_DOCKER_USER: "0:0" }), /root/);
});

test("Docker's fromEnv without COMPUTER_DOCKER_DAEMON picks this package's daemon for Docker's architecture, and says when it is not built", async () => {
	const docker = await import("../dist/docker.js");
	const cli = join(dir, "docker-riscv64");
	writeFileSync(cli, "#!/bin/sh\necho riscv64\n");
	chmodSync(cli, 0o755);
	await assert.rejects(docker.fromEnv({}, { docker: cli }), (error) => {
		assert.match(error.message, /no daemon for Docker's riscv64 at \S*computerd-linux-riscv64/);
		assert.match(error.message, /npm run build:daemon/);
		return true;
	});
	await assert.rejects(docker.fromEnv({}, { docker: join(dir, "no-such-docker") }), /cannot ask Docker its architecture/);
});

test("the conformance CLI's usage names every registry id, and an unknown id is a usage error that lists them", async () => {
	const out = sink();
	assert.equal(await main(["--help"], { stdout: out }), 0);
	const usage = out.text();
	for (const id of providerIds) assert.match(usage, new RegExp(`\\b${id}\\b`), `the usage names ${id}`);
	const err = sink();
	assert.equal(await main(["--provider", "nope"], { stdout: sink(), stderr: err, cwd: HERE }), 2);
	assert.match(err.text(), /unknown computer provider "nope"/);
	assert.match(err.text(), KNOWN);
	assert.match(err.text(), /usage: npm run conformance/);
});

test("the conformance CLI names no vendor: no registry id is a literal in its source, so a new computer needs no CLI edit", () => {
	const source = readFileSync(new URL("../dist/conformance/cli.js", import.meta.url), "utf8");
	for (const id of providerIds) assert.doesNotMatch(source, new RegExp(`["'\`]${id}["'\`]`), `cli.js special-cases ${id}`);
	assert.doesNotMatch(source, /conformance\/(docker|modal|daytona)|\.\/(docker|modal|daytona)\.js/, "and imports no vendor's module");
});

test("a provider file by path runs before its registry line exists: the CLI takes a module that exports fromEnv() as it takes a registry entry", async () => {
	const out = sink();
	const err = sink();
	const cases = [{ id: "health.ping", level: "core", group: "health", needs: [], run: async () => {} }];
	const code = await main(["--provider", "./fixtures/env-provider.mjs", "--json"], { stdout: out, stderr: err, cwd: HERE, cases });
	assert.equal(code, 0, err.text());
	assert.equal(JSON.parse(out.text()).provider, "env-module");
});
