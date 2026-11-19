// The run's folder: a computer made with a mount of a kind the provider declares has the folder at /workspace, so a file
// written outside shows inside, one written inside shows outside, and a program run there sees it; the mount reads back
// as asked, with no Archil token in any read-back. A kind the provider does not declare is refused by check() in words,
// before any vendor call. Every case is Full: optional for every kind of computer until the cutover decides.
//
// An Archil mount is exclusive: what the disk's file API sees of a folder a computer holds, and what the computer sees
// of a write through the file API while it holds it, are not yet known either way. So for Archil, a file written outside
// before the computer is made is read inside (the Mode 2 flow), and the two directions while it is held are recorded as
// seen (observe), not asserted. What is asserted is what the contract promises: a write the computer answered is on the
// disk once the computer lets the folder go; a new claim takes the folder from a lower epoch, whose computer is gone;
// the token is nowhere a tool can read it; and, on one computer, a tool reaches no network while its writes reach the
// disk as each call returns.
//
// A synced folder has no disk of the provider's: the runner holds the copy (a SyncSink), pushes it in at the claim and
// lands each call's delta on it before the call answers (FolderSync under syncingClient). Its cases hold that copy in
// memory, as a runner would hold it, and check what the provider's computer gives the runner: a push restores modes and
// links, a change is on the copy before the call that made it answers, a delete reaches it, and a folder past a cap
// fails the call in words.
import { randomBytes } from "node:crypto";
import { pushTar } from "../../files.js";
import { EPOCH_LABEL, RUN_LABEL, runLabels as claimLabels } from "../../labels.js";
import { MOUNT_KINDS, type MountKind, type MountSpec, readBackOf, WORKSPACE } from "../../mount.js";
import { syncingClient } from "../../mount-archil.js";
import { type ComputerClient, type FileEntry, MAX_LIST_DEPTH, MAX_OUTPUT_BYTES } from "../../protocol.js";
import type { ComputerRef, ComputerSpec } from "../../provider.js";
import { ok, type Result } from "../../result.js";
import { type FolderMeta, FolderSync, SYNC_MAX_ENTRIES, type SyncSink } from "../../sync-folder.js";
import { type TarEntry, tarStream } from "../../tar.js";
import type { Case, CaseContext, RunFolder } from "../types.js";
import { assertIsolated, assertRootRunsClosed } from "./isolation.js";
import { b64, CASE_LABEL, decode } from "./util.js";

/** The claim epoch the run-folder cases make their computers under. */
const EPOCH = 1;

const mount = (name: string, run: Case["run"], extra: Partial<Case> = {}): Case => ({
	id: `mount.${name}`,
	level: "full",
	group: "mount",
	needs: [],
	computer: "none",
	run,
	...extra,
});

/** Fails the case when what was read back holds the Archil token; the words never print it. */
function tokenless(t: CaseContext, asked: MountSpec, read: unknown, what: string) {
	if (asked.kind === "archil") t.assert(!JSON.stringify(read ?? null).includes(asked.token), `${what} holds the Archil token`);
}

/**
 * The labels of a computer that mounts `folder` under `epoch`, for the folder's own run: the run it says, else the
 * <run> of an Archil folder agents/<agent>/runs/<run>/work (every remote provider refuses a folder of another run than
 * the agentrun.run label), else a fresh one.
 */
function labelsFor(t: CaseContext, folder: RunFolder, epoch: number, name: string): Record<string, string> {
	const ofFolder = folder.mount.kind === "archil" ? /^agents\/[^/]+\/runs\/([^/]+)\/work$/.exec(folder.mount.folder)?.[1] : undefined;
	return { ...t.runLabels, ...claimLabels(folder.run ?? ofFolder ?? `mount-${randomBytes(6).toString("hex")}`, epoch), [CASE_LABEL]: name };
}

/** A computer made with the folder's mount under `epoch`, and `extra` (a GPU case's gpu), after check() takes it; and its
 *  read-back, checked. */
