// A provider module whose create records a silent accept beside the ref, as a vendor whose firewall accepts first does.
import { fakeComputers } from "../fake-computer.mjs";

export function createProvider() {
	return fakeComputers({ id: "accept-first-module", notes: ["network: none; accepted with no answer (no bytes came back): 1.1.1.1:443"] }).provider;
}
