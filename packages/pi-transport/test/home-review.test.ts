import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createSession } from "@earendil-works/pi-durable";
import { err, getOrThrow, ok } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterAll, describe, expect, it } from "vitest";
import { type Box, BoxError } from "../src/box/box.ts";
import { finish } from "../src/box/files.ts";
import { localBoxes } from "../src/box/local.ts";
import { checkpointStore, moveFile, moveWorkspace, type Pipe } from "../src/home/index.ts";
import { tampered, walk } from "./home-support.ts";

const context = BACKGROUND_CONTEXT;
const root = mkdtempSync(join(tmpdir(), "pi-transport-home-review-"));
const provider = localBoxes({ root });
const boxes: Box[] = [];
afterAll(async () => {
	for (const box of boxes) await box.destroy(context);
	rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
}, 120_000);
const FILES: Pipe = { kind: "files", chunkBytes: 64 * 1024 };
const STREAM: Pipe = { kind: "stream" };

async function pair() {
	const from = getOrThrow(await provider.create({ maxLifetimeMs: 600_000 }, context));
	const to = getOrThrow(await provider.create({ maxLifetimeMs: 600_000 }, context));
	boxes.push(from, to);
	return { from, to };
}
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sealOf = (bytes: Buffer) => ({ sha256: sha(bytes), bytes: bytes.length });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function tempOf(box: Box): Promise<string> {
	const started = getOrThrow(await box.exec(["sh", "-c", 'printf %s "$TMPDIR"'], undefined, context));
	return new TextDecoder().decode(getOrThrow(await finish(started)).stdout);
}
async function partsDirs(box: Box): Promise<string[]> {
	const dir = await tempOf(box);
	return existsSync(dir)
		? readdirSync(dir)
				.filter((name) => name.startsWith("pi-transport-move-"))
				.map((name) => join(dir, name))
		: [];
}

describe("names", () => {
	for (const [label, pipe] of [
		["stream", STREAM],
		["files", FILES],
	] as const) {
		it(`keeps a byte order mark inside, at the start of and after a name, and in a link target (${label})`, async () => {
			const { from, to } = await pair();
			const src = join(from.facts().workspace, "bom");
			mkdirSync(src);
			for (const name of ["a﻿b", "﻿lead", "trail﻿", "x﻿﻿y"]) writeFileSync(join(src, name), name);
			symlinkSync("t﻿arget", join(src, "link﻿"));
			const dst = join(to.facts().workspace, "bom");
			getOrThrow(
				await moveWorkspace(from, to, { fromRoot: src, toRoot: dst, fromPipe: pipe, toPipe: pipe }, context),
			);
			expect(walk(dst)).toEqual(walk(src));
			expect(readdirSync(dst).sort()).toEqual(readdirSync(src).sort());
		});

		it(`moves a file whose target path has a newline and a backslash (${label})`, async () => {
			const { from, to } = await pair();
			const bytes = randomBytes(5000);
			const source = join(from.facts().workspace, "f");
			writeFileSync(source, bytes);
			const target = join(to.facts().workspace, "odd\nname\\here", "f\\n");
			getOrThrow(await moveFile(from, source, to, target, sealOf(bytes), { fromPipe: pipe, toPipe: pipe }, context));
			expect(readFileSync(target).equals(bytes)).toBe(true);
		});
	}
});

describe("a source that changes", () => {
	it("is seen when a file is rewritten with the same size and the same timestamp after tar read it", async () => {
		const { from, to } = await pair();
		const src = join(from.facts().workspace, "tree");
		mkdirSync(src);
		const file = join(src, "data.bin");
		writeFileSync(file, Buffer.alloc(4000, 1));
		utimesSync(file, 1_700_000_000, 1_700_000_000);
		const racing = tampered(from, {
			onFirstChunk: () => {
				writeFileSync(file, Buffer.alloc(4000, 2));
				utimesSync(file, 1_700_000_000, 1_700_000_000);
			},
		});
		const moved = await moveWorkspace(
			racing,
			to,
			{ fromRoot: src, toRoot: join(to.facts().workspace, "t") },
			context,
		);
		expect(moved.ok ? "" : moved.error.code).toBe("changed");
		expect(moved.ok ? "" : moved.error.message).toMatch(/data\.bin/);
	});
});

