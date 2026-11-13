// A provider module whose every create is refused at length, so the report runs past 1 MiB.
import { fakeComputers } from "../fake-computer.mjs";

export function createProvider() {
	return fakeComputers({ id: "big", failCreate: `no capacity: ${"x".repeat(600 * 1024)}` }).provider;
}
