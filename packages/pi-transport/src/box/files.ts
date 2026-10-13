import type { Context } from "@earendil-works/chord";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import { type Box, BoxError, type BoxFile, type BoxProcess } from "./box.ts";

const WRITE_SCRIPT = 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1" && { [ -z "$2" ] || chmod "$2" "$1"; }';
const READ_SCRIPT = '[ -e "$1" ] || exit 3; [ -d "$1" ] && exit 4; exec cat -- "$1"';
const EXIT_NOT_FOUND = 3;
const EXIT_IS_DIRECTORY = 4;

/** Every byte of a stream, in order. */
export async function readStream(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	let length = 0;
	for await (const part of stream) {
		parts.push(part);
		length += part.length;
	}
	const bytes = new Uint8Array(length);
	let at = 0;
	for (const part of parts) {
		bytes.set(part, at);
		at += part.length;
	}
	return bytes;
}

type Finished = { readonly exitCode: number; readonly stdout: Uint8Array; readonly stderr: string };

/** Feed `input` to a started program, read both streams to their end, and report how it ended. */
export async function finish(process: BoxProcess, input?: Uint8Array): Promise<Result<Finished, BoxError>> {
	const feed = (async () => {
		if (input !== undefined && input.length > 0) await process.stdin.write(input);
		await process.stdin.close();
	})().catch(() => {});
	const [stdout, stderr, exit] = await Promise.all([
		readStream(process.stdout),
		readStream(process.stderr),
		process.wait(),
		feed,
	]);
	if (!exit.ok) return exit;
	return ok({ exitCode: exit.value, stdout, stderr: new TextDecoder().decode(stderr) });
}

/** `Box.upload` for a box whose `exec` carries input: each file is written by `cat` in the box. */
export async function uploadByExec(
	box: Pick<Box, "exec">,
	files: readonly BoxFile[],
	context: Context,
): Promise<Result<void, BoxError>> {
	for (const file of files) {
		const mode = file.mode === undefined ? "" : file.mode.toString(8);
		const started = await box.exec(["sh", "-c", WRITE_SCRIPT, "sh", file.path, mode], undefined, context);
		if (!started.ok) return started;
		const finished = await finish(started.value, file.bytes);
		if (!finished.ok) return finished;
		if (finished.value.exitCode !== 0) {
			return err(new BoxError("unknown", `could not write ${file.path}: ${finished.value.stderr.trim()}`));
		}
	}
	return ok(undefined);
}

/** `Box.download` for a box whose `exec` streams output: each file is read by `cat` in the box. */
export async function downloadByExec(
	box: Pick<Box, "exec">,
	paths: readonly string[],
	context: Context,
): Promise<Result<readonly BoxFile[], BoxError>> {
	const files: BoxFile[] = [];
	for (const path of paths) {
		const started = await box.exec(["sh", "-c", READ_SCRIPT, "sh", path], undefined, context);
		if (!started.ok) return started;
		const finished = await finish(started.value);
		if (!finished.ok) return finished;
		const { exitCode, stdout, stderr } = finished.value;
		if (exitCode === EXIT_NOT_FOUND) return err(new BoxError("not_found", `${path} does not exist`));
		if (exitCode === EXIT_IS_DIRECTORY) return err(new BoxError("invalid", `${path} is a directory`));
		if (exitCode !== 0) return err(new BoxError("unknown", `could not read ${path}: ${stderr.trim()}`));
		files.push({ path, bytes: stdout });
	}
	return ok(files);
}
