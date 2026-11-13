// A provider file as the registry loads one: MOUNT and create(options), and no conformance module. The CLI runs it by
// path, as it would by id once its registry line exists, and hands create() the options it was given, never the env:
// a provider reads no environment. This one is the fake from ../fake-computer.mjs.
import { fakeComputers } from "../fake-computer.mjs";

export const MOUNT = [];

export function create(options = {}) {
	if (Object.hasOwn(options, "env")) throw new Error("create() was handed an env: a provider reads no environment");
	return fakeComputers({ id: options.id || "options-module" }).provider;
}