describe("phases that move no byte", () => {
	for (const [label, match, key] of [
		["packing", "tar -c", "delaySource"],
		["joining", "tar -x", "delayTarget"],
	] as const) {
		it(`are not a stall: ${label} for longer than the stall limit still moves the workspace`, async () => {
			const { from, to } = await pair();
			const src = join(from.facts().workspace, "tree");
			mkdirSync(src);
			writeFileSync(join(src, "f"), randomBytes(3000));
			const slow = { match, ms: 1500 };
			const a = key === "delaySource" ? tampered(from, { delayExec: slow }) : from;
			const b = key === "delayTarget" ? tampered(to, { delayExec: slow }) : to;
			const dst = join(to.facts().workspace, "t");
			getOrThrow(
				await moveWorkspace(
					a,
					b,
					{ fromRoot: src, toRoot: dst, fromPipe: FILES, toPipe: FILES, stallMs: 400 },
					context,
				),
			);
			expect(walk(dst)).toEqual(walk(src));
		}, 60_000);
	}

	// Before a phase that moves no byte begins, a box call (the parts directory, the program's start) may take longer
	// than the stall limit too: that is a slow box, not a stall. The call is slowed by far more than the limit, so no
	// scheduling noise decides the outcome.
	for (const [label, side, pipe] of [
		["the source's setup call", "source", FILES],
		["the target's setup call", "target", FILES],
		["the source's program start", "source", { kind: "stream" } as const],
		["the target's program start", "target", { kind: "stream" } as const],
	] as const) {
		it(`are not a stall: ${label} slower than the stall limit still moves the workspace (${pipe.kind})`, async () => {
			const { from, to } = await pair();
			const src = join(from.facts().workspace, "tree");
			mkdirSync(src);
			writeFileSync(join(src, "f"), randomBytes(3000));
			const slow = {
				match: pipe.kind === "files" ? "pi-transport-move-" : side === "source" ? "tar -c" : "tar -x",
				ms: 1500,
			};
			const a = side === "source" ? tampered(from, { delayExec: slow }) : from;
			const b = side === "target" ? tampered(to, { delayExec: slow }) : to;
			const dst = join(to.facts().workspace, "t");
			getOrThrow(
				await moveWorkspace(
					a,
					b,
					{ fromRoot: src, toRoot: dst, fromPipe: pipe, toPipe: pipe, stallMs: 400 },
					context,
				),
			);
			expect(walk(dst)).toEqual(walk(src));
		}, 60_000);
	}

	it("are not a stall at any limit: a setup call of 300 ms under a 25 ms limit still moves the workspace", async () => {
		const { from, to } = await pair();
		const src = join(from.facts().workspace, "tree");
		mkdirSync(src);
		writeFileSync(join(src, "f"), randomBytes(3000));
		const dst = join(to.facts().workspace, "t");
		getOrThrow(
			await moveWorkspace(
				tampered(from, { delayExec: { match: "pi-transport-move-", ms: 300 } }),
				to,
				{ fromRoot: src, toRoot: dst, fromPipe: FILES, toPipe: FILES, stallMs: 25 },
				context,
			),
		);
		expect(walk(dst)).toEqual(walk(src));
	}, 60_000);

	it("still end with a timeout when the whole deadline passes", async () => {
		const { from, to } = await pair();
		const src = join(from.facts().workspace, "tree");
		mkdirSync(src);
		writeFileSync(join(src, "f"), "x");
		const moved = await moveWorkspace(
			tampered(from, { delayExec: { match: "tar -c", ms: 3000 } }),
			to,
			{ fromRoot: src, toRoot: join(to.facts().workspace, "t"), fromPipe: FILES, toPipe: FILES, deadlineMs: 800 },
			context,
		);
		expect(moved.ok ? "" : moved.error.code).toBe("timeout");
	}, 60_000);
});