export async function mounted(t: CaseContext, folder: RunFolder, epoch: number, name: string, extra: Partial<ComputerSpec> = {}): Promise<{ ref: ComputerRef; labels: Record<string, string> }> {
	const asked = folder.mount;
	const labels = labelsFor(t, folder, epoch, name);
	const spec = t.spec({ labels, mount: asked, ...extra });
	const refusals = t.provider.check(spec);
	tokenless(t, asked, refusals, "check's refusal of a spec that mounts the run's folder");
	// A provider that declares the kind but whose host cannot give it (a Docker host that remaps user ids, for a bind)
	// fails here in its own words: it declared what this host does not do.
	t.assert(
		refusals.length === 0,
		`check refuses a spec that mounts the run's folder of kind ${asked.kind}, which the provider declares: ${refusals.map(({ field, message }) => `${field}: ${message}`).join("; ")}`,
	);
	const ref = await t.create(spec);
	// The mount is read back from the computer, as asked, and no read-back holds the token.
	const attached = t.ok(await t.provider.attach({ id: ref.id }), "attach by id");
	tokenless(t, asked, attached, "attach by id: the mount it reads back");
	t.deepEqual(attached.spec?.mount, readBackOf(asked, epoch), "attach by id: the mount it reads back");
	const listed = t.ok(await t.provider.list(labels), "list");
	tokenless(t, asked, listed, "list: what it reads back of the computer");
	const info = t.present(
		listed.find((one) => one.ref.name === ref.name),
		`${ref.name} is listed by the case's labels`,
	);
	t.deepEqual(info.mount, readBackOf(asked, epoch), "list: the mount it reads back");
	return { ref, labels };
}

const text = (bytes: Uint8Array | undefined) => (bytes === undefined ? undefined : Buffer.from(bytes).toString("utf8"));

/** "mounts the run's folder" for one kind: on a computer of its own, made with a fresh run folder from the run. A synced
 *  folder's cases are the sync-* ones, below. */
