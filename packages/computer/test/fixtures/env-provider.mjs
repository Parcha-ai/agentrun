// A provider file as the registry loads one: ENV and fromEnv(), and no conformance module. The CLI runs it by path, as it
// would by id once its registry line exists. This one is the fake from ../fake-computer.mjs.
import { fakeComputers } from "../fake-computer.mjs";

export const ENV = { name: "COMPUTER_ENV_MODULE_NAME" };

export function fromEnv(env = process.env) {
	return fakeComputers({ id: env[ENV.name] || "env-module" }).provider;
}
