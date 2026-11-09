// The Archil mount in a remote computer (Daytona, Modal, E2B): the run's folder on the owner's Archil disk at
// /workspace, exclusive, through the root helper the image ships (box/agentrun-archil). The provider runs the helper as
// root through its own exec (its ArchilRoot), never through computerd; computerd runs every tool as the tool user, which
// has no way to root and never holds the disk's token. What each provider shares lives here: the spec rule, the steps
// at create, the syncing client, the read-back, the mount's label and the release. Only the root channel is a
// provider's own.
//
// The token reaches only the helper's fd 0 (ArchilRoot.run's stdin, for mount and revoke): never an argument, a label,
// a read-back or an error. Whatever a computer prints is scrubbed of it before it reaches an error's words.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { EPOCH_LABEL, epochOf, RUN_LABEL, runProblem } from "./labels.js";
import { type MountReadBack, type MountSpec, readBackOf, WORKSPACE } from "./mount.js";
import type { ComputerClient, DaemonMethod, DaemonMethods } from "./protocol.js";
import type { ComputerRef, ComputerSpec, Refusal } from "./provider.js";
import { type ComputerErrorCode, fail, ok, type Result } from "./result.js";

/** Where the image has the root helper, root:root 0755. */
export const ARCHIL_HELPER = "/usr/local/sbin/agentrun-archil";
/** The user computerd runs every tool as in a computer with an Archil mount: no sudo, no capability, no token. */
export const ARCHIL_TOOL_USER = "agentrun-tool";
/** The tool user's uid, and its gid: the image makes both 2510. */
export const ARCHIL_TOOL_UID = 2510;
/** The resident serve's socket (dir 0750 root:2510, socket 0660): one fixed byte asks for a sync, coalesced. It is not
 *  in computerd's own socket folder, /run/agentrun, which is the tool user's alone. */
export const ARCHIL_SYNC_SOCKET = "/run/agentrun-archil/archil.sock";
/** The archil client the image pins, the version the live checks ran. */
export const ARCHIL_VERSION = "0.10.1-1793222256";
/** The label (Daytona) or metadata (E2B) an Archil computer carries its mount in: kind and source, never the token. */
export const ARCHIL_MOUNT_LABEL = "agentrun.mount";

/** An Archil mount, as a spec gives it. */
export type ArchilMount = Extract<MountSpec, { kind: "archil" }>;

/**
 * A provider's own root channel into one of its computers: Daytona's toolbox exec, Modal's exec, E2B's commands as
 * root. run() runs argv as root, never through computerd, with `stdin` (one line, then closed) as its fd 0 when given,
 * bounded by timeoutMs and the signal; it answers the exit code and what it printed (both streams, cut). An error is the
 * channel's own (the call never ran, or its end was not seen), in words that never hold stdin.
 */
export interface ArchilRoot {
	run(argv: readonly string[], options: { stdin?: string; timeoutMs: number; signal?: AbortSignal }): Promise<Result<{ exitCode: number; output: string }>>;
}

/**
 * What a provider says, through its onNote option, that is no failure of the call it came from: a release whose final
 * sync or checkin did not let the run's folder go cleanly (no data is lost: every call that changed the folder synced
 * before it answered, and the run's next claim revokes a hold left behind). The computer, by name, and the words.
 */
export type ProviderNote = (note: { computer: string; note: string }) => void;

