// A provider module for a vendor whose plan keeps two computers at once, as a free tier does: a create past two alive
// is refused in the vendor's words. The fake from ../fake-computer.mjs.
import { fakeComputers } from "../fake-computer.mjs";

export function createProvider() {
	const fake = fakeComputers({ id: "fake-capped" });
	const create = fake.provider.create.bind(fake.provider);
	fake.provider.create = async (spec, context) =>
		fake.alive().length >= 2 ? { ok: false, error: { code: "limit", message: "the plan keeps two computers at once" } } : create(spec, context);
	return fake.provider;
}