const runFolder = (kind: Exclude<MountKind, "sync">): Case =>
	mount(
		`run-folder-${kind}`,
		async (t) => {
			const folder = await t.runFolder(kind);
			const asked = folder.mount;
			t.equal(asked.kind, kind, "the kind of the run folder's mount");
			const nonce = randomBytes(6).toString("hex");
			// Outside in, before the computer: a file written to the folder from outside is read at /workspace.
			const before = `before-${nonce}.txt`;
			const beforeText = `written outside before the computer ${nonce}\n`;
			await folder.write(before, Buffer.from(beforeText));
			// A folder made from outside too (a key ending in /), so the computer shows what owner and mode it was given.
			const madeDir = `dir-${nonce}`;
			if (kind === "archil") await folder.write(`${madeDir}/`, new Uint8Array());
			const { ref } = await mounted(t, folder, EPOCH, `mount-${kind}`);
			const connected = await t.connect(ref);
			if (kind === "archil") {
				// Recorded, not asserted: the owner and mode a tool (agentrun-tool, 2510) writes against.
				for (const [what, path] of [["a file", before], ["a folder", madeDir]]) {
					const stat = await connected.client.call("files.stat", { path: `${WORKSPACE}/${path}` });
					t.observe(`${what} the file API made, seen at ${WORKSPACE}: ${stat.ok ? `uid ${stat.value.uid}, gid ${stat.value.gid}, mode ${(stat.value.mode & 0o7777).toString(8)}` : `not stated (${stat.error.code}: ${stat.error.message})`}`);
				}
			}
			const read = await t.call("files.read", { path: `${WORKSPACE}/${before}` }, connected.client);
			t.equal(decode(read.data), beforeText, `files.read of ${WORKSPACE}/${before}, a file written outside before the computer`);

			// Outside in, while the computer holds the folder.
			const outside = `outside-${nonce}.txt`;
			const outsideText = `written outside the computer ${nonce}\n`;
			// An Archil computer holds the folder exclusively, so its disk may refuse the write (409, another client holds a
			// write delegation): that is recorded, never a failure. A bind has no such hold, and its write must land.
			const refused = kind === "archil" ? await folder.write(outside, Buffer.from(outsideText)).then(() => undefined, (error: unknown) => (error instanceof Error ? error.message : String(error))) : await folder.write(outside, Buffer.from(outsideText));
			if (typeof refused === "string") t.observe(`outside in, while held: the file API's write was refused: ${refused.replace(/\s+/g, " ").slice(0, 300)}`);
			else {
				const seen = await connected.client.call("files.read", { path: `${WORKSPACE}/${outside}` });
				const seenText = seen.ok ? decode(seen.value.data) : undefined;
				if (kind === "archil") t.observe(`outside in, while held: a file the file API wrote is ${seenText === outsideText ? "read at /workspace as written" : seen.ok ? "read at /workspace with other bytes" : `not read at /workspace (${seen.error.code})`}`);
				else t.equal(seenText, outsideText, `files.read of ${WORKSPACE}/${outside}, a file written outside the computer`);
			}

			// Inside out: a file files.write makes at /workspace is in the folder outside.
			const inside = `inside-${nonce}.txt`;
			const insideText = `written inside the computer ${nonce}\n`;
			t.ok(await connected.client.call("files.write", { path: `${WORKSPACE}/${inside}`, data: b64(insideText) }), `files.write of ${WORKSPACE}/${inside}`);
			const back = text(await folder.read(inside));
			if (kind === "archil") t.observe(`inside out, while held: a file files.write made (synced before it answered) is ${back === insideText ? "read through the file API as written" : back === undefined ? "not found through the file API" : "read through the file API with other bytes"}`);
			else t.equal(t.present(back, `the file files.write made at ${WORKSPACE}/${inside}, read outside the computer`), insideText, `${inside} read outside the computer`);

			// A program run with cwd /workspace sees the folder: a relative path reaches the file written outside.
			const ran = await t.exec(["cat", before], { cwd: WORKSPACE }, connected.client);
			t.equal(ran.exitCode, 0, `cat ${before} run with cwd ${WORKSPACE}: its exit code (${ran.err.trim()})`);
			t.equal(ran.out, beforeText, `cat ${before} run with cwd ${WORKSPACE}: what it printed`);
		},
		{ needs: [`mount:${kind}`, "exec", "files"] },
	);

/** "a write the computer answered is on the disk": written inside, the computer released, then read outside. */
const archilDurable = mount(
	"archil-durable",
	async (t) => {
		const folder = await t.runFolder("archil");
		const { ref } = await mounted(t, folder, EPOCH, "mount-archil-durable");
		const connected = await t.connect(ref);
		const nonce = randomBytes(6).toString("hex");
		const name = `durable-${nonce}.txt`;
		const body = `written inside, then the computer released ${nonce}\n`;
		t.ok(await connected.client.call("files.write", { path: `${WORKSPACE}/${name}`, data: b64(body) }), `files.write of ${WORKSPACE}/${name}`);
		const ran = await t.exec(["sh", "-c", `printf '%s\\n' ${nonce} > exec-${nonce}.txt`], { cwd: WORKSPACE }, connected.client);
		t.equal(ran.exitCode, 0, `a program's write at ${WORKSPACE}: its exit code (${ran.err.trim()})`);
		await connected.close();
		t.ok(await t.provider.release(ref, "delete"), `release of ${ref.name}`);
		t.equal(text(await folder.read(name)), body, `${name}, written by files.write, read outside once the computer is released`);
		t.equal(text(await folder.read(`exec-${nonce}.txt`)), `${nonce}\n`, `exec-${nonce}.txt, written by a program, read outside once the computer is released`);
	},
	{ needs: ["mount:archil", "exec", "files"], timeoutMs: 600_000 },
);