// The shapes the helper itself checks (box/agentrun-archil), so a spec it would refuse is refused before any vendor call.
const DISK = /^(?:dsk-[0-9a-f]{16}|[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
/**
 * The region's one rule: a provider, a dash and its region, lowercase letters, digits and dashes. A pattern string, so the
 * helper's `grep -Ex` (box/agentrun-archil, where it is written out the same) and this RegExp read the same text.
 */
export const ARCHIL_REGION = "[a-z0-9]+-[a-z0-9][a-z0-9-]{0,62}";
const REGION = new RegExp(`^${ARCHIL_REGION}$`);
const FOLDER = /^agents\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/runs\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/work$/;
const TOKEN = /^[A-Za-z0-9._~+/=-]{16,4096}$/;

/**
 * The Archil rule every provider's check() adds to checkMount's, with no vendor call: network "none" (the tools have no
 * network: init's own namespace, loopback alone), the run's agentrun.run and agentrun.epoch labels (the claim the mount is made
 * under), a disk, region and folder of the helper's shapes, the folder of the labelled run, and a token of a disk
 * token's shape. No word holds a value of the mount but the folder's run, and only once the folder has the folder's shape.
 */
export function archilRefusals(spec: ComputerSpec): Refusal[] {
	const mount = spec.mount as Record<string, unknown> | undefined;
	if (mount?.kind !== "archil") return [];
	const found: Refusal[] = [];
	const refuse = (field: string, message: string) => found.push({ field, message });
	if (spec.network !== "none") refuse("network", 'a computer with an Archil mount takes network "none": its tools have no network, only loopback in init\'s own namespace');
	const labels = spec.labels ?? {};
	const run = labels[RUN_LABEL];
	const runWrong = runProblem(run);
	if (runWrong !== undefined) refuse("labels", `an Archil mount is made for a run: the label ${RUN_LABEL} is required (${runWrong})`);
	const epoch = epochOf(labels);
	if (!epoch.ok) refuse("labels", `an Archil mount is made under the run's claim epoch: the label ${EPOCH_LABEL} is required (${epoch.error.message})`);
	const text = (value: unknown) => (typeof value === "string" ? value : "");
	if (!DISK.test(text(mount.disk))) refuse("mount", "mount.disk is a disk id (dsk- and 16 hex digits) or owner/name");
	if (!REGION.test(text(mount.region))) refuse("mount", "mount.region is a provider, a dash and its region, such as aws-us-east-1");
	const folder = FOLDER.exec(text(mount.folder));
	if (folder === null) refuse("mount", "mount.folder is agents/<agent>/runs/<run>/work, nothing else");
	else if (runWrong === undefined && folder[1] !== run) refuse("mount", `mount.folder is run ${folder[1]}'s folder, not the run this computer is labelled for (${RUN_LABEL})`);
	if (!TOKEN.test(text(mount.token))) refuse("mount", "mount.token is not a disk token: 16 to 4096 of letters, digits and ._~+/=-");
	return found;
}

/** The shortest run of a token's characters (in any of its forms) that scrub takes out. */
const TOKEN_CHUNK = 8;

/**
 * What a computer printed, with the token taken out in every form it may be echoed in (as written, base64, base64url,
 * URL-encoded, hex) and any run of TOKEN_CHUNK or more characters of one of them, then cut to a line's length.
 */
function scrub(text: string, token: string): string {
	if (token.length < TOKEN_CHUNK) return (token === "" ? text : text.replaceAll(token, "[token]")).trim().slice(0, 500);
	const bytes = Buffer.from(token);
	const forms = [token, bytes.toString("base64"), bytes.toString("base64").replace(/=+$/, ""), bytes.toString("base64url"), encodeURIComponent(token), bytes.toString("hex")];
	const windows = new Set<string>();
	for (const form of forms) for (let at = 0; at + TOKEN_CHUNK <= form.length; at++) windows.add(form.slice(at, at + TOKEN_CHUNK));
	// Every position a window of a form starts at is covered for the window's length; each covered run becomes one mark.
	const covered = new Array<boolean>(text.length).fill(false);
	for (let at = 0; at + TOKEN_CHUNK <= text.length; at++) {
		if (windows.has(text.slice(at, at + TOKEN_CHUNK))) covered.fill(true, at, at + TOKEN_CHUNK);
	}
	let out = "";
	for (let at = 0; at < text.length; at++) {
		if (!covered[at]) out += text[at];
		else if (at === 0 || !covered[at - 1]) out += "[token]";
	}
	return out.trim().slice(0, 500);
}

let shippedSha256: string | undefined;
/** The sha256 of the helper this package ships (box/agentrun-archil): the one an image must have. */
export function helperSha256(): string {
	shippedSha256 ??= createHash("sha256").update(readFileSync(new URL("../box/agentrun-archil", import.meta.url))).digest("hex");
	return shippedSha256;
}

/** Prints, as root, what create checks of the image before anything else runs: the channel's uid, the helper's sha256,
 *  mode and owner, the archil client's version, the tool user's ids, and whether there is a sudo. The helper is given
 *  back to root, 0755, first (a regular file, never through a link): a provider's template build may leave the copy's
 *  mode (E2B's left it 0777), and the sha256 read next proves it is the package's helper. */
const PREFLIGHT = [
	"# agentrun-computer: archil preflight",
	"h=$1",
	'[ -f "$h" ] && [ ! -L "$h" ] && chown root:root "$h" && chmod 0755 "$h"',
	'echo "uid $(id -u)"',
	"echo \"helper $(sha256sum \"$h\" 2>/dev/null | cut -c1-64) $(ls -ln \"$h\" 2>/dev/null | awk '{ print $1, $3, $4 }')\"",
	'echo "archil $(/usr/bin/archil --version 2>/dev/null | head -n 1)"',
	`echo "tool $(id -u ${ARCHIL_TOOL_USER} 2>/dev/null):$(id -g ${ARCHIL_TOOL_USER} 2>/dev/null)"`,
	'echo "sudo $(command -v sudo 2>/dev/null || echo none)"',
].join("\n");

/** How the preflight's words differ from the image the package ships, one line each; none when they do not. */
function preflightDrift(output: string, expectedSha: string): string[] {
	const lines = new Map<string, string>();
	for (const line of output.split("\n")) {
		const at = line.indexOf(" ");
		if (at > 0) lines.set(line.slice(0, at), line.slice(at + 1).trim());
	}
	const found: string[] = [];
	const show = (value: string | undefined) => JSON.stringify(value ?? "nothing");
	if (lines.get("uid") !== "0") found.push(`the provider's exec is not root (uid ${show(lines.get("uid"))}), so the helper cannot run`);
	const [sha, mode = "", owner, group] = (lines.get("helper") ?? "").split(/\s+/);
	if (sha !== expectedSha) found.push(`the helper at ${ARCHIL_HELPER} is not this package's (sha256 ${show(sha)}, not ${expectedSha})`);
	if (!/^-rwxr-xr-x\.?$/.test(mode) || owner !== "0" || group !== "0") found.push(`the helper at ${ARCHIL_HELPER} is not root:root 0755 (${show(`${mode} ${owner ?? ""}:${group ?? ""}`)})`);
	if (!(lines.get("archil") ?? "").includes(`v${ARCHIL_VERSION}`)) found.push(`the archil client is not ${ARCHIL_VERSION} (${show(lines.get("archil"))})`);
	if (lines.get("tool") !== `${ARCHIL_TOOL_UID}:${ARCHIL_TOOL_UID}`) found.push(`the tool user ${ARCHIL_TOOL_USER} is not ${ARCHIL_TOOL_UID}:${ARCHIL_TOOL_UID} (${show(lines.get("tool"))})`);
	if (lines.get("sudo") !== "none") found.push(`the image has sudo (${show(lines.get("sudo"))}), which gives the tool user a way to root`);
	return found;
}

/** What Archil answers a mount of a folder another client holds. */
const HELD = "has an outstanding delegation";

/** The helper's argv for a verb. */
function helper(verb: "mount" | "revoke" | "serve" | "checkin", mount?: ArchilMount): string[] {
	if (verb === "mount" || verb === "revoke") return [ARCHIL_HELPER, verb, mount!.disk, mount!.region, mount!.folder];
	return [ARCHIL_HELPER, verb];
}

export interface ArchilMountOptions {
	root: ArchilRoot;
	mount: ArchilMount;
	/** The computer being made, as list() reports it: among releaseOlder's kept, it is no other computer. */
	self: ComputerRef;
	/** The takeover's first step: releaseOlder of this provider for the run at the claim's epoch (janitor.ts). */
	releaseOlder: () => Promise<Result<{ released: ComputerRef[]; kept: ComputerRef[]; unproven: unknown[] }>>;
	/** The bound of each step in the computer. */
	timeoutMs: number;
	signal?: AbortSignal;
}

/**
 * The run's folder mounted at /workspace in a computer that exists and has computerd installed, before init starts: no
 * tool program runs before it. Each step runs as root through the provider's own exec, and each failure stops the next:
 *   1. preflight: the image is as the package's recipe makes it (root exec, the helper's sha256 and mode, archil's
 *      version, the tool user, no sudo);
 *   2. the takeover: every computer of the run with a lower epoch is released; one that could not be (or a higher epoch,
 *      fenced) stops here, and nothing is revoked;
 *   3. mount, with the token on fd 0; or revoke (mount --force) when the takeover released any, or the mount found the
 *      folder held by a client that no listing shows: a forced-off client's later writes are lost, which is the fence.
 *      Another computer of the run at the claim's own epoch is never forced off: while one is listed there is no
 *      revoke, and a held folder refuses in words;
 *   4. serve: the resident sync server, which holds no token.
 * The archil client and serve run in the computer's own network namespace, which reaches Archil; the tools' network is
 * init's own namespace, loopback alone (computerd init --own-network), so there is no firewall to set here.
 */
export async function archilMount({ root, mount, self: computer, releaseOlder, timeoutMs, signal }: ArchilMountOptions): Promise<Result<void>> {
	const step = async (argv: readonly string[], what: string, stdin?: string) => {
		const ran = await root.run(argv, { timeoutMs, ...(stdin === undefined ? {} : { stdin }), ...(signal ? { signal } : {}) });
		if (!ran.ok) return fail(ran.error.code, `archil ${what} in the computer could not run: ${scrub(ran.error.message, mount.token)}`);
		return ran;
	};
	const failed = (what: string, ran: { exitCode: number; output: string }, code: ComputerErrorCode = "refused") =>
		fail(code, `archil ${what} in the computer failed (exit ${ran.exitCode}): ${scrub(ran.output, mount.token)}`);

	const pre = await step(["sh", "-c", PREFLIGHT, "sh", ARCHIL_HELPER], "preflight");
	if (!pre.ok) return pre;
	const drift = preflightDrift(pre.value.output, helperSha256());
	if (pre.value.exitCode !== 0 || drift.length > 0) {
		return fail("refused", `the computer is not as the Archil image makes it: ${drift.length > 0 ? drift.join("; ") : `the preflight exited ${pre.value.exitCode}`}`);
	}
	const older = await releaseOlder();
	if (!older.ok) return fail(older.error.code, `the takeover could not release the run's lower epochs, so nothing was revoked or mounted: ${older.error.message}`);
	const twinsOf = (kept: ComputerRef[]) => kept.filter((ref) => ref.id !== computer.id).map((ref) => ref.name);
	const twins = twinsOf(older.value.kept);
	// Right before any force, the run's listing is read again: a higher epoch made since (two creates of one run
	// interleaving, this one lagging) fences it, and a twin made since stops it, so nothing is revoked from either.
	const beforeForce = async (): Promise<Result<void>> => {
		const again = await releaseOlder();
		if (!again.ok) return fail(again.error.code, `the run's computers, listed again right before the force, stop it, so nothing was revoked: ${again.error.message}`);
		const late = twinsOf(again.value.kept);
		if (late.length > 0) return fail("refused", `the run has ${late.join(", ")} at this claim's same epoch, listed right before the force: a create never forces off a computer of its own epoch, so nothing was revoked`);
		return ok(undefined);
	};
	const force = twins.length === 0 && (older.value.released.length > 0 || older.value.unproven.length > 0);
	if (force) {
		const checked = await beforeForce();
		if (!checked.ok) return checked;
	}
	let verb: "mount" | "revoke" = force ? "revoke" : "mount";
	let took = await step(helper(verb, mount), verb, `${mount.token}\n`);
	if (!took.ok) return took;
	if (verb === "mount" && took.value.exitCode !== 0 && took.value.output.includes(HELD) && twins.length > 0) {
		return fail("refused", `the run's folder is held, and the run has ${twins.join(", ")} at this claim's same epoch: a create never forces off a computer of its own epoch, so nothing was revoked; release that computer, or attach to it`);
	}
	if (verb === "mount" && took.value.exitCode !== 0 && took.value.output.includes(HELD)) {
		const checked = await beforeForce();
		if (!checked.ok) return checked;
		verb = "revoke";
		took = await step(helper(verb, mount), verb, `${mount.token}\n`);
		if (!took.ok) return took;
	}
	if (took.value.exitCode !== 0) return failed(verb, took.value);

	const served = await step(helper("serve"), "serve");
	if (!served.ok) return served;
	if (served.value.exitCode !== 0) return failed("serve", served.value);
	return ok(undefined);
}

/** The computerd calls that may change the folder: each syncs before it answers. */
const MUTATING = new Set<DaemonMethod>(["files.write", "files.move", "files.remove", "files.mkdir", "tar.push.begin", "tar.push.end", "exec.run", "process.start", "process.write", "process.signal", "process.wait"]);

/**
 * A computerd client whose every call that may change the folder (files.write, move, remove and mkdir; tar.push.begin,
 * which makes the destination and the folders above it, so a push never ended leaves none unsynced; tar.push.end, and
 * a tar.push.write that failed, which ends the push with no tar.push.end once its extraction stops; exec.run;
 * process.start, which makes its log and the folders above it; process.write and signal; a process seen
 * ended, by process.wait or a process.read that says so) syncs before it answers, through mount.sync, coalesced: a
 * call during a sync in flight waits for it, then shares one more. A failed sync fails the call in words; a call that
 * failed still syncs, and answers its own error. A caller whose signal fires stops waiting, answered "aborted" in words
 * (or its own error), while the shared sync goes on for every other caller. A tar.push.begin answered with such an error
 * instead of its id first ends the push it began, so no push slot is held by a push its caller cannot name.
 */
export function syncingClient(client: ComputerClient): ComputerClient {
	// At most one sync in flight, and at most one follower shared by every call that comes during it. The hand-over from a
	// run to its follower happens in one step, inside the run's own settling, so no call can land between them.
	let running: Promise<Result<void>> | undefined;
	let follower: { promise: Promise<Result<void>>; resolve: (run: Promise<Result<void>>) => void } | undefined;
	const once = async (): Promise<Result<void>> => {
		const synced = await client.call("mount.sync", {});
		if (!synced.ok) return fail(synced.error.code, synced.error.message);
		if (synced.value.exitCode !== 0) return fail("refused", `archil sync exited ${synced.value.exitCode}`);
		return ok(undefined);
	};
	const start = (): Promise<Result<void>> => {
		const now = once()
			.catch((error: unknown) => fail("refused", `archil sync could not be asked: ${error instanceof Error ? error.message : String(error)}`))
			.then((result) => {
				const next = follower;
				follower = undefined;
				running = next === undefined ? undefined : start();
				if (next !== undefined && running !== undefined) next.resolve(running);
				return result;
			});
		running = now;
		return now;
	};
	const sync = (): Promise<Result<void>> => {
		if (running === undefined) return start();
		if (follower === undefined) {
			let resolve: (run: Promise<Result<void>>) => void = () => {};
			const promise = new Promise<Result<void>>((settle) => {
				resolve = settle;
			});
			follower = { promise, resolve };
		}
		return follower.promise;
	};
	return {
		async call<M extends DaemonMethod>(method: M, params: DaemonMethods[M]["params"], options?: { signal?: AbortSignal }) {
			const result = await client.call(method, params, options);
			const ended = method === "process.read" && result.ok && (result.value as DaemonMethods["process.read"]["result"]).exited;
			// A push write that failed has ended the push (the daemon drops it once its extraction stops): no tar.push.end
			// will come to sync what it wrote before.
			const pushEnded = method === "tar.push.write" && !result.ok;
			if (!MUTATING.has(method) && !ended && !pushEnded) return result;
			// The sync is shared and goes on whatever this caller does; a caller whose signal fires stops waiting for it.
			const shared = sync();
			const signal = options?.signal;
			// A push begun whose caller gets an error instead of its id could never be ended, and would hold one of the
			// connection's push slots for good: it is ended here, by its id, on the client beneath (no sync of its own), with
			// no signal, since the caller's may already have fired. Its end's own result changes nothing the caller is told.
			const beganPush = method === "tar.push.begin" && result.ok ? (result.value as DaemonMethods["tar.push.begin"]["result"]).id : undefined;
			const endBegun = async () => {
				if (beganPush !== undefined) await client.call("tar.push.end", { id: beganPush }).catch(() => undefined);
			};
			const stopped = async (): Promise<Result<never>> => {
				await endBegun();
				return fail("aborted", `${method} ran, but its caller stopped waiting for the sync that makes the run's folder durable; the sync goes on`);
			};
			if (signal?.aborted) return result.ok ? stopped() : result;
			const synced = signal === undefined ? await shared : await new Promise<Result<void> | "stopped">((resolve) => {
				const onAbort = () => resolve("stopped");
				signal.addEventListener("abort", onAbort, { once: true });
				shared.then((value) => {
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				});
			});
			if (synced === "stopped") return result.ok ? stopped() : result;
			if (!result.ok || synced.ok) return result;
			await endBegun();
			return fail(synced.error.code, `${method} ran, but the run's folder could not be made durable: ${synced.error.message}${beganPush === undefined ? "" : "; the push it began is ended"}`);
		},
		close: () => client.close(),
	};
}

/** The label an Archil computer carries its mount in: kind and source as JSON, never the token. */
export function archilLabels(mount: ArchilMount): Record<string, string> {
	return { [ARCHIL_MOUNT_LABEL]: JSON.stringify({ kind: "archil", disk: mount.disk, region: mount.region, folder: mount.folder }) };
}

/** The mount a computer's label records, as written; undefined when there is none, or it is not one. */
export function recordedMount(labels: Record<string, string> | undefined): Omit<ArchilMount, "token"> | undefined {
	const text = labels?.[ARCHIL_MOUNT_LABEL];
	if (text === undefined) return undefined;
	try {
		const value = JSON.parse(text) as Record<string, unknown> | null;
		const { kind, disk, region, folder } = value ?? {};
		if (kind !== "archil" || typeof disk !== "string" || typeof region !== "string" || typeof folder !== "string") return undefined;
		return { kind, disk, region, folder };
	} catch {
		return undefined;
	}
}

/**
 * What is mounted at /workspace, read back from the computer's mount table (`mounts`, its /proc/self/mounts): an Archil
 * mount (fuse.archil, source `<disk>:/<folder>`, with `[<region>]` when the client shows it, else the recorded region)
 * under `epoch`, the computer's agentrun.epoch label, exclusive when the resident serve answered (`served`); anything
 * else at /workspace in words; undefined when nothing is mounted there.
 */
export function archilReadBack({ mounts, epoch, served, recorded }: { mounts: string; epoch: number | undefined; served: boolean; recorded?: Omit<ArchilMount, "token"> }): MountReadBack | undefined {
	const unescape = (field: string) => field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
	const at = mounts
		.split("\n")
		.map((line) => line.split(" ").map(unescape))
		.filter(([, mountpoint]) => mountpoint === WORKSPACE)
		.at(-1);
	if (at === undefined) return undefined;
	const [source = "", , type = ""] = at;
	if (type !== "fuse.archil") return { other: `a ${type} mount of ${source} at ${WORKSPACE}, not an Archil mount` };
	const parsed = /^(.+?):\/(.+?)(?:\[([a-z0-9-]+)\])?$/.exec(source);
	if (parsed === null) return { other: `an Archil mount at ${WORKSPACE} whose source ${source} is not <disk>:/<folder>` };
	const [, disk = "", folder = "", shown] = parsed;
	const region = shown ?? recorded?.region;
	if (region === undefined) return { other: `an Archil mount of ${disk}:/${folder} whose region neither the mount table nor a label shows` };
	const read = readBackOf({ kind: "archil", disk, region, folder, token: "" }, epoch);
	return "kind" in read && read.kind === "archil" ? { ...read, exclusive: served } : read;
}

/** What Archil answers a checkin by a client that holds no delegation there: EROFS (30), measured on 0.10.1. */
const CHECKED_IN = /'checkin' operation failed .*Unexpected error \(30\)/;

/**
 * The folder let go at release: a final sync through computerd (when the computer still answers), then checkin as root,
 * which takes serve's socket away first. Nothing mounted (the helper's exit 3), or a hold already forced off, is let go
 * already. A failed final sync is said, since writes after the last sync may be lost, and checkin still runs; the caller
 * deletes the computer whatever this answers.
 */
export async function archilRelease({ root, client, timeoutMs, signal }: { root: ArchilRoot; client: ComputerClient | undefined; timeoutMs: number; signal?: AbortSignal }): Promise<Result<void>> {
	let syncWords: string | undefined;
	if (client !== undefined) {
		const synced = await client.call("mount.sync", {}, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
		if (!synced.ok) syncWords = synced.error.message;
		else if (synced.value.exitCode !== 0) syncWords = `archil sync exited ${synced.value.exitCode}`;
	}
	const checkin = await root.run(helper("checkin"), { timeoutMs, ...(signal ? { signal } : {}) });
	const checkinWords = !checkin.ok
		? `checkin could not run: ${checkin.error.message}`
		: checkin.value.exitCode === 0 || checkin.value.exitCode === 3 || (checkin.value.exitCode === 1 && CHECKED_IN.test(checkin.value.output))
			? undefined
			: `checkin failed (exit ${checkin.value.exitCode}): ${checkin.value.output.trim().slice(0, 300)}`;
	if (syncWords === undefined && checkinWords === undefined) return ok(undefined);
	const words = [syncWords === undefined ? undefined : `the final sync failed (${syncWords}), so writes since the last sync may be lost`, checkinWords].filter(Boolean);
	return fail(checkin.ok ? "refused" : checkin.error.code, `the run's folder was not let go cleanly: ${words.join("; ")}`);
}

/** An Archil mount a computer records (a label, a tag), and what it must read back as under its epoch label. */
export interface RecordedArchil {
	/** The source as recorded; none when what is recorded is not a mount this provider makes. */
	mount?: Omit<ArchilMount, "token">;
	/** The computer's agentrun.epoch label, when it reads as one. */
	epoch?: number;
	/** What the mount must read back as: readBackOf under the label's epoch, or a mount in words. */
	expected: MountReadBack;
}

/**
 * The Archil mount a computer records, from what its provider read of it (`recorded`: the mount, and words when what is
 * recorded is not one this provider makes, or not under the label's epoch; undefined for none at all), under the epoch
 * of its `labels`.
 */
export function recordedArchil(labels: Record<string, string> | undefined, recorded: { mount?: Omit<ArchilMount, "token">; other?: string } | undefined): RecordedArchil | undefined {
	if (recorded === undefined) return undefined;
	const read = epochOf(labels);
	const epoch = read.ok ? { epoch: read.value } : {};
	const mount = recorded.mount === undefined ? {} : { mount: recorded.mount };
	if (recorded.other !== undefined || recorded.mount === undefined) return { ...mount, ...epoch, expected: { other: recorded.other ?? "a mount this provider never makes" } };
	return { mount: recorded.mount, ...epoch, expected: readBackOf({ ...recorded.mount, token: "" }, epoch.epoch) };
}

/** A mount read-back in words. */
export function mountWords(mount: MountReadBack): string {
	if ("other" in mount) return mount.other;
	if (mount.kind === "bind") return `a bind of ${mount.path}`;
	return `archil ${mount.disk}:/${mount.folder} in ${mount.region}, ${mount.exclusive ? "exclusive" : "not exclusive"}, epoch ${mount.epoch}`;
}

/** How the mount read back from inside (undefined: nothing at /workspace) differs from the one expected, in words. */
export function mountDrift(expected: MountReadBack, read: MountReadBack | undefined): string[] {
	if ("other" in expected) return [`mount: ${expected.other}`];
	if (read === undefined) return [`mount: declared ${mountWords(expected)}, yet nothing is mounted at ${WORKSPACE}`];
	const same =
		!("other" in read) &&
		read.kind === expected.kind &&
		(read.kind === "bind"
			? expected.kind === "bind" && read.path === expected.path
			: expected.kind === "archil" &&
				read.disk === expected.disk &&
				read.region === expected.region &&
				read.folder === expected.folder &&
				read.exclusive === expected.exclusive &&
				read.epoch === expected.epoch);
	return same ? [] : [`mount: declared ${mountWords(expected)}, read back ${mountWords(read)}`];
}

/**
 * What a computer mounts at /workspace, read back through its computerd: its mount table, then whether the resident
 * serve answers a sync (exclusive), under `epoch`, the computer's label; each call bounded by timeoutMs and the signal.
 */
export async function readArchilMount(
	client: ComputerClient,
	{ mount, epoch }: Pick<RecordedArchil, "mount" | "epoch">,
	{ name, timeoutMs, signal }: { name: string; timeoutMs: number; signal?: AbortSignal },
): Promise<Result<MountReadBack | undefined>> {
	const bounded = () => (signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs));
	const table = await client.call("files.read", { path: "/proc/self/mounts" }, { signal: bounded() });
	if (!table.ok) {
		if (signal?.aborted) return fail("aborted", `reading the mount table in ${name} was aborted`);
		return fail(table.error.code === "aborted" ? "timeout" : table.error.code, `reading the mount table in ${name}: ${table.error.message}`);
	}
	const synced = await client.call("mount.sync", {}, { signal: bounded() });
	if (signal?.aborted) return fail("aborted", `the sync in ${name} was aborted`);
	const mounts = Buffer.from(table.value.data, "base64").toString("utf8");
	return ok(archilReadBack({ mounts, epoch, served: synced.ok && synced.value.exitCode === 0, ...(mount === undefined ? {} : { recorded: mount }) }));
}

/** The claim epoch of labels check() has held to it (archilRefusals): a caller's mistake otherwise, so it throws. */
export function claimEpoch(labels: Record<string, string> | undefined): number {
	const read = epochOf(labels);
	if (!read.ok) throw new TypeError(read.error.message);
	return read.value;
}
