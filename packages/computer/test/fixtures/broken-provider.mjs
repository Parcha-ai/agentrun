// A provider module whose every create is refused.
import { fakeComputers } from "../fake-computer.mjs";

export async function createProvider() {
	return fakeComputers({ id: "broken", failCreate: "no capacity in this region" }).provider;
}