/** "a new claim takes the folder": epoch 1 writes, epoch 2 of the same run is made, epoch 1 is gone and 2 holds it. */
const archilTakeover = mount(
	"archil-takeover",
	async (t) => {
		const folder = await t.runFolder("archil");
		const first = await mounted(t, folder, EPOCH, "mount-archil-takeover-1");
		const one = await t.connect(first.ref);
		const nonce = randomBytes(6).toString("hex");
		const name = `epoch-1-${nonce}.txt`;
		t.ok(await one.client.call("files.write", { path: `${WORKSPACE}/${name}`, data: b64(nonce) }), `files.write by the epoch ${EPOCH} computer`);
		await one.close();
		const second = await mounted(t, folder, EPOCH + 1, "mount-archil-takeover-2");
		t.equal(second.labels[RUN_LABEL], first.labels[RUN_LABEL], "both computers are the same run's");
		t.equal(second.labels[EPOCH_LABEL], String(EPOCH + 1), "the second is the higher epoch's");
		const gone = await t.provider.attach({ id: first.ref.id });
		t.assert(!gone.ok && gone.error.code === "not_found", `the epoch ${EPOCH} computer is gone after the epoch ${EPOCH + 1} create: ${gone.ok ? "it is still there" : gone.error.message}`);
		const two = await t.connect(second.ref);
		const read = await t.call("files.read", { path: `${WORKSPACE}/${name}` }, two.client);
		t.equal(decode(read.data), nonce, `the epoch ${EPOCH + 1} computer reads what the epoch ${EPOCH} one wrote`);
	},
	{ needs: ["mount:archil", "exec", "files"], timeoutMs: 600_000 },
);

/** "the tool user never has the token": not in any process's environment or arguments a tool can read, nor sudo. */
const archilToken = mount(
	"archil-token",
	async (t) => {
		const folder = await t.runFolder("archil");
		const asked = folder.mount as Extract<MountSpec, { kind: "archil" }>;
		const { ref } = await mounted(t, folder, EPOCH, "mount-archil-token");
		const connected = await t.connect(ref);
		// What a tool can read of every process: its own and any other it sees (hidepid hides root's), and its own files.
		const seen = await t.exec(
			["sh", "-c", 'for f in /proc/[0-9]*/environ /proc/[0-9]*/cmdline; do cat "$f" 2>/dev/null; echo; done; env; ls -la /proc | wc -l; ls -A /tmp /run 2>/dev/null'],
			{ maxOutput: MAX_OUTPUT_BYTES },
			connected.client,
		);
		// Every byte is read, or the case fails saying so: a cut output proves nothing about the bytes it dropped.
		t.assert(!seen.truncated, `what a tool reads of every process came to more than the ${MAX_OUTPUT_BYTES} bytes exec.run keeps, so the token check did not see all of it`);
		t.assert(!seen.out.includes(asked.token) && !seen.err.includes(asked.token), "a tool reads the Archil token in some process's environment or arguments");
		const sudo = await t.exec(["sh", "-c", "sudo -n true"], {}, connected.client);
		t.assert(sudo.exitCode !== 0, "the tool user ran sudo");
	},
	{ needs: ["mount:archil", "exec"], timeoutMs: 600_000 },
);

/**
 * "isolated, and durable through the root side", on one Archil computer: a tool sees loopback alone and reaches neither a
 * vendor's agent nor any address, and can write nothing root runs; and a tool's write in /workspace, by a program (exec.run) and by files.write, is read
 * through the disk's file API right after the call returns, with no checkin. So the per-call sync goes out from the
 * archil client and serve, which run as root outside the tools' namespace.
 */
