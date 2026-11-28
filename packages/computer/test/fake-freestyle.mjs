// A fake Freestyle: a fetch that answers Freestyle's REST API (api.freestyle.sh/v5, the shapes of its OpenAPI) as far as
// the freestyle provider calls it: a VM's create (a slug unique in the account, metadata of at most 64 entries of at most
// 63 characters, a firewall required), its read by id or slug, the listing by metadata (comma-separated key:value pairs,
// every one matched) paged by limit and offset, its delete, exec-await, where a VM keeps the files its commands write
// and starts what its launch line starts, a VM's snapshot under a slug unique in the account, and a snapshot's read by id
// or slug. No network.

export const KEY = "fake-test-key-freestyle-not-a-secret";

export const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Freestyle's error body (O PublicErrorBody). */
const error = (status, code, message) => json(status, { code, message });

/** The nth VM's id, as Freestyle mints one (O VmId: vm-<uuid>). */
export const vmIdOf = (n) => `vm-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** O CreateVmRequest.slug: 1 to 63 of [a-z0-9-], no hyphen at either end or twice running. */
const SLUG = /^(?=.{1,63}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The box build's folder in the build VM, and what its detached install.sh writes there. */
const BUILD_DIR = "/tmp/agentrun-box";

/**
 * A command's effects as a Freestyle VM's exec-await would have them, as far as this provider's lines go: each
 * `printf %s '<base64>' | base64 -d > <path>` writes that file, `mv -f <a> <b>` moves one, `rm -rf <dir>` removes a
 * folder's files, `[ -f <path> ] || exit 3` exits 3 when the file is not there, `cat <path>` and `tail -c <n> <path>`
 * print one, a `setsid nohup` line of agentrun-dial's launch script starts it with the command's env (start(vm, script,
 * env) says what it does), and one of the box build's install.sh runs it (build(vm) answers its { exit, log }).
 */
function runLine(vm, command, env, start, build) {
	for (const [, b64, path] of command.matchAll(/printf %s '([A-Za-z0-9+/=]*)' \| base64 -d > (\S+)/g)) vm.files.set(path, Buffer.from(b64, "base64").toString("utf8"));
	for (const [, from, to] of command.matchAll(/mv -f (\S+) (\S+)/g)) {
		vm.files.set(to, vm.files.get(from));
		vm.files.delete(from);
	}
	for (const [, dir] of command.matchAll(/rm -rf (\S+)/g)) for (const path of [...vm.files.keys()]) if (path === dir || path.startsWith(`${dir}/`)) vm.files.delete(path);
	for (const [, path] of command.matchAll(/\[ -f (\S+) \] \|\| exit 3/g)) if (!vm.files.has(path)) return { stdout: "", stderr: "", statusCode: 3 };
	if (command.includes("setsid nohup") && command.includes("/run/agentrun-dial/launch")) {
		vm.files.delete("/run/agentrun-dial/exit");
		vm.files.set("/run/agentrun-dial/log", "");
		const script = vm.files.get("/run/agentrun-dial/launch");
		vm.starts.push({ script, env: { ...env } });
		start(vm, script, env);
	}
	if (command.includes("setsid nohup") && command.includes(`${BUILD_DIR}/install.sh`)) {
		vm.builds.push({ files: new Map(vm.files), env: { ...env }, command });
		const { exit = 0, log = "" } = build(vm) ?? {};
		vm.files.set(`${BUILD_DIR}/log`, log);
		if (exit !== undefined && exit !== null) vm.files.set(`${BUILD_DIR}/exit`, `${exit}\n`);
	}
	const read = /(?:^|; |&& )(?:cat|tail -c \d+) (\S+)$/.exec(command);
	return { stdout: read ? (vm.files.get(read[1]) ?? "") : "", stderr: "", statusCode: 0 };
}

/** The nth snapshot's id, as Freestyle mints one (O SnapshotId: sh-<uuid>). */
export const snapshotIdOf = (n) => `sh-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/**
 * A fake Freestyle account: its VMs by id, each walking `states` one GET at a time (its last held), every call kept.
 * `answer(method, path, body, { url, signal })` may answer a call first. `capacity` false answers every create 409, as
 * Freestyle does when it has no room. `filters` false answers a listing every VM, whatever metadata it asks, as a
 * vendor whose filter matches less than asked. `start(vm, script, env)` is what a launch's setsid line does, `build(vm)`
 * what the box build's install.sh does (its { exit, log }; exit null never ends). The account's snapshots are kept by
 * id (O Snapshot), `snapshots` the slugs it holds at first; a VM's snapshot keeps a copy of its files.
 */
