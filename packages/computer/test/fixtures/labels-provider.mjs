// A provider module whose computers a test can read back: the fake from ../fake-computer.mjs, one per module load, its
// made computers (with their labels) exported as `made`.
import { fakeComputers } from "../fake-computer.mjs";

const fake = fakeComputers({ id: "labels-module" });

export const made = fake.made;

export function createProvider() {
	return fake.provider;
}