describe("the size of a part", () => {
	it("is a whole number of bytes, 1 or more, refused before any box call", async () => {
		const { from, to } = await pair();
		const src = join(from.facts().workspace, "tree");
		mkdirSync(src);
		writeFileSync(join(src, "f"), "x");
		const bytes = Buffer.from("y");
		const file = join(from.facts().workspace, "one");
		writeFileSync(file, bytes);
		for (const chunkBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			const asTarget = await moveWorkspace(
				from,
				to,
				{ fromRoot: src, toRoot: join(to.facts().workspace, "a"), toPipe: { kind: "files", chunkBytes } },
				context,
			);
			expect(asTarget.ok ? "" : asTarget.error.code, `workspace ${chunkBytes}`).toBe("invalid");
			const asOption = await moveWorkspace(
				from,
				to,
				{ fromRoot: src, toRoot: join(to.facts().workspace, "a"), fromPipe: { kind: "files" }, chunkBytes },
				context,
			);
			expect(asOption.ok ? "" : asOption.error.code, `option ${chunkBytes}`).toBe("invalid");
			const asFile = await moveFile(
				from,
				file,
				to,
				join(to.facts().workspace, "b"),
				sealOf(bytes),
				{ toPipe: { kind: "files", chunkBytes } },
				context,
			);
			expect(asFile.ok ? "" : asFile.error.code, `file ${chunkBytes}`).toBe("invalid");
		}
		expect(existsSync(join(to.facts().workspace, "a"))).toBe(false);
	});
});

