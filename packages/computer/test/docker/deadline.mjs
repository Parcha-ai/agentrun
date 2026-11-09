// create() for a live test that watches a computer reach its deadline. A lifetime counts from create's start, so a Docker
// host that holds container starts (another workload tearing down, a busy dockerd: 95 s and 101 s were seen) eats into
// it, and a computer whose deadline passed before docker run finished is gone before the test can watch it.

const seconds = (ms) => Math.round(ms / 100) / 10;

/**
 * Calls create(lifetimeMs), and keep(name) for each computer it makes. When create took so long that less than leftMs
 * of the lifetime is left, or failed once the lifetime had passed, it asks once more for lifetimeMs past twice what
 * create took. When that is still too slow it skips the test in words, with both times, and gives undefined: never a
 * silent pass. Otherwise it gives { result, lifetimeMs, from, to }: the create's result as it is (a failure with lifetime
 * left is the test's to assert), the lifetime it asked for, and the times just before and after it.
 */
export async function createForDeadline(t, create, { lifetimeMs: asked, leftMs = 0, keep }) {
	let lifetimeMs = asked;
	let first;
	for (;;) {
		const from = Date.now();
		const result = await create(lifetimeMs);
		const to = Date.now();
		if (result.ok) keep(result.value.name);
		const took = to - from;
		const left = from + lifetimeMs - to;
		if ((result.ok && left >= leftMs) || (!result.ok && took < lifetimeMs)) return { result, lifetimeMs, from, to };
		const words = `create took ${seconds(took)} s of a lifetime of ${seconds(lifetimeMs)} s`;
		if (first !== undefined) {
			const outcome = result.ok ? `it left ${seconds(Math.max(0, left))} s, and the test needs ${seconds(leftMs)} s` : result.error.message;
			t.skip(`${words} (the first took ${first}): this Docker host starts a computer too slowly for the test to watch its deadline; ${outcome}`);
			return undefined;
		}
		first = `${seconds(took)} s of ${seconds(lifetimeMs)} s`;
		lifetimeMs = asked + 2 * took;
	}
}