const archilIsolatedDurable = mount(
	"archil-isolated-durable",
	async (t) => {
		const folder = await t.runFolder("archil");
		const { ref } = await mounted(t, folder, EPOCH, "mount-archil-isolated-durable");
		const connected = await t.connect(ref);
		// isolation.vendor-agent's own check, on this Archil computer: lo alone, refused at the vendor's agent and outside,
		// and no unix socket a tool connects to but the computer's own (computerd's, the sync socket).
		await assertIsolated(t, connected.client);
		// isolation.root-runs' check too, where the Archil helper and client are there to check.
		await assertRootRunsClosed(t, connected.client);
		const nonce = randomBytes(6).toString("hex");
		const ran = await t.exec(["sh", "-c", `printf '%s\\n' ${nonce} > exec-${nonce}.txt`], { cwd: WORKSPACE }, connected.client);
		t.equal(ran.exitCode, 0, `a program's write at ${WORKSPACE}: its exit code (${ran.err.trim()})`);
		t.equal(text(await folder.read(`exec-${nonce}.txt`)), `${nonce}\n`, `exec-${nonce}.txt, written by a program, read through the file API right after exec.run returned`);
		const body = `written by files.write ${nonce}\n`;
		t.ok(await connected.client.call("files.write", { path: `${WORKSPACE}/write-${nonce}.txt`, data: b64(body) }), "files.write");
		t.equal(text(await folder.read(`write-${nonce}.txt`)), body, `write-${nonce}.txt, written by files.write, read through the file API right after it returned`);
	},
	{ needs: ["mount:archil", "exec", "files"], timeoutMs: 600_000 },
);

/** What the tool runs: the line ($1) appended to the file ($2), as the computer's user, with no shell quoting of either. */
const APPEND = 'printf "%s\\n" "$1" >> "$2"';

/**
 * Mode 2's promise: the loop writes a file through the disk's file API, a tool edits it, and the loop reads the edit
 * back. The file is written before the computer mounts the folder (the disk refuses outside writes while it is held);
 * the tool, the computer's user, appends to it, and must be able to; the loop's read while the folder is held is
 * recorded, and once the computer is released the file must read back as the loop's text with the tool's line.
 */
const archilLoopToolEdit = mount(
	"archil-loop-tool-edit",
	async (t) => {
		const folder = await t.runFolder("archil");
		const nonce = randomBytes(6).toString("hex");
		const name = `loop-${nonce}.txt`;
		const path = `${WORKSPACE}/${name}`;
		const loopText = `written by the loop through the file API ${nonce}\n`;
		await folder.write(name, Buffer.from(loopText));
		const { ref } = await mounted(t, folder, EPOCH, "mount-archil-loop-tool-edit");
		const connected = await t.connect(ref);
		const stat = await connected.client.call("files.stat", { path });
		t.observe(`the file the loop wrote, seen at ${WORKSPACE} before the tool's edit: ${stat.ok ? `uid ${stat.value.uid}, gid ${stat.value.gid}, mode ${(stat.value.mode & 0o7777).toString(8)}` : `not stated (${stat.error.code}: ${stat.error.message})`}`);
		const line = `edited by a tool ${nonce}`;
		const ran = await t.exec(["sh", "-c", APPEND, "sh", line, path], {}, connected.client);
		t.assert(ran.exitCode === 0, `a tool (the computer's user) could not edit ${path}, which the file API made: exit ${ran.exitCode}: ${ran.err.trim().slice(0, 300)}`);
		const want = `${loopText}${line}\n`;
		const held = await folder.read(name).then(
			(bytes) => (text(bytes) === want ? "the tool's edit, as written" : bytes === undefined ? "not found" : "other bytes"),
			(error: unknown) => `refused: ${(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300)}`,
		);
		t.observe(`the loop's read while the computer holds the folder: ${held}`);
		await connected.close();
		t.ok(await t.provider.release(ref, "delete"), `release of ${ref.name}`);
		t.equal(text(await folder.read(name)), want, `${name}: the loop's text with the tool's line, read through the file API once the computer is released`);
	},
	{ needs: ["mount:archil", "exec", "files"], timeoutMs: 600_000 },
);

/** The runner's copy of a synced folder, in memory: its files, its empty directories, its modes and links, and each
 *  write in order ("put a", "remove a", ...). */
