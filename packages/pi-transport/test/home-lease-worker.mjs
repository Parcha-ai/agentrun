// One taker in its own process: told which epoch to take and when, it takes through leaseIn over a shared directory.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { dirStore } from "../src/home/dir-store.ts";
import { leaseIn } from "../src/home/ownership.ts";

const [, , directory, name] = process.argv;
const lease = leaseIn(dirStore(directory));
const holder = { environment: "e", provider: "local", box: name, host: name };
process.on("message", async ({ epoch, at }) => {
	while (Date.now() < at) {}
	const taken = await lease.take("session", holder, epoch - 1, undefined, BACKGROUND_CONTEXT);
	process.send({ epoch, name, won: taken.ok, code: taken.ok ? "" : taken.error.code });
});
process.send({ ready: true });
