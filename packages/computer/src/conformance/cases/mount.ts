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
import { randomBytes } from "node:crypto";
import { EPOCH_LABEL, RUN_LABEL, runLabels as claimLabels } from "../../labels.js";
import { MOUNT_KINDS, type MountKind, type MountSpec, readBackOf, WORKSPACE } from "../../mount.js";
import type { ComputerRef } from "../../provider.js";
import type { Case, CaseContext, RunFolder } from "../types.js";
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

/** A computer made with the folder's mount under `epoch`, after check() takes it; and its read-back, checked. */
async function mounted(t: CaseContext, folder: RunFolder, epoch: number, name: string): Promise<{ ref: ComputerRef; labels: Record<string, string> }> {
	const asked = folder.mount;
	const labels = labelsFor(t, folder, epoch, name);
	const spec = t.spec({ labels, mount: asked });
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

/** "mounts the run's folder" for one kind: on a computer of its own, made with a fresh run folder from the run. */
const runFolder = (kind: MountKind): Case =>
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
			await folder.write(outside, Buffer.from(outsideText));
			const seen = await connected.client.call("files.read", { path: `${WORKSPACE}/${outside}` });
			const seenText = seen.ok ? decode(seen.value.data) : undefined;
			if (kind === "archil") t.observe(`outside in, while held: a file the file API wrote is ${seenText === outsideText ? "read at /workspace as written" : seen.ok ? "read at /workspace with other bytes" : `not read at /workspace (${seen.error.code})`}`);
			else t.equal(seenText, outsideText, `files.read of ${WORKSPACE}/${outside}, a file written outside the computer`);

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
			{ maxOutput: 4 * 1024 * 1024 },
			connected.client,
		);
		t.assert(!seen.out.includes(asked.token) && !seen.err.includes(asked.token), "a tool reads the Archil token in some process's environment or arguments");
		const sudo = await t.exec(["sh", "-c", "sudo -n true"], {}, connected.client);
		t.assert(sudo.exitCode !== 0, "the tool user ran sudo");
	},
	{ needs: ["mount:archil", "exec"], timeoutMs: 600_000 },
);

/** Where a vendor's own agent listens in its computers: Daytona's toolbox, E2B's envd. */
const VENDOR_AGENTS = ["127.0.0.1:2280", "127.0.0.1:49983"];

/**
 * "isolated, and durable through the root side", on one Archil computer: a tool sees loopback alone and reaches neither a
 * vendor's agent nor any address; and a tool's write in /workspace, by a program (exec.run) and by files.write, is read
 * through the disk's file API right after the call returns, with no checkin. So the per-call sync goes out from the
 * archil client and serve, which run as root outside the tools' namespace.
 */
const archilIsolatedDurable = mount(
	"archil-isolated-durable",
	async (t) => {
		const folder = await t.runFolder("archil");
		const { ref } = await mounted(t, folder, EPOCH, "mount-archil-isolated-durable");
		const connected = await t.connect(ref);
		const links = await t.exec(["ls", "/sys/class/net"], {}, connected.client);
		t.equal(links.exitCode, 0, `ls /sys/class/net: its exit code (${links.err.trim()})`);
		t.deepEqual(links.out.split(/\s+/).filter(Boolean), ["lo"], "the network links a tool sees");
		const bash = await t.exec(["sh", "-c", "command -v bash"], {}, connected.client);
		t.equal(bash.exitCode, 0, "the image has bash, which the connection probes use");
		for (const target of [...VENDOR_AGENTS, "1.1.1.1:443", "8.8.8.8:53"]) {
			const [host, port] = target.split(":");
			const tried = await t.exec(["bash", "-c", `exec 3<>/dev/tcp/${host}/${port} && echo connected`], { timeoutMs: 15_000 }, connected.client);
			t.assert(!tried.out.includes("connected"), `a tool connected to ${target}`);
		}
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

/** A mount of each kind the provider does not declare, with a token this case alone knows. */
function undeclaredMount(kind: MountKind, token: string): MountSpec {
	return kind === "bind" ? { kind, path: "/" } : { kind, disk: "conformance-disk", region: "conformance-region", folder: "agents/conformance/runs/r/work", token };
}

export const mountCases: Case[] = [
	runFolder("bind"),
	runFolder("archil"),
	archilDurable,
	archilTakeover,
	archilToken,
	archilIsolatedDurable,
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