class CopySink implements SyncSink {
	readonly files = new Map<string, Uint8Array>();
	readonly dirs = new Set<string>();
	kept: FolderMeta = { modes: {}, links: {} };
	readonly writes: string[] = [];
	async put(path: string, body: Uint8Array): Promise<Result<void>> {
		this.writes.push(`put ${path}`);
		this.files.set(path, body);
		return ok(undefined);
	}
	async mkdir(path: string): Promise<Result<void>> {
		this.writes.push(`mkdir ${path}`);
		this.dirs.add(path);
		return ok(undefined);
	}
	async remove(path: string, type: "file" | "dir"): Promise<Result<void>> {
		this.writes.push(`remove ${path}`);
		if (type === "file") this.files.delete(path);
		else this.dirs.delete(path);
		return ok(undefined);
	}
	async meta(meta: FolderMeta): Promise<Result<void>> {
		this.writes.push("meta");
		this.kept = meta;
		return ok(undefined);
	}
}

/**
 * A computer made with a synced folder, its copy `entries` held by the runner and pushed into /workspace as one tar
 * (none: an empty folder), the computer's listing read as the manifest, and its client under syncingClient, as a runner
 * hands it to the tools: each call that may change the folder answers once its delta is on the copy.
 */
async function synced(t: CaseContext, name: string, entries: readonly TarEntry[] = []): Promise<{ copy: CopySink; client: ComputerClient; own: ComputerClient; folder: FolderSync }> {
	const copy = new CopySink();
	for (const entry of entries) {
		if (entry.type === "file") copy.files.set(entry.name, entry.body ?? new Uint8Array());
		else if (entry.type === "dir" && !entries.some((other) => other.name.startsWith(`${entry.name}/`))) copy.dirs.add(entry.name);
	}
	const kept: RunFolder = {
		mount: { kind: "sync" },
		read: async (path) => copy.files.get(path),
		write: async (path, data) => void copy.files.set(path, data),
		close: async () => {},
	};
	const { ref } = await mounted(t, kept, EPOCH, name);
	const connected = await t.connect(ref);
	if (entries.length > 0) t.ok(await pushTar(connected.client, WORKSPACE, tarStream(entries)), `tar.push of the run's folder into ${WORKSPACE}`);
	const folder = new FolderSync(connected.client, copy);
	t.ok(await folder.baseline(), `files.list of ${WORKSPACE} pushed in, as the manifest`);
	const client = syncingClient(connected.client, async () => {
		const done = await folder.sync();
		return done.ok ? ok(undefined) : done;
	});
	return { copy, client, own: connected.client, folder };
}

/** /workspace as files.list gives it, by path relative to it. */
async function listed(t: CaseContext, client: ComputerClient): Promise<Map<string, FileEntry>> {
	const page = await t.call("files.list", { path: WORKSPACE, depth: MAX_LIST_DEPTH }, client);
	return new Map(page.entries.map((entry) => [entry.path.slice(WORKSPACE.length + 1), entry]));
}

const SYNC_NEEDS: Case["needs"] = ["mount:sync", "exec", "files"];

/** "on the copy before the answer": a program's write, a files.write and a new tree land before their call answers. */
const syncDurable = mount(
	"sync-durable",
	async (t) => {
		const { copy, client } = await synced(t, "mount-sync-durable");
		const nonce = randomBytes(6).toString("hex");
		const ran = await t.exec(["sh", "-c", `printf '%s\\n' ${nonce} > exec-${nonce}.txt`], { cwd: WORKSPACE }, client);
		t.equal(ran.exitCode, 0, `a program's write at ${WORKSPACE}: its exit code (${ran.err.trim()})`);
		t.equal(text(copy.files.get(`exec-${nonce}.txt`)), `${nonce}\n`, `exec-${nonce}.txt, written by a program, on the runner's copy when exec.run answered`);
		const body = `written by files.write ${nonce}\n`;
		await t.call("files.write", { path: `${WORKSPACE}/write-${nonce}.txt`, data: b64(body) }, client);
		t.equal(text(copy.files.get(`write-${nonce}.txt`)), body, `write-${nonce}.txt, written by files.write, on the runner's copy when it answered`);
		// A new tree (npm install's node_modules), pulled as one tar, and an empty directory, with no bytes.
		const tree = await t.exec(["sh", "-c", `mkdir -p tree/a/b tree/empty && printf ${nonce} > tree/a/b/leaf`], { cwd: WORKSPACE }, client);
		t.equal(tree.exitCode, 0, `a program's new tree at ${WORKSPACE}: its exit code (${tree.err.trim()})`);
		t.equal(text(copy.files.get("tree/a/b/leaf")), nonce, "tree/a/b/leaf, in a tree a program made, on the runner's copy when exec.run answered");
		t.assert(copy.dirs.has("tree/empty"), `tree/empty, an empty directory a program made, is not on the runner's copy: ${copy.writes.join(", ")}`);
	},
	{ needs: SYNC_NEEDS },
);