describe("moves to the same place at the same time", () => {
	it("one moveFile never deletes or overwrites another's partial file", async () => {
		const { from, to } = await pair();
		const bytes = randomBytes(400_000);
		const source = join(from.facts().workspace, "f");
		writeFileSync(source, bytes);
		const target = join(to.facts().workspace, "same", "f");
		for (const pipe of [STREAM, FILES]) {
			const results = await Promise.all(
				Array.from({ length: 4 }, () =>
					moveFile(from, source, to, target, sealOf(bytes), { fromPipe: pipe, toPipe: pipe }, context),
				),
			);
			expect(results.map((result) => (result.ok ? "ok" : result.error.message))).toEqual(["ok", "ok", "ok", "ok"]);
			expect(readFileSync(target).equals(bytes)).toBe(true);
			expect(readdirSync(join(target, ".."))).toEqual(["f"]);
			rmSync(target);
		}
	}, 60_000);

	it("one checkpoint to a place wins and the others say `exists`, with nothing left behind", async () => {
		const dir = mkdtempSync(join(root, "ck-"));
		const path = join(dir, "live.db");
		const storage = await openNodeSqliteStorage(path);
		const session = createSession(storage);
		try {
			const conversation = await session.commit(
				(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
				context,
			);
			for (let index = 0; index < 50; index++) {
				await session.commit((tx) => tx.appendEntry(conversation.id, { kind: "note", data: { index } }), context);
			}
			const to = join(dir, "copy.db");
			const results = await Promise.all(Array.from({ length: 8 }, () => checkpointStore(path, to, context)));
			expect(results.filter((result) => result.ok).length).toBe(1);
			expect(
				results.filter((result) => !result.ok).every((result) => !result.ok && result.error.code === "exists"),
			).toBe(true);
			expect(readdirSync(dir).sort()).toEqual(
				["copy.db", "live.db", "live.db-shm", "live.db-wal"].filter((name) => existsSync(join(dir, name))),
			);
		} finally {
			await session.close(context);
		}
	});

	it("a checkpoint whose destination cannot be made is an error that is returned, not thrown", async () => {
		const dir = mkdtempSync(join(root, "ck-"));
		const path = join(dir, "live.db");
		const storage = await openNodeSqliteStorage(path);
		await storage.close(context);
		writeFileSync(join(dir, "afile"), "x");
		const result = await checkpointStore(path, join(dir, "afile", "inside", "copy.db"), context);
		expect(result.ok).toBe(false);
		chmodSync(dir, 0o500);
		try {
			const readOnly = await checkpointStore(path, join(dir, "copy.db"), context);
			expect(readOnly.ok).toBe(false);
		} finally {
			chmodSync(dir, 0o700);
		}
	});
});

describe("a cancelled call", () => {
	it("leaves no partial file when a streamed moveFile is aborted after bytes reached the target", async () => {
		const { from, to } = await pair();
		const bytes = randomBytes(3_000_000);
		const source = join(from.facts().workspace, "f");
		writeFileSync(source, bytes);
		const target = join(to.facts().workspace, "dir", "f");
		const controller = new AbortController();
		// The target takes the first bytes, and then the call is cancelled and the write is held: no timing decides it.
		const holding: Box = {
			id: to.id,
			facts: () => to.facts(),
			upload: (files, ctx) => to.upload(files, ctx),
			download: (paths, ctx) => to.download(paths, ctx),
			status: (ctx) => to.status(ctx),
			destroy: (ctx) => to.destroy(ctx),
			exec: async (command, options, ctx) => {
				const started = await to.exec(command, options, ctx);
				if (!started.ok || !command.some((part) => part.includes("cat > "))) return started;
				let written = 0;
				return ok({
					...started.value,
					stdin: {
						close: () => started.value.stdin.close(),
						write: async (chunk) => {
							await started.value.stdin.write(chunk);
							written += chunk.length;
							if (written === chunk.length) controller.abort();
							// Held: this write never answers, as one on a cut link does not.
							return new Promise<void>(() => {});
						},
					},
				});
			},
		};
		const moved = await moveFile(
			from,
			source,
			holding,
			target,
			sealOf(bytes),
			{ fromPipe: STREAM, toPipe: STREAM },
			withAbortSignal(controller.signal, context),
		);
		expect(moved.ok ? "" : moved.error.code).toBe("aborted");
		// Bytes did reach the target, and the cleanup ran without the caller's abort: nothing of the file is left.
		expect(readdirSync(join(target, ".."))).toEqual([]);
	});

	it("stops the program a box keeps running after the call is cancelled, before the parts are removed", async () => {
		const { from, to } = await pair();
		const src = join(from.facts().workspace, "tree");
		mkdirSync(src);
		writeFileSync(join(src, "f"), randomBytes(2000));
		const dst = join(to.facts().workspace, "landing");
		const controller = new AbortController();
		// A box like Docker's: cancelling ends the client, not the program in the box. The unpack is made slow so that
		// it is still running when the call is cancelled, and it would write `late` when it got to the end.
		const stubborn: Box = {
			...to,
			id: to.id,
			facts: () => to.facts(),
			upload: (files, ctx) => to.upload(files, ctx),
			download: (paths, ctx) => to.download(paths, ctx),
			status: (ctx) => to.status(ctx),
			destroy: (ctx) => to.destroy(ctx),
			exec: async (command, options, ctx) => {
				const slow = command.map((part) =>
					part.includes("tar -x") ? part.replace("{ for f in", "sleep 2; touch late; { for f in") : part,
				);
				const isUnpack = slow.some((part) => part.includes("sleep 2; touch late"));
				const started = await to.exec(slow, options, isUnpack ? BACKGROUND_CONTEXT : ctx);
				if (!started.ok || !isUnpack) return started;
				setTimeout(() => controller.abort(), 300);
				const cancelled = new Promise<"cancelled">((resolve) =>
					ctx.abortSignal?.addEventListener("abort", () => resolve("cancelled")),
				);
				const inner = started.value;
				const cut = async function* (stream: AsyncIterable<Uint8Array>) {
					const iterator = stream[Symbol.asyncIterator]();
					for (;;) {
						const next = await Promise.race([iterator.next(), cancelled]);
						if (next === "cancelled" || next.done) return;
						yield next.value;
					}
				};
				return ok({
					stdin: inner.stdin,
					stdout: cut(inner.stdout),
					stderr: cut(inner.stderr),
					wait: async () => {
						const first = await Promise.race([inner.wait(), cancelled]);
						return first === "cancelled" ? err(new BoxError("aborted", "the call was aborted")) : first;
					},
				});
			},
		};
		const moved = await moveWorkspace(
			from,
			stubborn,
			{ fromRoot: src, toRoot: dst, fromPipe: FILES, toPipe: FILES },
			withAbortSignal(controller.signal, context),
		);
		expect(moved.ok ? "" : moved.error.code).toBe("aborted");
		await sleep(3000);
		expect(existsSync(join(dst, "late"))).toBe(false);
		expect(await partsDirs(to)).toEqual([]);
	}, 60_000);
});

/** A box whose programs run with the umask a shared host usually has. */
function loose(box: Box): Box {
	return {
		id: box.id,
		facts: () => box.facts(),
		upload: (files, ctx) => box.upload(files, ctx),
		download: (paths, ctx) => box.download(paths, ctx),
		status: (ctx) => box.status(ctx),
		destroy: (ctx) => box.destroy(ctx),
		exec: (command, options, ctx) => box.exec(["sh", "-c", 'umask 022; exec "$@"', "sh", ...command], options, ctx),
	};
}

describe("the parts in a box", () => {
	it("are readable by the account that moves them and no one else, whatever the box's umask", async () => {
		const { from, to } = await pair();
		const src = join(from.facts().workspace, "tree");
		mkdirSync(src);
		const secret = join(src, "secret.txt");
		writeFileSync(secret, randomBytes(3000));
		chmodSync(secret, 0o600);
		const before = process.umask(0o022);
		const seen: string[] = [];
		const modeOf = (path: string) => statSync(path).mode & 0o777;
		// The directory is what keeps others out; it is checked at every sample. A file is checked once its own write is
		// done: every file of the source's packing when the host starts to fetch, and each uploaded part right after it.
		const inspect = async (box: Box, files: (dir: string) => string[]) => {
			for (const dir of await partsDirs(box)) {
				seen.push(`dir ${(modeOf(dir) & 0o077) === 0 ? "closed" : `OPEN ${modeOf(dir).toString(8)}`}`);
				for (const file of files(dir)) {
					if (existsSync(file) && (modeOf(file) & 0o077) !== 0)
						seen.push(`OPEN file ${file} ${modeOf(file).toString(8)}`);
				}
			}
		};
		const watchingFrom = tampered(loose(from), {
			onDownload: () => void inspect(from, (dir) => readdirSync(dir).map((name) => join(dir, name))),
		});
		const watchingTo = tampered(loose(to), {
			onUpload: (call) => void inspect(to, (dir) => [join(dir, `c-${String(call - 1).padStart(6, "0")}`)]),
		});
		try {
			getOrThrow(
				await moveWorkspace(
					watchingFrom,
					watchingTo,
					{
						fromRoot: src,
						toRoot: join(to.facts().workspace, "t"),
						fromPipe: FILES,
						toPipe: { kind: "files", chunkBytes: 1000 },
					},
					context,
				),
			);
		} finally {
			process.umask(before);
		}
		await sleep(300);
		expect(
			seen.filter((line) => line.includes("OPEN")),
			seen.join("; "),
		).toEqual([]);
		expect(seen.filter((line) => line.startsWith("dir")).length).toBeGreaterThan(2);
	});
});

describe("the Docker live command", () => {
	it("runs every Docker live file of the movers", () => {
		const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
			scripts: Record<string, string>;
		};
		for (const name of readdirSync(import.meta.dirname).filter((file) => /docker\.live\.test\.ts$/.test(file))) {
			const script = pkg.scripts["test:live:docker"] ?? "";
			// Either the file is named in the command, or the command selects files by a pattern the file's name has.
			const patterns = script
				.split(/\s+/)
				.filter((word) => !word.startsWith("-") && !word.includes("=") && word !== "vitest" && word !== "run");
			expect(
				patterns.some((word) => name.includes(word.replace(/^test\//, ""))),
				`${name} in ${script}`,
			).toBe(true);
		}
	});
});
