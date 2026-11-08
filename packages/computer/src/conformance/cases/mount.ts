// The run's folder: a computer made with a mount of a kind the provider declares has the folder at /workspace, so a file
// written outside shows inside, one written inside shows outside, and a program run there sees it; the mount reads back
// as asked, with no Archil token in any read-back. A kind the provider does not declare is refused by check() in words,
// before any vendor call. Every case is Full: optional for every kind of computer until the cutover decides.
import { randomBytes } from "node:crypto";
import { MOUNT_KINDS, type MountKind, type MountSpec, readBackOf, WORKSPACE } from "../../mount.js";
import type { Case, CaseContext } from "../types.js";
import { b64, CASE_LABEL, decode } from "./util.js";

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

/** "mounts the run's folder" for one kind: on a computer of its own, made with a fresh run folder from the run. */
const runFolder = (kind: MountKind): Case =>
	mount(
		`run-folder-${kind}`,
		async (t) => {
			const folder = await t.runFolder(kind);
			const asked = folder.mount;
			t.equal(asked.kind, kind, "the kind of the run folder's mount");
			const labels = { ...t.runLabels, [CASE_LABEL]: `mount-${kind}` };
			const spec = t.spec({ labels, mount: asked });
			const refusals = t.provider.check(spec);
			tokenless(t, asked, refusals, "check's refusal of a spec that mounts the run's folder");
			// A provider that declares the kind but whose host cannot give it (a Docker host that remaps user ids, for a bind)
			// fails here in its own words: it declared what this host does not do.
			t.assert(
				refusals.length === 0,
				`check refuses a spec that mounts the run's folder of kind ${kind}, which the provider declares: ${refusals.map(({ field, message }) => `${field}: ${message}`).join("; ")}`,
			);
			const ref = await t.create(spec);
			const connected = await t.connect(ref);

			// The mount is read back from the computer, as asked, and no read-back holds the token.
			const attached = t.ok(await t.provider.attach({ id: ref.id }), "attach by id");
			tokenless(t, asked, attached, "attach by id: the mount it reads back");
			t.deepEqual(attached.spec?.mount, readBackOf(asked), "attach by id: the mount it reads back");
			const listed = t.ok(await t.provider.list(labels), "list");
			tokenless(t, asked, listed, "list: what it reads back of the computer");
			const info = t.present(
				listed.find((one) => one.ref.name === ref.name),
				`${ref.name} is listed by the case's labels`,
			);
			t.deepEqual(info.mount, readBackOf(asked), "list: the mount it reads back");

			// Outside in: a file written to the folder from outside is read at /workspace.
			const nonce = randomBytes(6).toString("hex");
			const outside = `outside-${nonce}.txt`;
			const outsideText = `written outside the computer ${nonce}\n`;
			await folder.write(outside, Buffer.from(outsideText));
			const read = await t.call("files.read", { path: `${WORKSPACE}/${outside}` }, connected.client);
			t.equal(decode(read.data), outsideText, `files.read of ${WORKSPACE}/${outside}, a file written outside the computer`);

			// Inside out: a file files.write makes at /workspace is in the folder outside.
			const inside = `inside-${nonce}.txt`;
			const insideText = `written inside the computer ${nonce}\n`;
			t.ok(await connected.client.call("files.write", { path: `${WORKSPACE}/${inside}`, data: b64(insideText) }), `files.write of ${WORKSPACE}/${inside}`);
			const back = t.present(await folder.read(inside), `the file files.write made at ${WORKSPACE}/${inside}, read outside the computer`);
			t.equal(Buffer.from(back).toString("utf8"), insideText, `${inside} read outside the computer`);

			// A program run with cwd /workspace sees the folder: a relative path reaches the file written outside.
			const ran = await t.exec(["cat", outside], { cwd: WORKSPACE }, connected.client);
			t.equal(ran.exitCode, 0, `cat ${outside} run with cwd ${WORKSPACE}: its exit code (${ran.err.trim()})`);
			t.equal(ran.out, outsideText, `cat ${outside} run with cwd ${WORKSPACE}: what it printed`);
		},
		{ needs: [`mount:${kind}`, "exec", "files"] },
	);

/** A mount of each kind the provider does not declare, with a token this case alone knows. */
function undeclaredMount(kind: MountKind, token: string): MountSpec {
	return kind === "bind" ? { kind, path: "/" } : { kind, disk: "conformance-disk", folder: "runs/conformance", token };
}

export const mountCases: Case[] = [
	runFolder("bind"),
	runFolder("archil"),
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
