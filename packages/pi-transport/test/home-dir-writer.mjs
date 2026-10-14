// A writer that dies between writing its value to a temp file and linking it into place: SIGKILL from inside.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { dirStore } from "../src/home/dir-store.ts";

const [, , directory, key, value, version] = process.argv;
const store = dirStore(directory, { beforeLink: () => process.kill(process.pid, "SIGKILL") });
await store.put(
	key,
	new TextEncoder().encode(value),
	version === "-" ? { absent: true } : { version },
	BACKGROUND_CONTEXT,
);
process.stdout.write("survived\n");
