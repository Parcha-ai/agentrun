// What the volume option stages below the volume's root (src/docker/stage.ts): a published tree is never removed or
// written over, since Docker may have it mounted in a running computer, even when providers sharing daemonCache stage
// the same tree at once; and a source that is not a regular file, a named pipe with no writer included, is refused in
// words at once, never waited on.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DockerProvider } from "../dist/docker.js";

const run = promisify(execFile);
const STAGE = fileURLToPath(new URL("../dist/docker/stage.js", import.meta.url));
const NAME = "agentrun_agentrun-data";
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "computer-docker-stage-")));
after(() => rmSync(scratch, { recursive: true, force: true }));
let roots = 0;

/** A volume root with a daemon to stage. */
function setup() {
	const root = join(scratch, `data-${++roots}`);
	mkdirSync(root);
	const source = join(root, "computerd-source");
	writeFileSync(source, `a daemon ${roots}\n`);
	return { root, cache: join(root, "cache"), source, volume: { name: NAME, root } };
}

/** The entries of the cache directory other than the daemon's source. */
const listing = (cache) => readdirSync(cache).sort();

test("providers sharing daemonCache that stage the same daemon at once each use the one published tree, and none removes another's", async () => {
	for (let round = 0; round < 4; round++) {
		const { cache, source, volume } = setup();
		// Six processes, each released at the same moment, stage the same daemon into the same cache.
		const at = Date.now() + 400;
		const script = `import { daemonStage } from ${JSON.stringify(STAGE)};
while (Date.now() < ${at});
console.log(JSON.stringify(daemonStage(${JSON.stringify(source)}, ${JSON.stringify(cache)}, ${JSON.stringify(volume)})));`;
		const results = await Promise.all(Array.from({ length: 6 }, () => run(process.execPath, ["--input-type=module", "-e", script])));
		const staged = results.map(({ stdout }) => JSON.parse(stdout));
		for (const result of staged) assert.equal(result.ok, true, JSON.stringify(result));
		const paths = new Set(staged.map((result) => result.value.path));
		assert.equal(paths.size, 1, `every stager uses the one tree: ${[...paths].join(", ")}`);
		const [tree] = paths;
		assert.match(tree, /\/daemon-[0-9a-f]{64}$/);
		assert.deepEqual(listing(cache), [tree.split("/").at(-1)], "one tree, no temporary directory and no second copy");
		assert.equal(readFileSync(join(tree, "computerd"), "utf8"), readFileSync(source, "utf8"));
	}
});

test("a published tree is never removed or written over: one in use stays the same inode when staged again; one that no longer holds is left as it is, and a new one goes beside it", async () => {
	const { stage } = { stage: (await import(STAGE)).daemonStage };
	const { cache, source, volume } = setup();
	const first = stage(source, cache, volume);
	assert.equal(first.ok, true, JSON.stringify(first));
	const tree = first.value.path;
	const inode = statSync(join(tree, "computerd")).ino;
	// Staged again: the same tree, the file untouched (a running computer's mount of it stays good).
	const again = stage(source, cache, volume);
	assert.deepEqual(again, first);
	assert.equal(statSync(join(tree, "computerd")).ino, inode);
	// A tree that no longer holds (a hand edit, or a writer that died partway) may still be mounted somewhere: it is left
	// exactly as it is, and the daemon is published beside it under a fresh name, which later stages reuse.
	writeFileSync(join(tree, "computerd"), "changed");
	const beside = stage(source, cache, volume);
	assert.equal(beside.ok, true, JSON.stringify(beside));
	assert.match(beside.value.path, new RegExp(`^${tree}-[0-9a-f]{16}$`));
	assert.equal(readFileSync(join(tree, "computerd"), "utf8"), "changed", "the tree that no longer holds is left as it is");
	assert.equal(statSync(join(tree, "computerd")).ino, inode);
	assert.equal(readFileSync(join(beside.value.path, "computerd"), "utf8"), readFileSync(source, "utf8"));
	assert.equal(beside.value.subpath, `cache/${beside.value.path.split("/").at(-1)}`);
	assert.deepEqual(stage(source, cache, volume), beside, "the tree beside it is reused");
	assert.equal(listing(cache).length, 2, JSON.stringify(listing(cache)));
});

test("a daemon that is a named pipe with no writer is refused in words at once, never read: create returns, and nothing is staged", { timeout: 20_000 }, async () => {
	const { cache, root, volume } = setup();
	const fifo = join(root, "computerd-fifo");
	execFileSync("mkfifo", [fifo]);
	const { daemonStage } = await import(STAGE);
	const staged = daemonStage(fifo, cache, volume);
	assert.equal(staged.ok, false);
	assert.equal(staged.error.code, "not_found");
	assert.match(staged.error.message, new RegExp(`the daemon at ${fifo} is not a regular file`));
	// Through the provider: create refuses it before any docker call.
	const provider = new DockerProvider({ daemonPath: fifo, daemonCache: cache, docker: join(root, "no-docker"), volume });
	const made = await provider.create({ image: "debian:bookworm-slim", lifetimeMs: 600_000, network: "none" });
	assert.equal(made.ok, false);
	assert.match(made.error.message, /is not a regular file/);
	assert.throws(() => statSync(cache), { code: "ENOENT" }, "nothing is staged: the source is refused before the cache is made");
});

test("the egress proxy's code is read the same way: a named pipe in its place is refused in words, never waited on", { timeout: 20_000 }, async () => {
	const { cache, root, volume } = setup();
	const dir = join(root, "build");
	mkdirSync(dir);
	for (const file of ["egress-main.js", "egress-proxy.js"]) writeFileSync(join(dir, file), "// code\n");
	execFileSync("mkfifo", [join(dir, "egress-table.js")]);
	writeFileSync(join(root, "package.json"), "{}\n");
	const { egressStage } = await import(STAGE);
	const staged = egressStage({ dir, packageJson: join(root, "package.json") }, cache, volume);
	assert.equal(staged.ok, false);
	assert.match(staged.error.message, /the egress proxy's code at .*egress-table\.js is not a regular file/);
});
