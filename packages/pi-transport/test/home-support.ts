import { createHash } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { getOrThrow, ok, type Result } from "@earendil-works/pi-durable/env";
import type { Box, BoxError, BoxExecOptions, BoxProcess } from "../src/box/box.ts";
import { finish } from "../src/box/files.ts";

const NAMES = [
	"plain",
	"with space",
	"two  spaces",
	"new\nline",
	"quote'single",
	'quote"double',
	"back\\slash",
	"-leading-dash",
	"dollar$HOME",
	"star*",
	"tab\there",
	"ünï cödé",
	"日本語",
	".hidden",
	"semi;colon",
	"back`tick`",
];

/** The non-UTF-8 name of a file: a lone 0xff and 0xfe. */
export const NON_UTF8_NAME = Buffer.from([0x62, 0x61, 0x64, 0xff, 0xfe, 0x2e, 0x74, 0x78, 0x74]);

/** A seeded generator of numbers in [0, 1). */
export function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A random tree under `root`: nested and empty directories, links, odd names, empty files and modes. */
export function makeTree(root: string, seed: number): void {
	const next = random(seed);
	const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
	mkdirSync(root, { recursive: true });
	const directories = [root];
	const taken = new Set<string>();
	const fresh = (directory: string): string => {
		for (let tries = 0; tries < 20; tries++) {
			const name = `${pick(NAMES)}${next() < 0.5 ? "" : Math.floor(next() * 100)}`;
			const path = join(directory, name);
			if (!taken.has(path)) {
				taken.add(path);
				return path;
			}
		}
		const path = join(directory, `n${taken.size}`);
		taken.add(path);
		return path;
	};
	const entries = 4 + Math.floor(next() * 28);
	for (let index = 0; index < entries; index++) {
		const directory = pick(directories);
		const roll = next();
		if (roll < 0.22) {
			const path = fresh(directory);
			mkdirSync(path);
			directories.push(path);
		} else if (roll < 0.3) {
			const path = fresh(directory);
			symlinkSync(next() < 0.5 ? "plain" : `../${pick(NAMES)}`, path);
		} else if (roll < 0.36) {
			const path = fresh(directory);
			writeFileSync(path, "");
		} else {
			const path = fresh(directory);
			const size = next() < 0.1 ? 200_000 + Math.floor(next() * 400_000) : Math.floor(next() * 3000);
			writeFileSync(path, Buffer.from(Array.from({ length: size }, () => Math.floor(next() * 256))));
			chmodSync(path, pick([0o644, 0o755, 0o600, 0o700, 0o664, 0o777, 0o400]));
			utimesSync(path, 1_700_000_000 + index, 1_700_000_000 + index * 7);
		}
	}
	writeFileSync(Buffer.concat([Buffer.from(`${root}/`), NON_UTF8_NAME]), `bytes ${seed}`);
	mkdirSync(join(root, "an empty directory"));
}

export type Seen = { readonly kind: string; readonly mode: number; readonly detail: string };

/** What is in a directory, read straight from the host's file system, keyed by path as hex of its bytes. */
export function walk(root: string): Map<string, Seen> {
	const seen = new Map<string, Seen>();
	const visit = (directory: Buffer, relative: Buffer) => {
		for (const name of readdirSync(directory as unknown as string, { encoding: "buffer" })) {
			const path = Buffer.concat([directory, Buffer.from("/"), name]);
			const rel = relative.length === 0 ? name : Buffer.concat([relative, Buffer.from("/"), name]);
			const stat = lstatSync(path as unknown as string);
			const key = rel.toString("hex");
			if (stat.isSymbolicLink()) {
				seen.set(key, {
					kind: "symlink",
					mode: 0,
					detail: readlinkSync(path as unknown as string, "buffer").toString("hex"),
				});
			} else if (stat.isDirectory()) {
				seen.set(key, { kind: "directory", mode: stat.mode & 0o7777, detail: "" });
				visit(path, rel);
			} else {
				const content = readFileSync(path as unknown as string);
				seen.set(key, {
					kind: "file",
					mode: stat.mode & 0o7777,
					detail: `${Math.floor(stat.mtimeMs / 1000)} ${createHash("sha256").update(content).digest("hex")}`,
				});
			}
		}
	};
	visit(Buffer.from(root), Buffer.alloc(0));
	return seen;
}

type Tamper = {
	/** Flip the low bit of the byte at this offset of the source program's output. */
	readonly flipAt?: number;
	/** End the source program's output after this many bytes, as a link that died would. */
	readonly cutAt?: number;
	/** Run this once when the source program starts. */
	readonly onStart?: () => void;
};

/** A box that tampers with the output of the program that packs a workspace or reads a file. */
export function tampered(box: Box, tamper: Tamper): Box {
	return {
		id: box.id,
		facts: () => box.facts(),
		upload: (files, context) => box.upload(files, context),
		download: (paths, context) => box.download(paths, context),
		status: (context) => box.status(context),
		destroy: (context) => box.destroy(context),
		async exec(
			command: readonly string[],
			options: BoxExecOptions | undefined,
			context,
		): Promise<Result<BoxProcess, BoxError>> {
			const started = await box.exec(command, options, context);
			const packs = command.some((part) => part.includes("tar -c")) || command[0] === "cat";
			if (!started.ok || !packs) return started;
			tamper.onStart?.();
			const inner = started.value;
			let seen = 0;
			let cut = false;
			return ok({
				stdin: inner.stdin,
				stderr: inner.stderr,
				stdout: (async function* () {
					for await (const chunk of inner.stdout) {
						const bytes = Uint8Array.from(chunk);
						if (tamper.flipAt !== undefined && seen <= tamper.flipAt && tamper.flipAt < seen + bytes.length) {
							bytes[tamper.flipAt - seen] = (bytes[tamper.flipAt - seen] as number) ^ 1;
						}
						if (tamper.cutAt !== undefined && seen + bytes.length >= tamper.cutAt) {
							yield bytes.subarray(0, Math.max(0, tamper.cutAt - seen));
							cut = true;
							return;
						}
						seen += bytes.length;
						yield bytes;
					}
				})(),
				// A cut link ends the program with an error; the real program keeps its pipe until the box is destroyed.
				wait: async () => {
					if (cut) return ok(141);
					return inner.wait();
				},
			});
		},
	};
}

const POPULATE_SCRIPT =
	'mkdir -p -- "$1" && i=0 && while [ "$i" -lt "$2" ]; do d="$1/dir-$((i % 7))"; mkdir -p -- "$d" && head -c "$3" /dev/urandom > "$d/file-$i.bin"; i=$((i+1)); done; ln -s dir-0 "$1/link"; mkdir -p "$1/empty"';

/** Fill a directory in a box with `files` files of `bytesEach` random bytes in seven directories, a link and an empty one. */
export async function populate(
	box: Box,
	root: string,
	files: number,
	bytesEach: number,
	context: Context,
): Promise<void> {
	const started = getOrThrow(
		await box.exec(
			["sh", "-c", POPULATE_SCRIPT, "sh", root, String(files), String(bytesEach)],
			{ timeoutMs: 900_000 },
			context,
		),
	);
	const finished = getOrThrow(await finish(started));
	if (finished.exitCode !== 0) throw new Error(`could not fill ${root}: ${finished.stderr}`);
}