/** "a push restores modes and links": the runner's copy pushed in reads back with its modes and its link, a program runs
 *  from it, and a sync after it writes nothing, since the copy holds it all. */
const syncPush = mount(
	"sync-push",
	async (t) => {
		const nonce = randomBytes(6).toString("hex");
		const entries: TarEntry[] = [
			{ name: "run.sh", type: "file", mode: 0o755, body: Buffer.from(`#!/bin/sh\necho ran ${nonce}\n`) },
			{ name: "empty", type: "dir", mode: 0o755 },
			{ name: "private", type: "dir", mode: 0o700 },
			{ name: "private/key.txt", type: "file", mode: 0o600, body: Buffer.from(nonce) },
			{ name: "link", type: "symlink", mode: 0o777, link: "run.sh" },
		];
		const { copy, client, own } = await synced(t, "mount-sync-push", entries);
		const seen = await listed(t, own);
		for (const { name, type, mode, link } of entries) {
			const entry = t.present(seen.get(name), `${name}, pushed in, listed at ${WORKSPACE}`);
			t.equal(entry.type, type, `${name}: its type`);
			if (link !== undefined) t.equal(entry.target, link, `${name}: the link's target, as pushed`);
			else t.equal((entry.mode & 0o7777).toString(8), mode.toString(8), `${name}: its mode, as pushed`);
		}
		const ran = await t.exec(["./run.sh"], { cwd: WORKSPACE }, client);
		t.equal(ran.out, `ran ${nonce}\n`, `./run.sh, pushed in with mode 755, run at ${WORKSPACE} (${ran.err.trim()})`);
		t.deepEqual(copy.writes, [], "what the sync after the push wrote to the runner's copy, which already holds the folder");
	},
	{ needs: SYNC_NEEDS },
);

/** "a delete reaches the copy": a file removed, a tree removed and a file moved, on the copy when the call answers; the
 *  moved file's new path put before its old one is removed. */
const syncDelete = mount(
	"sync-delete",
	async (t) => {
		const nonce = randomBytes(6).toString("hex");
		const file = (name: string): TarEntry => ({ name, type: "file", mode: 0o644, body: Buffer.from(`${name} ${nonce}`) });
		const { copy, client } = await synced(t, "mount-sync-delete", [file("gone.txt"), file("keep.txt"), file("move-me.txt"), { name: "dir", type: "dir", mode: 0o755 }, file("dir/a.txt"), { name: "dir/sub", type: "dir", mode: 0o755 }, file("dir/sub/b.txt")]);
		const ran = await t.exec(["sh", "-c", "rm gone.txt && rm -rf dir && mv move-me.txt moved.txt"], { cwd: WORKSPACE }, client);
		t.equal(ran.exitCode, 0, `rm, rm -rf and mv at ${WORKSPACE}: the exit code (${ran.err.trim()})`);
		t.deepEqual([...copy.files.keys()].sort(), ["keep.txt", "moved.txt"], "the files on the runner's copy when exec.run answered");
		t.equal(text(copy.files.get("moved.txt")), `move-me.txt ${nonce}`, "moved.txt: the moved file's bytes");
		t.deepEqual([...copy.dirs], [], "the empty directories on the runner's copy");
		t.assert(copy.writes.indexOf("put moved.txt") < copy.writes.indexOf("remove move-me.txt"), `the moved file is put at its new path before its old one is removed: ${copy.writes.join(", ")}`);
		t.assert(copy.writes.indexOf("remove dir/sub/b.txt") < copy.writes.indexOf("remove dir/sub") && copy.writes.indexOf("remove dir/sub") < copy.writes.indexOf("remove dir"), `a tree is removed deepest first: ${copy.writes.join(", ")}`);
	},
	{ needs: SYNC_NEEDS },
);

