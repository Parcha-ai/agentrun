// A provider module whose provider says a note through the onNote option it is given, as a remote provider says a
// release that did not let an Archil folder go cleanly: every release of a computer notes it. The fake from
// ../fake-computer.mjs.
import { fakeComputers } from "../fake-computer.mjs";

export function createProvider(options = {}) {
	const { provider } = fakeComputers({ id: "release-note-module" });
	const release = provider.release.bind(provider);
	provider.release = async (ref, how) => {
		const released = await release(ref, how);
		options.onNote?.({ computer: ref.name, note: `${ref.name} was deleted, and the run's folder was not let go cleanly: a stand-in` });
		return released;
	};
	return provider;
}
