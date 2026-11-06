// The files demo on real Docker (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only): files go in and out of a debian:bookworm-slim
// computer with no network, as its non-root user under /work, one at a time and as tar archives. Needs `npm run build` and `npm run build:daemon` first,
// the image pulled, and tar on this machine. Every container this file makes is removed by its exact name in the after
// hook, pass or fail.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { DockerProvider, pullTar, pullTarStream, pushTar, readFile, writeFile } from "../../dist/index.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const IMAGE = "debian:bookworm-slim";
/** The provider's default user, which the daemon and so every file it writes has: this process's, or 1000:1000 as root. */
const [UID, GID] = (process.getuid() !== 0 ? `${process.getuid()}:${process.getgid()}` : "1000:1000").split(":").map(Number);
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });
const decode = (base64) => Buffer.from(base64, "base64").toString("utf8");

/** Every entry below root: its type, mode, and content hash or link target. */
function tree(root, dir = "") {
	const rows = [];
	for (const name of readdirSync(join(root, dir)).sort()) {
		const rel = dir === "" ? name : `${dir}/${name}`;
		const stat = lstatSync(join(root, rel));
		const mode = (stat.mode & 0o7777).toString(8);
		if (stat.isSymbolicLink()) rows.push(`${rel} symlink -> ${readlinkSync(join(root, rel))}`);
		else if (stat.isDirectory()) rows.push(`${rel} dir ${mode}`, ...tree(root, rel));
		else rows.push(`${rel} file ${mode} ${createHash("sha256").update(readFileSync(join(root, rel))).digest("hex")}`);
	}
	return rows;
}