export function fakeFreestyle({ states = ["running"], answer = () => undefined, start = () => undefined, build = () => undefined, capacity = true, filters = true, snapshots: slugs = [] } = {}) {
	const calls = [];
	const vms = new Map();
	const deleted = [];
	const snapshots = new Map();
	let made = 0;
	let shots = 0;
	const snapshot = (slug, vm) => {
		const id = snapshotIdOf(shots++);
		const record = { id, slug, createdAt: "2026-11-28T10:00:00Z", updatedAt: "2026-11-28T10:00:00Z", public: false, sourceVmId: vm?.record.id ?? null };
		snapshots.set(id, { record, files: new Map(vm?.files ?? []) });
		return record;
	};
	for (const slug of slugs) snapshot(slug);
	const find = (idOrSlug) => vms.get(idOrSlug) ?? [...vms.values()].find((vm) => vm.record.slug === idOrSlug);
	const findSnapshot = (idOrSlug) => snapshots.get(idOrSlug) ?? [...snapshots.values()].find((one) => one.record.slug === idOrSlug);
	const fetch = async (url, init = {}) => {
		const u = new URL(url);
		const body = init.body === undefined ? undefined : JSON.parse(init.body);
		calls.push({ method: init.method, url: u, headers: init.headers, body });
		if (init.headers?.Authorization !== `Bearer ${KEY}`) return error(401, "UNAUTHORIZED", "invalid API key");
		const path = u.pathname.replace(/^\/v5/, "");
		const said = await answer(init.method, path, body, { url: u, signal: init.signal });
		if (said !== undefined) return said;
		if (init.method === "POST" && path === "/vms") {
			if (body.firewall === undefined) return error(400, "BAD_REQUEST", "firewall is required");
			if (body.slug !== undefined && !SLUG.test(body.slug)) return error(400, "BAD_REQUEST", "invalid slug");
			const metadata = body.metadata ?? {};
			if (Object.keys(metadata).length > 64 || Object.entries(metadata).some(([key, value]) => key.length > 63 || value.length > 63)) return error(400, "BAD_REQUEST", "invalid metadata");
			if (!capacity) return error(409, "CONFLICT", "no capacity is available");
			if (body.slug !== undefined && find(body.slug)) return error(409, "CONFLICT", `slug ${body.slug} is already used by another VM`);
			const id = vmIdOf(made++);
			const record = {
				id,
				slug: body.slug ?? null,
				state: states[0],
				metadata: { ...metadata },
				createdAt: "2026-11-28T10:00:00Z",
				updatedAt: "2026-11-28T10:00:00Z",
				ttlSeconds: body.ttlSeconds ?? null,
				autoDeleteSeconds: body.autoDeleteSeconds ?? null,
				automaticRestart: body.automaticRestart ?? true,
				snapshotId: body.snapshotId ?? null,
				resources: { cpu: 4, memory: 8192, storage: 32_768 },
			};
			vms.set(id, { record, walk: states, files: new Map(), starts: [], builds: [], execs: [], reads: 0 });
			return json(201, record);
		}
		const shot = /^\/snapshots\/([^/]+)$/.exec(path);
		if (shot && init.method === "GET") {
			const found = findSnapshot(decodeURIComponent(shot[1]));
			return found === undefined ? error(404, "NOT_FOUND", `snapshot ${shot[1]} not found`) : json(200, found.record);
		}
		const take = /^\/vms\/([^/]+)\/snapshot$/.exec(path);
		if (take && init.method === "POST") {
			const vm = find(decodeURIComponent(take[1]));
			if (vm === undefined) return error(404, "NOT_FOUND", `vm ${take[1]} not found`);
			if (vm.record.state !== "running" && vm.record.state !== "paused") return error(409, "CONFLICT", "the VM is neither running nor paused");
			if (body?.slug !== undefined && body.slug !== null && findSnapshot(body.slug)) return error(409, "CONFLICT", `slug ${body.slug} is already used by another snapshot`);
			const record = snapshot(body?.slug ?? null, vm);
			return json(200, { snapshotId: record.id, snapshot: record });
		}
		if (init.method === "GET" && path === "/vms") {
			const asked = (u.searchParams.get("metadata") ?? "").split(",").filter(Boolean).map((pair) => pair.split(":"));
			const all = [...vms.values()].map(({ record }) => record).filter((record) => !filters || asked.every(([key, value]) => record.metadata[key] === value));
			const offset = Number(u.searchParams.get("offset") ?? 0);
			const limit = Number(u.searchParams.get("limit") ?? 50);
			return json(200, { vms: all.slice(offset, offset + limit), totalCount: all.length, runningCount: all.filter(({ state }) => state === "running").length, startingCount: 0, pausedCount: 0, stoppedCount: 0 });
		}
		const exec = /^\/vms\/([^/]+)\/exec-await$/.exec(path);
		if (exec && init.method === "POST") {
			const vm = find(decodeURIComponent(exec[1]));
			if (vm === undefined) return error(404, "NOT_FOUND", `vm ${exec[1]} not found`);
			if (vm.record.state !== "running") return error(409, "CONFLICT", "the VM is not running");
			vm.execs.push(body);
			return json(200, runLine(vm, body.command, body.env ?? {}, start, build));
		}
		const one = /^\/vms\/([^/]+)$/.exec(path);
		if (one) {
			const vm = find(decodeURIComponent(one[1]));
			if (vm === undefined) return error(404, "NOT_FOUND", `vm ${one[1]} not found`);
			if (init.method === "DELETE") {
				vms.delete(vm.record.id);
				deleted.push(vm.record.id);
				return new Response(null, { status: 204 });
			}
			if (init.method === "GET") {
				vm.record.state = vm.walk[Math.min(++vm.reads, vm.walk.length - 1)];
				return json(200, vm.record);
			}
		}
		return error(404, "NOT_FOUND", `no route ${init.method} ${path}`);
	};
	/** Puts a VM in the account as another create made it: these metadata, running. */
	const add = (metadata, { slug = null, state = "running" } = {}) => {
		const id = vmIdOf(made++);
		const record = { id, slug, state, metadata: { ...metadata }, createdAt: "2026-11-28T09:00:00Z", updatedAt: "2026-11-28T09:00:00Z", resources: { cpu: 2, memory: 4096, storage: 16_384 } };
		vms.set(id, { record, walk: [state], files: new Map(), starts: [], builds: [], execs: [], reads: 0 });
		return id;
	};
	return { calls, vms, deleted, snapshots, fetch, add, addSnapshot: (slug) => snapshot(slug).id, execs:() => calls.filter(({ url }) => url.pathname.endsWith("/exec-await")) };
}
