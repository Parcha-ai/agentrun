// Chrome's environment: the sandbox check's Chrome (chrome.ts checkChrome), and the local browser's supervisor and the
// Chrome it starts (local-chrome.ts, local-supervisor.ts), are started with the names Chrome reads (where it draws, its
// fonts and locale, PATH, HOME and temp files) of the environment the host passes (the `env` option), and none of the
// rest, so a key the server holds reaches neither. The key is in this process's environment as well, so a child that
// inherits it is caught too. Over a fake Chrome (fake-chrome.mjs) behind a recorder of its environment; no real Chrome.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkChrome } from "../dist/chrome.js";
import { LocalBrowserProvider } from "../dist/local-chrome.js";
import { SUPERVISOR_FILE } from "../dist/local-supervisor.js";

const KEY = "FOO_API_KEY";
const PLAIN = "AGENTRUN_UNLISTED_SETTING";
/** What Chrome reads, set here so each start shows it: the display it draws on, and its locale. */
const NEEDED = { DISPLAY: ":99", LANG: "C.UTF-8" };
const SEEN = ["PATH", "HOME", ...Object.keys(NEEDED)];
const was = {};
// A short root: the egress socket's path must fit a Unix socket.
const scratch = mkdtempSync(join("/tmp", "lbe-"));
const FAKE = new URL("./fake-chrome.mjs", import.meta.url).href;

before(() => {
	for (const name of [KEY, PLAIN, ...Object.keys(NEEDED)]) was[name] = process.env[name];
	process.env[KEY] = `not-a-secret-${"canary"}`;
	process.env[PLAIN] = "plain";
	Object.assign(process.env, NEEDED);
});
after(() => {
	for (const [name, value] of Object.entries(was)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(scratch, { recursive: true, force: true });
});

/** The environment the host passes: this process's, the key and the plain name included. */
const hostEnv = () => ({ ...process.env });

let made = 0;
/** A Chrome that writes the environment it was started with to `out` (its names, and the values of SEEN's names alone),
 *  then runs as the fake Chrome does. The path is written into the program: no environment name carries it. */
function recordingChrome() {
	const out = join(scratch, `env-${++made}.jsonl`);
	const program = join(scratch, `chrome-${made}`);
	writeFileSync(program, `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(out)}, JSON.stringify({ args: process.argv.slice(2), names: Object.keys(process.env).sort(), seen: Object.fromEntries(${JSON.stringify(SEEN)}.map((n) => [n, process.env[n] ?? null])) }) + "\\n");
import(${JSON.stringify(FAKE)});
`);
	chmodSync(program, 0o755);
	return { program, envs: () => (existsSync(out) ? readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []) };
}

/** Each recorded start holds no key and no unlisted name, and holds what Chrome reads, as this process has it. */
function onlyWhatChromeReads(envs, what) {
	assert.ok(envs.length > 0, `${what}: no Chrome start was recorded`);
	for (const { names, seen } of envs) {
		assert.ok(!names.includes(KEY), `${what}: ${KEY} reached Chrome`);
		assert.ok(!names.includes(PLAIN), `${what}: ${PLAIN}, a name Chrome never reads, reached Chrome`);
		assert.deepEqual(seen, { PATH: process.env.PATH, HOME: process.env.HOME, ...NEEDED }, `${what}: Chrome has what it reads`);
	}
}

test("checkChrome(): the sandbox check's Chrome is started with what Chrome reads alone, never a key", async () => {
	const chrome = recordingChrome();
	const checked = await checkChrome(chrome.program, { uid: process.getuid(), env: hostEnv() });
	assert.equal(checked.ok, true, JSON.stringify(checked));
	onlyWhatChromeReads(chrome.envs(), "checkChrome");
});

test("create(): the local browser's supervisor, and the Chrome it starts, hold what Chrome reads alone, never a key", async () => {
	const chrome = recordingChrome();
	const provider = new LocalBrowserProvider({ executablePath: chrome.program, root: join(scratch, "r"), uid: process.getuid(), env: hostEnv() });
	const created = await provider.create({ image: "chromium", lifetimeMs: 60_000, network: "open" }, { requestId: "chrome-env-create" });
	assert.equal(created.ok, true, JSON.stringify(created));
	try {
		// The supervisor's own environment, as the kernel holds it: it outlives the call that made it.
		const supervisor = Number(readFileSync(join(provider.root, created.value.id, SUPERVISOR_FILE), "utf8").trim());
		const held = readFileSync(`/proc/${supervisor}/environ`, "utf8").split("\0").filter(Boolean).map((pair) => pair.slice(0, pair.indexOf("=")));
		assert.ok(!held.includes(KEY), `create: ${KEY} reached the supervisor`);
		assert.ok(!held.includes(PLAIN), `create: ${PLAIN}, a name Chrome never reads, reached the supervisor`);
		onlyWhatChromeReads(chrome.envs(), "create");
	} finally {
		await provider.release(created.value, "delete");
	}
});
