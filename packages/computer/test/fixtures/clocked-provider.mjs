// A provider module whose timers run on a clock of its own, as a fake host's do: it exports that clock as its
// conformanceClock, the run's clock unless the CLI's caller gives one.
import { fakeComputers } from "../fake-computer.mjs";
import { virtualClock } from "../fake-device.mjs";

export const START = Date.UTC(2026, 0, 1);

export function createProvider() {
	return fakeComputers({ id: "clocked-module" }).provider;
}

export const conformanceClock = virtualClock(START);
