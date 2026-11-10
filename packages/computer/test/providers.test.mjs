// The provider registry (src/providers.ts) pins the rule that a new computer is one provider file and its descriptor:
// every provider file has its descriptor, the registry is derived from them, every id resolves to a module of the
// registry's shape, the conformance CLI resolves every id through the registry and names each in its usage, and loading
// the registry loads descriptors alone, no provider. A
// provider is built from its options alone (create(options)), its key included: the library reads no environment, so
// serve passes its own settings in. Only src/conformance/ (the CLI, its modules and the sweeps) reads COMPUTER_* names,
// and scripts/check-env.mjs pins that, read by TypeScript's parser.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { main } from "../dist/conformance/cli.js";
import * as index from "../dist/index.js";
import * as registry from "../dist/providers.js";

const { providerFor, providerIds, providerModule, providers } = registry;

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

/** The provider file a built descriptor module's load() imports: the one `import("../<file>.js")` in it. */
function loadedFile(id) {
	const source = readFileSync(new URL(`../dist/descriptors/${id}.js`, import.meta.url), "utf8");
	const imports = [...source.matchAll(/\bimport\("\.\.\/([a-z][a-z0-9-]*)\.js"\)/g)].map(([, file]) => file);
	assert.equal(imports.length, 1, `descriptors/${id}.js imports one provider module, lazily`);
	return imports[0];
}

