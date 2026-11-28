// A provider module whose conformanceClock is no clock: a now() and no sleep(ms).
import { fakeComputers } from "../fake-computer.mjs";

export function createProvider() {
	return fakeComputers({ id: "bad-clock-module" }).provider;
}

export const conformanceClock = { now: () => 0 };
