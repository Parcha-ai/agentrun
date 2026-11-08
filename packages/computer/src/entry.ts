// How a command in this package decides it is the one being run: `if (isCommand(import.meta)) ...`. Where Node sets
// meta.main (22.18 and later on 22, 24.2 and later) the answer is that value. Where it does not (Node 23, 24.0-24.1,
// which this package's published engines allow) it compares the realpath of the script Node was given with the
// module's own: Node resolves a module's URL through symlinks and leaves the script's path as given (macOS's temp
// directory is a symlink), so only the realpath of both sides is safe. This package keeps to itself and imports nothing
// from the repository's scripts/, so it has its own copy of that rule here, the one place it reads the script's path.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const real = (path: string) => {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
};

/** Whether the module whose `import.meta` this is runs as the command; entry is the script Node was given. */
export function isCommand(meta: ImportMeta, entry: string | undefined = process.argv[1]): boolean {
	const main = (meta as { main?: unknown }).main;
	if (typeof main === "boolean") return main;
	return entry !== undefined && real(entry) === real(fileURLToPath(meta.url));
}
