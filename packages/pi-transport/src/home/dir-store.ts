import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import { type ConditionalStore, KeyStoreError } from "./ownership.ts";

/** Options of `dirStore`. */
export type DirStoreOptions = {
	/** Called after a value is written whole to its temp file and before it is linked into place. For tests that kill the writer there. */
	readonly beforeLink?: () => void;
};

const TEMP_PREFIX = ".tmp-";
const NOT_LINKABLE = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS", "EMLINK"]);

const KEY_PREFIX = "k-";

/**
 * A key as a directory name that is the same key on any file system. Only lowercase letters and digits stand for
 * themselves; every other byte, uppercase letters included, is `%` and two uppercase hex digits, so two keys never
 * differ only by case. The fixed prefix means no key can be the store's own directory, a temp file or a version.
 */
function dirName(key: string): string {
	let name = KEY_PREFIX;
	for (const byte of new TextEncoder().encode(key)) {
		const character = String.fromCharCode(byte);
		name += /[a-z0-9]/.test(character) ? character : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return name;
}

/** Write every byte: one call may write fewer than it was given. */
function writeAll(fd: number, bytes: Uint8Array): void {
	let written = 0;
	while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
}

/** What a file system answers when it cannot sync a directory at all, as opposed to failing to. */
const CANNOT_SYNC_DIRECTORY = new Set(["EINVAL", "EISDIR", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM"]);

/** The version numbers in a key's directory, ascending. Temp files and anything else are not versions. */
function versionsIn(directory: string): number[] {
	try {
		return readdirSync(directory)
			.filter((name) => /^[1-9]\d*$/.test(name))
			.map(Number)
			.sort((a, b) => a - b);
	} catch (cause) {
		if ((cause as { code?: string }).code === "ENOENT") return [];
		throw cause;
	}
}

/** Sync a directory so its entries survive a crash. Only "this file system cannot" is ignored; an I/O error is not. */
function fsyncDirectory(directory: string): void {
	let fd: number;
	try {
		fd = openSync(directory, "r");
	} catch (cause) {
		// Windows will not open a directory at all; that is "cannot sync", not a failed disk.
		if (CANNOT_SYNC_DIRECTORY.has((cause as { code?: string }).code ?? "")) return;
		throw cause;
	}
	try {
		fsyncSync(fd);
	} catch (cause) {
		if (!CANNOT_SYNC_DIRECTORY.has((cause as { code?: string }).code ?? "")) throw cause;
	} finally {
		closeSync(fd);
	}
}

/**
 * A `ConditionalStore` in a directory, for one machine or a directory several hosts share. A key is a directory of
 * numbered files, one per version. A write is made whole in a private temp file, synced, and then linked with
 * `link(2)` to the next number: two writers of the same version race for one name, and a directory holds a name once,
 * so exactly one wins; and the name never exists with half a value in it. A file system without hard links is refused
 * with `unsupported`. Old versions are kept.
 */
export function dirStore(directory: string, options: DirStoreOptions = {}): ConditionalStore {
	return {
		async get(key, context): Promise<Result<{ value: Uint8Array; version: string } | undefined, KeyStoreError>> {
			if (context.abortSignal?.aborted) return err(new KeyStoreError("aborted", "the call was aborted"));
			if (key === "") return err(new KeyStoreError("invalid", "the key is empty"));
			const keyDirectory = join(directory, dirName(key));
			try {
				// A newest version can be listed and still unreadable only if someone removed it; the next one down is then not newest.
				const newest = versionsIn(keyDirectory).at(-1);
				if (newest === undefined) return ok(undefined);
				return ok({
					value: new Uint8Array(readFileSync(join(keyDirectory, String(newest)))),
					version: String(newest),
				});
			} catch (cause) {
				return err(new KeyStoreError("unavailable", `could not read ${key}: ${(cause as Error).message}`, cause));
			}
		},

		async put(key, value, when, context): Promise<Result<{ version: string }, KeyStoreError>> {
			if (context.abortSignal?.aborted) return err(new KeyStoreError("aborted", "the call was aborted"));
			if (key === "") return err(new KeyStoreError("invalid", "the key is empty"));
			let next: number;
			if ("absent" in when) next = 1;
			else {
				const current = Number(when.version);
				if (!Number.isSafeInteger(current) || current < 1) {
					return err(new KeyStoreError("invalid", `${when.version} is not a version of this store`));
				}
				next = current + 1;
			}
			const keyDirectory = join(directory, dirName(key));
			// A version that was never written is not one this key has: refuse before anything is written.
			if (!("absent" in when) && !existsSync(join(keyDirectory, String(next - 1)))) {
				return err(new KeyStoreError("conflict", `${key} has no version ${when.version}`));
			}
			const temp = join(keyDirectory, `${TEMP_PREFIX}${randomUUID()}`);
			try {
				// A key directory that is new must itself be durable in the store's directory.
				if (mkdirSync(keyDirectory, { recursive: true }) !== undefined) {
					fsyncDirectory(dirname(keyDirectory));
					fsyncDirectory(directory);
				}
				const fd = openSync(temp, "wx", 0o644);
				try {
					writeAll(fd, value);
					fsyncSync(fd);
				} finally {
					closeSync(fd);
				}
				options.beforeLink?.();
				try {
					linkSync(temp, join(keyDirectory, String(next)));
				} catch (cause) {
					const code = (cause as { code?: string }).code ?? "";
					if (code === "EEXIST") return err(new KeyStoreError("conflict", `${key} is no longer at that version`));
					if (NOT_LINKABLE.has(code)) {
						return err(
							new KeyStoreError("unsupported", `${directory} does not support hard links (${code})`, cause),
						);
					}
					throw cause;
				}
				fsyncDirectory(keyDirectory);
				return ok({ version: String(next) });
			} catch (cause) {
				return err(new KeyStoreError("unavailable", `could not write ${key}: ${(cause as Error).message}`, cause));
			} finally {
				try {
					unlinkSync(temp);
				} catch {
					// Never made, or already gone.
				}
			}
		},
	};
}
