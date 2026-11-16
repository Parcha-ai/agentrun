// A provider module whose create answers a retry of one request with the computer the request's first create made, as
// the contract asks, and whose delete of a computer labelled stuck=1 fails and leaves it. The fake from ../fake-computer.mjs.
import { fakeComputers } from "../fake-computer.mjs";

export function createProvider() {
	const fake = fakeComputers({ id: "fake-retried", failRelease: { stuck: "1" } });
	const create = fake.provider.create.bind(fake.provider);
	const requests = new Map();
	fake.provider.create = (spec, context) => {
		if (!requests.has(context.requestId)) requests.set(context.requestId, create(spec, context));
		return requests.get(context.requestId);
	};
	return fake.provider;
}
