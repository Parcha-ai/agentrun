// A provider module as a vendor writes one: it exports createProvider(). This one is the fake from ../fake-computer.mjs.
import { fakeComputers } from "../fake-computer.mjs";

export function createProvider() {
	return fakeComputers({ id: "fake-module" }).provider;
}