/** "a cap refuses": a folder grown past SYNC_MAX_ENTRIES fails the call that grew it, kind limit, in words naming the cap,
 *  and nothing past the cap reaches the copy. */
const syncCap = mount(
	"sync-cap",
	async (t) => {
		const { copy, client } = await synced(t, "mount-sync-cap");
		const grown = await client.call("exec.run", { argv: ["sh", "-c", `mkdir many && cd many && seq 1 ${SYNC_MAX_ENTRIES} | xargs touch`], cwd: WORKSPACE, timeoutMs: 120_000 });
		t.assert(!grown.ok, `exec.run that made ${SYNC_MAX_ENTRIES + 1} entries answered as if the folder were synced`);
		if (grown.ok) return;
		t.equal(grown.error.code, "limit", `the failure's code (${grown.error.message})`);
		t.equal(grown.error.message, `exec.run ran, but the run's folder could not be made durable: the run's folder holds more than ${SYNC_MAX_ENTRIES} entries, the most a synced folder holds`, "the failure's words");
		t.deepEqual(copy.writes, [], "what reached the runner's copy");
	},
	{ needs: SYNC_NEEDS, timeoutMs: 600_000 },
);

/** A mount of each kind the provider does not declare, with a token this case alone knows. */
function undeclaredMount(kind: MountKind, token: string): MountSpec {
	if (kind === "sync") return { kind };
	return kind === "bind" ? { kind, path: "/" } : { kind, disk: "conformance-disk", region: "conformance-region", folder: "agents/conformance/runs/r/work", token };
}

export const mountCases: Case[] = [
	runFolder("bind"),
	runFolder("archil"),
	archilDurable,
	archilTakeover,
	archilToken,
	archilIsolatedDurable,
	archilLoopToolEdit,
	syncDurable,
	syncPush,
	syncDelete,
	syncCap,
	mount("undeclared-kind", async (t) => {
		const declared = t.provider.capabilities().mount ?? [];
		const undeclared = MOUNT_KINDS.filter((kind) => !declared.includes(kind));
		if (undeclared.length === 0) t.skip(`the provider declares every mount kind (${MOUNT_KINDS.join(", ")})`);
		const token = `conformance-token-${randomBytes(12).toString("hex")}`;
		const labels = { ...t.runLabels, [CASE_LABEL]: "mount-undeclared" };
		for (const kind of undeclared) {
			const spec = t.spec({ labels, mount: undeclaredMount(kind, token) });
			const refusals = t.provider.check(spec);
			const words = `check refuses a mount of kind ${kind}, which the provider does not declare`;
			t.assert(!JSON.stringify(refusals).includes(token), `${words}: its refusal holds the Archil token`);
			t.assert(
				refusals.some((r) => r.field === "mount" && r.message !== ""),
				`${words}, in words: ${JSON.stringify(refusals)}`,
			);
			// create refuses it for what check() refuses, before any vendor call; a computer it makes anyway is deleted.
			const error = t.refused(await t.attempt(spec), `create with a mount of kind ${kind}`, ["refused"]);
			t.assert(!error.message.includes(token), `create's refusal of a mount of kind ${kind} holds the Archil token`);
			t.assert(
				refusals.some(({ message }) => error.message.includes(message)),
				`create's refusal of a mount of kind ${kind} names what check() refused (${refusals.map(({ field, message }) => `${field}: ${message}`).join("; ")}), not: ${error.message}`,
			);
		}
		const left = t.ok(await t.provider.list(labels), "list").map((info) => info.ref.name);
		t.deepEqual(left, [], "the computers the refused creates made");
	}),
];