/** One ustar entry: a 512-byte header, then the body padded to 512. */
function tarEntry(name, { type = "0", body = Buffer.alloc(0), link = "" } = {}) {
	const header = Buffer.alloc(512);
	const field = (at, length, value) => header.write(value, at, length, "utf8");
	field(0, 100, name);
	field(100, 8, `${(type === "5" ? 0o755 : 0o644).toString(8).padStart(7, "0")}\0`);
	field(108, 8, "0000000\0");
	field(116, 8, "0000000\0");
	field(124, 12, `${body.length.toString(8).padStart(11, "0")}\0`);
	field(136, 12, `${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`);
	field(148, 8, "        ");
	field(156, 1, type);
	field(157, 100, link);
	field(257, 6, "ustar\0");
	field(263, 2, "00");
	let sum = 0;
	for (const byte of header) sum += byte;
	field(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
	return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

const tarOf = (...entries) => Buffer.concat([...entries, Buffer.alloc(1024)]);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Settles as promise does, or rejects once ms pass: a hang becomes a failure that says what hung. */
function within(promise, ms, what) {
	let timer;
	const late = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms / 1000} s`)), ms);
	});
	return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * Runs 8 pushes of `archive` on one client, all open at once: no source gives its bytes until every push has begun
 * (or ended without beginning).
 */
function eightAtOnce(client, dir, archive) {
	let arrived = 0;
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	const one = (i) => {
		let here = false;
		const arrive = () => {
			if (here) return;
			here = true;
			if (++arrived === 8) release();
		};
		async function* source() {
			arrive();
			await gate;
			yield archive;
		}
		return pushTar(client, `${dir}/${i}`, source()).finally(arrive);
	};
	return Promise.all(Array.from({ length: 8 }, (_, i) => one(i)));
}

describe("move files in and out of a Docker computer", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const made = [];
	const local = [];
	let provider;
	let ref;
	let connection;
	let client;

	const run = async (argv) => {
		const result = await client.call("exec.run", { argv, timeoutMs: 20_000 });
		assert.equal(result.ok, true, JSON.stringify(result));
		return { ...result.value, out: decode(result.value.stdout), err: decode(result.value.stderr) };
	};
	const call = async (method, params) => {
		const result = await client.call(method, params);
		assert.equal(result.ok, true, `${method}: ${JSON.stringify(result)}`);
		return result.value;
	};
	/** Runs fn on a connection of its own, closed after, so a connection fn wedges fails only its own test. */
	const onItsOwnConnection = async (fn) => {
		const connected = await provider.connect(ref);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		try {
			return await fn(connected.value.client);
		} finally {
			await connected.value.close();
		}
	};
	/** A tree of 8 MiB and more at /work/data/tree in the computer, made once. */
	let treeMade;
	const bigTree = () =>
		(treeMade ??= (async () => {
			assert.equal((await writeFile(client, "/work/data/tree/a.bin", randomBytes(5 * 1024 * 1024), { parents: true })).ok, true);
			assert.equal((await writeFile(client, "/work/data/tree/sub/b.bin", randomBytes(3 * 1024 * 1024 + 99), { parents: true })).ok, true);
			assert.equal((await writeFile(client, "/work/data/tree/sub/run.sh", Buffer.from("#!/bin/sh\necho copied\n"), { mode: 0o755 })).ok, true);
			await run(["ln", "-s", "sub/run.sh", "/work/data/tree/run"]);
			return "/work/data/tree";
		})());
	const listing = async (dir) =>
		(await run(["sh", "-c", `cd ${dir} && find . -mindepth 1 -printf '%y %m %p %l\\n' | sort && find . -type f -exec sha256sum {} + | sort -k2`])).out;
	const scratch = () => {
		const dir = mkdtempSync(join(tmpdir(), "computer-files-"));
		local.push(dir);
		return dir;
	};

	before(async () => {
		const arch = docker("version", "--format", "{{.Server.Arch}}").trim();
		const daemonPath = fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url));
		assert.ok(existsSync(daemonPath), `no daemon for Docker's arch at ${daemonPath}: run npm run build:daemon`);
		provider = new DockerProvider({ daemonPath });
		const created = await provider.create({ image: IMAGE, lifetimeMs: 10 * 60_000, network: "none", labels: { "agentrun.test": "files" } });
		assert.equal(created.ok, true, JSON.stringify(created));
		ref = created.value;
		made.push(ref.name);
		const connected = await provider.connect(ref);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		connection = connected.value;
		client = connection.client;
	});

	after(async () => {
		await connection?.close();
		for (const name of made) {
			try {
				execFileSync("docker", ["rm", "--force", "--volumes", name], { stdio: "ignore" });
			} catch {
				// Already removed.
			}
		}
		for (const dir of local) rmSync(dir, { recursive: true, force: true });
	});

	it("says hello with files, in a computer with no network", async () => {
		assert.deepEqual(connection.hello.capabilities, ["exec", "files", "processes"]);
		assert.deepEqual((await run(["ls", "/sys/class/net"])).out.split("\n").filter(Boolean), ["lo"]);
	});

	it("writes as the computer's non-root user: /work is its own, the image's root-owned directories are not", async () => {
		assert.equal((await run(["id", "-u"])).out.trim(), String(UID));
		const home = await call("files.stat", { path: "/work" });
		assert.deepEqual([home.type, home.mode, home.uid, home.gid], ["dir", 0o700, UID, GID]);
		const refused = await client.call("files.write", { path: "/data/outside.txt", data: "", parents: true });
		assert.equal(refused.ok, false);
		assert.equal(refused.error.code, "denied", JSON.stringify(refused.error));
	});

	it("writes, reads, stats, lists, makes, moves and removes", async () => {
		await call("files.mkdir", { path: "/tmp/work/sub", parents: true });
		assert.deepEqual(await call("files.write", { path: "/tmp/work/a.txt", data: Buffer.from("alpha\n").toString("base64"), mode: 0o640 }), { size: 6 });
		const read = await call("files.read", { path: "/tmp/work/a.txt" });
		assert.equal(decode(read.data), "alpha\n");
		assert.equal(read.eof, true);
		const stat = await call("files.stat", { path: "/tmp/work/a.txt" });
		assert.equal(stat.type, "file");
		assert.equal(stat.size, 6);
		assert.equal(stat.mode, 0o640);
		assert.equal(stat.uid, UID);
		assert.equal(stat.gid, GID);
		const list = await call("files.list", { path: "/tmp/work" });
		assert.deepEqual(
			list.entries.map((e) => [e.path, e.type]),
			[
				["/tmp/work/a.txt", "file"],
				["/tmp/work/sub", "dir"],
			],
		);
		assert.equal(list.truncated, false);
		await call("files.move", { from: "/tmp/work/a.txt", to: "/tmp/work/sub/b.txt" });
		assert.equal((await run(["cat", "/tmp/work/sub/b.txt"])).out, "alpha\n");
		const missing = await client.call("files.stat", { path: "/tmp/work/a.txt" });
		assert.equal(missing.ok, false);
		assert.equal(missing.error.code, "not_found");
		const relative = await client.call("files.read", { path: "tmp/work/sub/b.txt" });
		assert.equal(relative.ok, false);
		assert.equal(relative.error.code, "invalid");
		const notEmpty = await client.call("files.remove", { path: "/tmp/work" });
		assert.equal(notEmpty.ok, false);
		assert.equal(notEmpty.error.code, "is_dir");
		await call("files.remove", { path: "/tmp/work", recursive: true });
		assert.equal((await run(["sh", "-c", "test -e /tmp/work && echo there || echo gone"])).out, "gone\n");
	});

	it("round-trips a file over 1 MiB byte for byte, and exec.run reads what was written", async () => {
		const bytes = randomBytes(3 * 1024 * 1024 + 17);
		assert.deepEqual(await writeFile(client, "/tmp/big.bin", bytes), { ok: true, value: { size: bytes.length } });
		const back = await readFile(client, "/tmp/big.bin");
		assert.equal(back.ok, true, JSON.stringify(back.error));
		assert.ok(Buffer.from(back.value).equals(bytes), "the bytes read back differ");
		const sum = (await run(["sha256sum", "/tmp/big.bin"])).out.split(" ")[0];
		assert.equal(sum, createHash("sha256").update(bytes).digest("hex"));
		await writeFile(client, "/tmp/hello.txt", Buffer.from("written by files.write\n"));
		assert.equal((await run(["cat", "/tmp/hello.txt"])).out, "written by files.write\n");
	});

	it("pushes a directory tree as a tar and pulls it back the same", async () => {
		const src = scratch();
		mkdirSync(join(src, "nested", "deeper"), { recursive: true });
		writeFileSync(join(src, "nested", "deeper", "leaf.txt"), "leaf\n");
		writeFileSync(join(src, "run.sh"), "#!/bin/sh\necho ran from a pushed tar\n");
		chmodSync(join(src, "run.sh"), 0o755);
		writeFileSync(join(src, "nested", "data.bin"), randomBytes(1536 * 1024));
		chmodSync(join(src, "nested", "data.bin"), 0o600);
		symlinkSync("nested/deeper/leaf.txt", join(src, "leaf-link"));
		const archive = execFileSync("tar", ["-C", src, "-cf", "-", "."], { maxBuffer: 64 * 1024 * 1024 });
		const pushed = await pushTar(client, "/work/data/pushed", archive);
		assert.equal(pushed.ok, true, JSON.stringify(pushed.error));
		assert.equal((await run(["/work/data/pushed/run.sh"])).out, "ran from a pushed tar\n");
		assert.equal((await run(["stat", "-c", "%a %u:%g", "/work/data/pushed/run.sh", "/work/data/pushed/nested/data.bin"])).out, `755 ${UID}:${GID}\n600 ${UID}:${GID}\n`);
		assert.equal((await run(["readlink", "/work/data/pushed/leaf-link"])).out, "nested/deeper/leaf.txt\n");
		assert.equal((await run(["cat", "/work/data/pushed/leaf-link"])).out, "leaf\n");
		const pulled = await pullTar(client, "/work/data/pushed");
		assert.equal(pulled.ok, true, JSON.stringify(pulled.error));
		const back = scratch();
		execFileSync("tar", ["-C", back, "-xpf", "-"], { input: pulled.value });
		assert.deepEqual(tree(back), tree(src));
	});

	it("refuses a zip-slip tar, and nothing lands outside the target", async () => {
		await call("files.mkdir", { path: "/work/data/slip", parents: true });
		for (const [name, archive] of [
			["dot-dot", tarOf(tarEntry("../escaped-dotdot", { body: Buffer.from("x") }))],
			["absolute", tarOf(tarEntry("/work/data/escaped-absolute", { body: Buffer.from("x") }))],
			["symlink", tarOf(tarEntry("out", { type: "2", link: "/work/data" }), tarEntry("out/escaped-symlink", { body: Buffer.from("x") }))],
		]) {
			const pushed = await pushTar(client, "/work/data/slip/target", archive);
			assert.equal(pushed.ok, false, `${name} was accepted`);
			assert.equal(pushed.error.code, "denied", `${name}: ${JSON.stringify(pushed.error)}`);
		}
		const found = await run(["sh", "-c", "ls /work/data /work/data/slip; ls /work/data/slip/target"]);
		assert.doesNotMatch(found.out, /escaped/, found.out);
	});

	it("writes a read-only file over 512 KiB, then sets its mode", async () => {
		const bytes = randomBytes(1536 * 1024);
		const wrote = await writeFile(client, "/work/data/read-only.bin", bytes, { mode: 0o400 });
		assert.deepEqual(wrote, { ok: true, value: { size: bytes.length } });
		const back = await readFile(client, "/work/data/read-only.bin");
		assert.equal(back.ok, true, JSON.stringify(back.error));
		assert.ok(Buffer.from(back.value).equals(bytes), "the bytes read back differ");
		assert.equal((await call("files.stat", { path: "/work/data/read-only.bin" })).mode, 0o400);
	});

	it("copies a tree in the computer by piping a pull into a push on the same connection", async () => {
		const src = await bigTree();
		await onItsOwnConnection(async (one) => {
			const copied = await within(pushTar(one, "/work/data/tree-copy", pullTarStream(one, src).chunks), 120_000, "the pull piped into the push");
			assert.equal(copied.ok, true, JSON.stringify(copied.error));
		});
		assert.equal(await listing("/work/data/tree-copy"), await listing(src));
		assert.equal((await run(["/work/data/tree-copy/run"])).out, "copied\n");
	});

	it("a copy into a directory that refuses its writes ends the source pull, and 8 pulls follow on the same connection", async () => {
		const src = await bigTree();
		await call("files.mkdir", { path: "/work/data/read-only-dir", mode: 0o555, parents: true });
		await onItsOwnConnection(async (one) => {
			const { chunks, done } = pullTarStream(one, src);
			const copied = await within(pushTar(one, "/work/data/read-only-dir", chunks), 60_000, "the refused copy");
			assert.equal(copied.ok, false);
			assert.equal(copied.error.code, "denied", JSON.stringify(copied.error));
			const ended = await within(done, 60_000, "the source pull's done");
			assert.equal(ended.ok, false);
			const eight = Array.from({ length: 8 }, () => pullTarStream(one, src).chunks[Symbol.asyncIterator]());
			const firsts = await within(Promise.all(eight.map((it) => it.next().then((step) => step.done, (error) => error.message))), 60_000, "8 pulls at once");
			assert.deepEqual(firsts, Array(8).fill(false));
			await within(Promise.all(eight.map((it) => it.return())), 60_000, "leaving the 8 pulls");
		});
		assert.equal((await run(["ls", "-A", "/work/data/read-only-dir"])).out, "");
	});

	it("answers other calls while a pull's chunks go unread", async () => {
		const src = await bigTree();
		await onItsOwnConnection(async (one) => {
			const { chunks, done } = pullTarStream(one, src);
			const iterator = chunks[Symbol.asyncIterator]();
			assert.equal((await within(iterator.next(), 60_000, "the first chunk")).done, false);
			await delay(1000);
			assert.deepEqual(await within(one.call("ping", {}), 60_000, "a ping beside an unread pull"), { ok: true, value: {} });
			const stat = await within(one.call("files.stat", { path: src }), 60_000, "a stat beside an unread pull");
			assert.equal(stat.ok && stat.value.type, "dir");
			await within(iterator.return(), 60_000, "leaving the pull");
			assert.equal((await done).ok, false);
		});
	});

	it("an aborted pull ends at once, and the connection takes 8 pulls after it", async () => {
		const src = await bigTree();
		await onItsOwnConnection(async (one) => {
			const controller = new AbortController();
			const { chunks, done } = pullTarStream(one, src, { signal: controller.signal });
			const iterator = chunks[Symbol.asyncIterator]();
			assert.equal((await within(iterator.next(), 60_000, "the first chunk")).done, false);
			await delay(1000);
			controller.abort();
			const ended = await within(done, 60_000, "done after the abort");
			assert.equal(ended.ok, false);
			assert.equal(ended.error.code, "aborted");
			assert.deepEqual(await within(one.call("ping", {}), 60_000, "a ping after the abort"), { ok: true, value: {} });
			const eight = Array.from({ length: 8 }, () => pullTarStream(one, src).chunks[Symbol.asyncIterator]());
			const firsts = await within(Promise.all(eight.map((it) => it.next())), 60_000, "8 pulls at once");
			assert.deepEqual(
				firsts.map((step) => step.done),
				Array(8).fill(false),
			);
			await within(Promise.all(eight.map((it) => it.return())), 60_000, "leaving the 8 pulls");
		});
	});

	it("a push aborted after its source ends still ends, and 8 pushes at once follow on the same connection", async () => {
		await onItsOwnConnection(async (one) => {
			const controller = new AbortController();
			async function* source() {
				yield tarOf(tarEntry("big.bin", { body: randomBytes(512 * 1024 - 1536) }));
				controller.abort();
			}
			const aborted = await within(pushTar(one, "/work/data/aborted", source(), { signal: controller.signal }), 60_000, "the aborted push");
			assert.equal(aborted.ok, false);
			assert.equal(aborted.error.code, "aborted");
			const eight = await within(eightAtOnce(one, "/work/data/eight", tarOf(tarEntry("one.txt", { body: Buffer.from("1") }))), 60_000, "8 pushes at once");
			assert.deepEqual(
				eight.map((r) => (r.ok ? "ok" : `${r.error.code}: ${r.error.message}`)),
				Array(8).fill("ok"),
			);
		});
	});
});
