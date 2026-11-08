// The Docker provider's image on real Docker (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only): a small recipe on alpine:3.20 is
// built once, its tag reused on the next call, one build shared by concurrent callers in one process, and two processes
// building it at once both end with the tag on this recipe's image; a broken recipe is refused in words. Needs
// `npm run build` and alpine:3.20 pulled. Each recipe carries a fresh nonce, so its tag is new to this Docker; the after
// hook removes every tag the file made, by its exact name.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import { DockerProvider, ensureImage, RECIPE_LABEL, recipeHash, recipeTag } from "../../dist/index.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const INDEX = new URL("../../dist/index.js", import.meta.url).href;
const run = promisify(execFile);
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const labelOf = (tag) => JSON.parse(docker("image", "inspect", "--format", "{{json .Config.Labels}}", tag))?.[RECIPE_LABEL];
const recipe = (step) => `FROM alpine:3.20\n${step}\n`;

describe("the provider's image on real Docker", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const made = new Set();
	let dir;
	let logged;
	/** docker, through a script that writes each call's argv to a log first: what this file's calls asked Docker. */
	let wrapped;
	const builds = () => readFileSync(logged, "utf8").split("\n").filter((line) => line.startsWith("build "));

	before(() => {
		dir = mkdtempSync(join(tmpdir(), "computer-image-"));
		logged = join(dir, "calls.log");
		writeFileSync(logged, "");
		wrapped = join(dir, "docker");
		writeFileSync(wrapped, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${logged}'\nexec docker "$@"\n`);
		chmodSync(wrapped, 0o755);
	});

	after(() => {
		for (const tag of made) {
			try {
				execFileSync("docker", ["image", "rm", "--force", tag], { stdio: "ignore" });
			} catch {
				// Never built, or already removed.
			}
		}
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	});

	it("builds a recipe once for three concurrent callers, labels it with the recipe's hash, and reuses the tag on the next call with no build", async () => {
		const nonce = randomBytes(8).toString("hex");
		const text = recipe(`RUN echo ${nonce} > /made`);
		const tag = recipeTag(text);
		made.add(tag);
		const results = await Promise.all([1, 2, 3].map(() => ensureImage({ recipe: text }, { docker: wrapped })));
		for (const result of results) assert.deepEqual(result, { ok: true, value: tag });
		assert.equal(builds().length, 1, `one build for three callers: ${builds().join(" | ")}`);
		assert.equal(labelOf(tag), recipeHash(text), "the image carries the recipe's whole sha256");
		assert.equal(docker("run", "--rm", "--network", "none", tag, "cat", "/made").trim(), nonce, "the image is this recipe's");
		assert.deepEqual(await ensureImage({ recipe: text }, { docker: wrapped }), { ok: true, value: tag });
		assert.equal(builds().length, 1, "the next call finds the tag: no build");
		const provider = new DockerProvider({ daemonPath: wrapped, docker: wrapped, image: { recipe: text } });
		assert.deepEqual(await provider.image(), { ok: true, value: tag });
		assert.equal(builds().length, 1, "nor through the provider");
	});

	it("two processes building one new recipe at once both end with its tag on this recipe's image", async () => {
		const nonce = randomBytes(8).toString("hex");
		const text = recipe(`RUN echo ${nonce} > /made && sleep 2`);
		const tag = recipeTag(text);
		made.add(tag);
		const script = `const { ensureImage } = await import(${JSON.stringify(INDEX)}); process.stdout.write(JSON.stringify(await ensureImage({ recipe: ${JSON.stringify(text)} })));`;
		const both = await Promise.all([1, 2].map(() => run(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 600_000 })));
		for (const { stdout } of both) assert.deepEqual(JSON.parse(stdout), { ok: true, value: tag });
		assert.equal(labelOf(tag), recipeHash(text));
		assert.equal(docker("run", "--rm", "--network", "none", tag, "cat", "/made").trim(), nonce);
	});

	it("refuses a broken recipe in words, its failing step named, and tags nothing", async () => {
		const nonce = randomBytes(8).toString("hex");
		const step = `test ${nonce} = no`;
		const text = recipe(`RUN ${step}`);
		const tag = recipeTag(text);
		made.add(tag);
		assert.deepEqual(await ensureImage({ recipe: text }), {
			ok: false,
			error: { code: "docker", message: `the recipe of ${tag} failed at the step \`RUN ${step}\` with exit code 1: fix that step` },
		});
		assert.throws(() => docker("image", "inspect", tag), /No such image/i, "nothing was tagged");
		const unparsed = recipe(`BOGUS ${nonce}`);
		made.add(recipeTag(unparsed));
		assert.deepEqual(await ensureImage({ recipe: unparsed }), {
			ok: false,
			error: { code: "docker", message: `Docker could not parse the recipe of ${recipeTag(unparsed)} at line 2: fix that line` },
		});
	});

	it("an image by name Docker has is ready with no pull; one at a registry that cannot be reached is refused in words", async () => {
		const start = readFileSync(logged, "utf8").split("\n").length;
		assert.deepEqual(await ensureImage({ image: "alpine:3.20" }, { docker: wrapped }), { ok: true, value: "alpine:3.20" });
		const calls = readFileSync(logged, "utf8").split("\n").slice(start - 1).filter(Boolean);
		assert.deepEqual(calls, ["image inspect --format {{json .Config.Labels}} alpine:3.20"], "one inspect, no pull");
		// Port 9 on this machine: nothing listens, so the registry is refused at once, with no call off the machine.
		const nowhere = `127.0.0.1:9/agentrun-nosuch:${randomBytes(4).toString("hex")}`;
		assert.deepEqual(await ensureImage({ image: nowhere }, { timeoutMs: 120_000 }), {
			ok: false,
			error: { code: "docker", message: `the registry could not be reached to pull ${nowhere}: run docker pull ${nowhere} on this machine to see why` },
		});
	});
});