/** Every static import of a built module, by specifier. */
function staticImports(path) {
	return [...readFileSync(new URL(path, import.meta.url), "utf8").matchAll(/^\s*(?:import|export)\s[^;(]*?\sfrom\s+"([^"]+)"/gm)].map(([, from]) => from);
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

/**
 * The provider files by id: a provider's module, and the files of its other configurations, which its module imports
 * (Orgo's Windows and macOS desktops, orgo-desktop.ts, beside its Linux one): one module per id, the one its descriptor loads.
 */
function providerModules() {
	const byId = new Map();
	for (const one of providerFiles()) byId.set(one.id, [...(byId.get(one.id) ?? []), one.file]);
	return [...byId].map(([id, files]) => ({ id, files }));
}

test("the registry is derived from the descriptors: one per provider file, each a lazy import of that file", () => {
	// The provider files decide the ids, not a list here: a new provider is its file and its descriptor, nothing else.
	assert.deepEqual([...providerIds].sort(), providerModules().map((f) => f.id).sort(), "one registry id per provider, under the id it reports");
	assert.deepEqual(Object.keys(providers), providerIds);
	assert.deepEqual(providerIds, index.DESCRIPTORS.map((descriptor) => descriptor.id), "the registry's ids are the descriptors', in their order");
	for (const descriptor of index.DESCRIPTORS) assert.equal(providers[descriptor.id], descriptor.load, `${descriptor.id}'s line is its descriptor's load()`);
});

test("loading the registry, the kind registry or a descriptor loads no provider and no vendor SDK: only descriptors, which import none", () => {
	const descriptorFiles = readdirSync(new URL("../dist/descriptors/", import.meta.url)).filter((name) => name.endsWith(".js"));
	assert.deepEqual(staticImports("../dist/providers.js"), ["./descriptors/index.js"], "the registry imports the descriptors alone");
	assert.deepEqual(staticImports("../dist/kinds.js"), ["./descriptors/index.js"], "the kind registry imports the descriptors alone");
	assert.deepEqual(staticImports("../dist/descriptor.js"), [], "the descriptor's type and check import nothing");
	for (const name of descriptorFiles) {
		const outside = staticImports(`../dist/descriptors/${name}`).filter((from) => from !== "../descriptor.js" && !/^\.\/[a-z0-9-]+\.js$/.test(from));
		assert.deepEqual(outside, [], `descriptors/${name} imports the descriptor's check and other descriptors alone`);
	}
});

test("every provider file under src/ has its descriptor, under the id its provider reports, whose load() imports it or the module that imports it", () => {
	const files = providerFiles();
	assert.ok(files.length >= 3, `found ${files.map((f) => f.file).join(", ")}`);
	for (const { file, id } of files) {
		assert.ok(id, `${file}.ts declares its provider's id as readonly id = "..."`);
		assert.ok(providerIds.includes(id), `src/${file}.ts implements ComputerProvider: it needs a descriptor in src/descriptors/ with id ${id}`);
		const loaded = loadedFile(id);
		// Another configuration's file is the provider module's to import: the descriptor still loads one module.
		if (loaded !== file) assert.ok(staticImports(`../dist/${loaded}.js`).includes(`./${file}.js`), `descriptors/${id}.js's load() imports ./${loaded}.js, which must import ./${file}.js, its other configuration`);
	}
	for (const { id, files: of } of providerModules()) assert.ok(of.includes(loadedFile(id)), `descriptors/${id}.js's load() imports one of ${of.join(", ")}`);
	assert.equal(index.DESCRIPTORS.length, providerModules().length, "and no descriptor names a file that is not a provider");
});

/**
 * The shared checks every provider module meets, whatever it is: create(options) and MOUNT, no ENV or fromEnv, and an
 * optional conformance module. A conformance module that reads the environment (settingsFromEnv) lists what it reads in
 * its ENV, each name COMPUTER_<ID>_* or its live switch; one without conformance() has nothing more to meet. Nothing
 * here names a provider, so a new one is its file and its registry line, with no edit to this test.
 */
async function checkProviderModule(id, module) {
	assert.equal(typeof module.create, "function", `${id} exports create(options)`);
	assert.ok(Array.isArray(module.MOUNT), `${id} exports MOUNT, an array`);
	assert.equal(module.ENV, undefined, `${id} exports no ENV: the library names no environment variable`);
	assert.equal(module.fromEnv, undefined, `${id} exports no fromEnv: every setting is an option`);
	if (module.conformance === undefined) return;
	assert.equal(typeof module.conformance, "function", `${id}'s conformance is () => import(...)`);
	const conformance = await module.conformance();
	assert.equal(typeof conformance.createProvider, "function", `${id}'s conformance module exports createProvider()`);
	if (conformance.settingsFromEnv === undefined) return;
	assert.equal(typeof conformance.settingsFromEnv, "function", `${id}'s settingsFromEnv is a function`);
	const names = Object.values(conformance.ENV ?? {});
	assert.ok(names.length > 0, `${id}'s conformance module reads the environment (settingsFromEnv), so it exports ENV, the names it reads`);
	const prefix = `COMPUTER_${id.toUpperCase().replace(/-/g, "_")}_`;
	for (const name of names) {
		assert.match(name, new RegExp(`^(${prefix}[A-Z0-9_]+|AGENTRUN_COMPUTER_LIVE_${id.toUpperCase().replace(/-/g, "_")})$`), `${id} reads ${name}: every name is ${prefix}*, never a vendor's bare variable`);
	}
}

test("every id resolves to a module of the registry's shape, and only the conformance side names COMPUTER_ variables, listed in its ENV", async () => {
	for (const id of providerIds) await checkProviderModule(id, await providerModule(id));
});

test("a provider module with no conformance() meets the shared checks: conformance is optional, and no test names a provider", async () => {
	const module = await import("./fixtures/options-provider.mjs");
	assert.equal(module.conformance, undefined);
	await checkProviderModule("options-module", module);
});

test("each in-tree conformance module's ENV is the names its settingsFromEnv reads", async () => {
	for (const id of providerIds) {
		const conformance = await (await providerModule(id)).conformance();
		const env = Object.fromEntries(Object.values(conformance.ENV ?? {}).map((name) => [name, undefined]));
		assert.ok(Object.keys(env).length > 0, `${id}'s conformance module exports ENV`);
		// Every name settingsFromEnv looks up is one of ENV's: a Proxy records the lookups.
		const read = new Set();
		const recording = new Proxy({}, { get: (_target, name) => (typeof name === "string" && read.add(name), undefined) });
		try {
			conformance.settingsFromEnv(recording);
		} catch {
			// Without a key it refuses, having read the key's name first; the rest is read with every name set below.
		}
		const full = Object.fromEntries(Object.keys(env).map((name) => [name, name.endsWith("STREAM") ? "1" : /LIFETIME/.test(name) ? "60000" : "x"]));
		const reading = new Proxy(full, { get: (target, name) => (typeof name === "string" && read.add(name), target[name]) });
		conformance.settingsFromEnv(reading);
		const outside = [...read].filter((name) => !Object.hasOwn(env, name) && /^COMPUTER_/.test(name));
		assert.deepEqual(outside, [], `${id}'s settingsFromEnv reads a COMPUTER_ name its ENV does not list`);
	}
});

test("every registry module exports MOUNT beside create: the mount kinds its computers take, known without building a provider", async () => {
	for (const id of providerIds) {
		const module = await providerModule(id);
		assert.ok(Array.isArray(module.MOUNT), `${id} exports MOUNT, an array`);
		for (const kind of module.MOUNT) assert.ok(index.MOUNT_KINDS.includes(kind), `${id}'s MOUNT holds ${JSON.stringify(kind)}, which is not a mount kind`);
		assert.equal(new Set(module.MOUNT).size, module.MOUNT.length, `${id}'s MOUNT names each kind once`);
	}
	// Which provider binds a local folder, read from the registry alone: Docker; Modal and Daytona take none until D6.
	const binds = [];
	for (const id of providerIds) if ((await providerModule(id)).MOUNT.includes("bind")) binds.push(id);
	assert.deepEqual(binds, ["docker"]);
});

test("providerFor() names the known ids for an id it does not know", async () => {
	for (const id of ["nope", "constructor", "__proto__", "toString", ""]) {
		await assert.rejects(providerFor(id, {}), (error) => {
			assert.match(error.message, new RegExp(`unknown computer provider ${JSON.stringify(id).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
			assert.match(error.message, KNOWN);
			return true;
		});
	}
	await assert.rejects(providerModule("nope"), KNOWN);
});

/** Runs fn with these names set in process.env, and puts back what was there. */
async function withProcessEnv(values, fn) {
	const before = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
	Object.assign(process.env, values);
	try {
		return await fn();
	} finally {
		for (const [name, value] of Object.entries(before)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

test("providerFor() takes the key as an option and reads no environment: neither the vendor's name nor COMPUTER_<VENDOR>_* is a fallback", async () => {
	const ambient = {
		DAYTONA_API_KEY: "fake-test-key",
		COMPUTER_DAYTONA_API_KEY: "fake-test-key",
		MODAL_TOKEN_ID: "fake-test-key",
		MODAL_TOKEN_SECRET: "fake-test-key",
		COMPUTER_MODAL_TOKEN_ID: "fake-test-key",
		COMPUTER_MODAL_TOKEN_SECRET: "fake-test-key",
		COMPUTER_MODAL_APP: "computers",
		E2B_API_KEY: "fake-test-key",
		COMPUTER_E2B_API_KEY: "fake-test-key",
		COMPUTER_DOCKER_DAEMON: DAEMON,
	};
	await withProcessEnv(ambient, async () => {
		await assert.rejects(providerFor("daytona", {}), (error) => {
			assert.match(error.message, /options\.apiKey/);
			assert.doesNotMatch(error.message, /fake-test-key|DAYTONA_API_KEY/);
			return true;
		});
		await assert.rejects(providerFor("modal", { app: "computers" }), (error) => {
			assert.match(error.message, /options\.tokenId and options\.tokenSecret/);
			assert.doesNotMatch(error.message, /fake-test-key|MODAL_TOKEN/);
			return true;
		});
		await assert.rejects(providerFor("e2b", {}), (error) => {
			assert.match(error.message, /options\.apiKey/);
			assert.doesNotMatch(error.message, /fake-test-key|E2B_API_KEY/);
			return true;
		});
		// COMPUTER_DOCKER_DAEMON is set, but only an option names the daemon: without one, Docker is asked, and here it
		// is not there.
		await assert.rejects(providerFor("docker", { docker: join(dir, "no-such-docker") }), /cannot ask Docker its architecture/);
	});
	const daytona = await providerFor("daytona", { apiKey: "fake-test-key", daemonPath: DAEMON });
	assert.equal(daytona.id, "daytona");
	const docker = await providerFor("docker", { daemonPath: DAEMON, docker: join(dir, "no-such-docker") });
	assert.equal(docker.id, "docker");
});

test("the package's index exports the registry, so serve resolves a provider without naming a vendor", () => {
	assert.equal(index.providers, providers);
	assert.equal(index.providerFor, providerFor);
	assert.equal(index.providerFromEnv, undefined);
	assert.deepEqual(index.providerIds, providerIds);
});

test("Docker's create() takes the daemon as options.daemonPath without asking Docker, and refuses a root user", async () => {
	const docker = await import("../dist/docker.js");
	assert.equal(docker.ENV, undefined);
	const provider = await docker.create({ daemonPath: DAEMON, docker: join(dir, "no-such-docker") });
	assert.equal(provider.id, "docker", "built without running the docker CLI, which does not exist");
	await assert.rejects(docker.create({ daemonPath: DAEMON, user: "0:0" }), /root/);
});

test("Docker's conformance module reads COMPUTER_DOCKER_DAEMON, COMPUTER_DOCKER_DAEMON_CACHE and COMPUTER_DOCKER_USER and passes them as options", async () => {
	const conformance = await import("../dist/conformance/docker.js");
	assert.deepEqual(conformance.DOCKER_ENV, { daemon: "COMPUTER_DOCKER_DAEMON", daemonCache: "COMPUTER_DOCKER_DAEMON_CACHE", user: "COMPUTER_DOCKER_USER" });
	assert.deepEqual(conformance.settingsFromEnv({}), {});
	assert.deepEqual(conformance.settingsFromEnv({ COMPUTER_DOCKER_DAEMON: DAEMON, COMPUTER_DOCKER_USER: "2000:2000" }), { daemonPath: DAEMON, user: "2000:2000" });
	const cache = join(dir, "cache");
	assert.deepEqual(conformance.settingsFromEnv({ COMPUTER_DOCKER_DAEMON_CACHE: cache }), { daemonCache: cache });
	assert.deepEqual(conformance.settingsFromEnv({ XDG_CACHE_HOME: dir }), {}, "XDG_CACHE_HOME is not one of its names");
	const provider = await conformance.createProvider({ env: { COMPUTER_DOCKER_DAEMON: DAEMON, COMPUTER_DOCKER_USER: "2000:2000" }, docker: join(dir, "no-such-docker") });
	assert.equal(provider.user, "2000:2000");
	await assert.rejects(conformance.createProvider({ env: { COMPUTER_DOCKER_DAEMON: DAEMON, COMPUTER_DOCKER_USER: "0:0" } }), /root/);
});

test("Docker's create() without options.daemonPath picks this package's daemon for Docker's architecture, and says when it is not built", async () => {
	const docker = await import("../dist/docker.js");
	const cli = join(dir, "docker-riscv64");
	writeFileSync(cli, "#!/bin/sh\necho riscv64\n");
	chmodSync(cli, 0o755);
	await assert.rejects(docker.create({ docker: cli }), (error) => {
		assert.match(error.message, /no daemon for Docker's riscv64 at \S*computerd-linux-riscv64/);
		assert.match(error.message, /npm run build:daemon/);
		return true;
	});
	await assert.rejects(docker.create({ docker: join(dir, "no-such-docker") }), /cannot ask Docker its architecture/);
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
	assert.doesNotMatch(source, /conformance\/(docker|modal|daytona|e2b)|\.\/(docker|modal|daytona|e2b)\.js/, "and imports no vendor's module");
});

test("a provider file by path runs before its registry line exists: the CLI takes a module that exports create(options) as it takes a registry entry, and hands it its options without the env", async () => {
	const cases = [{ id: "health.ping", level: "core", group: "health", needs: [], run: async () => {} }];
	for (const [providerOptions, id] of [
		[undefined, "options-module"],
		[{ env: { COMPUTER_OPTIONS_MODULE_ID: "from-env" }, id: "from-options" }, "from-options"],
	]) {
		const out = sink();
		const err = sink();
		const code = await main(["--provider", "./fixtures/options-provider.mjs", "--json"], { stdout: out, stderr: err, cwd: HERE, cases, ...(providerOptions ? { providerOptions } : {}) });
		assert.equal(code, 0, err.text());
		assert.equal(JSON.parse(out.text()).provider, id);
	}
});

// --- the library reads no environment: scripts/check-env.mjs ---

const SRC_DIR = fileURLToPath(SRC);
const FIXTURES = join(HERE, "fixtures", "env-reads");
const { checkEnv, envReads, GUARDS } = await import("../scripts/check-env.mjs").catch((error) => {
	const missing = () => assert.fail(`scripts/check-env.mjs does not load: ${error.message}`);
	return { checkEnv: missing, envReads: missing, GUARDS: [] };
});

test("nothing under src/ outside src/conformance/ reads the environment, but the two documented guards, each where it is documented", async () => {
	const { problems, guards, files } = await checkEnv(SRC_DIR);
	assert.deepEqual(problems, [], problems.map((p) => `${p.file}:${p.line}: ${p.what}`).join("\n"));
	// The check reads every file under src/, those in its directories included: the Docker provider's own files (its
	// egress proxy and its image) and the daemon's copy are library code like any other.
	assert.ok(Array.isArray(files), "the check says which files it read");
	for (const file of ["docker.ts", "daemon-copy.ts", "docker/egress.ts", "docker/egress-main.ts", "docker/egress-proxy.ts", "docker/egress-table.ts", "docker/image.ts", "modal.ts", "e2b.ts"]) {
		assert.ok(files.includes(file), `the check reads ${file}`);
	}
	assert.deepEqual(files.filter((file) => file.startsWith("conformance/")), [], "and none under src/conformance/");
	assert.deepEqual(
		GUARDS.map(({ file, fn, name }) => ({ file, fn, name })),
		[
			{ file: "modal.ts", fn: "modalClient", name: "MODAL_SERVER_URL" },
			{ file: "e2b.ts", fn: "ambientProblem", name: "E2B_SANDBOX_URL" },
		],
		"exactly two exceptions: the vendor SDKs read these on their own",
	);
	for (const guard of GUARDS) assert.ok(guards.some((seen) => seen.file === guard.file && seen.name === guard.name), `${guard.file} still holds its ${guard.name} guard, so the exception has not gone stale`);
});

test("the check reads source with TypeScript's parser: every way of reaching process.env is caught, and comments, strings and other members are not", () => {
	const file = "evasions.ts";
	const text = readFileSync(join(FIXTURES, file), "utf8");
	const found = envReads(file, text).map((read) => read.line);
	const expected = text.split("\n").flatMap((line, at) => (/\/\/ caught\b/.test(line) ? [at + 1] : []));
	assert.ok(expected.length >= 12, `the fixture marks every evasion it holds (${expected.length})`);
	assert.deepEqual([...new Set(found)].sort((a, b) => a - b), expected, "each marked line is caught, and nothing else");
	const clean = "clean.ts";
	assert.deepEqual(envReads(clean, readFileSync(join(FIXTURES, clean), "utf8")), [], "comments, strings, regular expressions, process.argv and another object's env are not reads");
});

test("the check allows a guard only by its name, in its file and its function", () => {
	const guarded = 'export function modalClient() {\n\tif (process.env.MODAL_SERVER_URL) throw new Error("no");\n\tprocess.env.MODAL_SERVER_URL = "x";\n\tdelete process.env.MODAL_SERVER_URL;\n}\n';
	assert.deepEqual(envReads("modal.ts", guarded), []);
	assert.equal(envReads("modal.ts", guarded.replace("function modalClient", "function another")).length, 3, "another function of the same file");
	assert.equal(envReads("docker.ts", guarded).length, 3, "the same function name in another file");
	assert.equal(envReads("modal.ts", guarded.replaceAll("MODAL_SERVER_URL", "MODAL_TOKEN_ID")).length, 3, "another name in the guard's function");
	assert.equal(envReads("e2b.ts", 'function ambientProblem() {\n\treturn process.env.E2B_SANDBOX_URL;\n}\n').length, 0);
	assert.equal(envReads("e2b.ts", 'function ambientProblem() {\n\treturn process.env["E2B_API_KEY"];\n}\n').length, 1);
});
