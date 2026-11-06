// Files in and out of a computer, past one call's limit: whole files in chunks, and tar archives both ways.
import type { DaemonClient } from "./client.js";
import type { TarPullResult, TarPushEndResult } from "./protocol.js";
import { fail, type Result } from "./result.js";

export interface PulledTar {
	chunks: AsyncIterable<Uint8Array>;
	done: Promise<Result<TarPullResult>>;
}

const notBuilt = () => fail("unsupported", "files are not built yet");

export async function readFile(_client: DaemonClient, _path: string, _options: { signal?: AbortSignal } = {}): Promise<Result<Uint8Array>> {
	return notBuilt();
}

export async function writeFile(
	_client: DaemonClient,
	_path: string,
	_bytes: Uint8Array,
	_options: { mode?: number; parents?: boolean; signal?: AbortSignal } = {},
): Promise<Result<{ size: number }>> {
	return notBuilt();
}

export async function pushTar(
	_client: DaemonClient,
	_dir: string,
	_tar: Uint8Array | AsyncIterable<Uint8Array>,
	_options: { signal?: AbortSignal } = {},
): Promise<Result<TarPushEndResult>> {
	return notBuilt();
}

export function pullTarStream(_client: DaemonClient, _path: string, _options: { signal?: AbortSignal } = {}): PulledTar {
	return { chunks: (async function* () {})(), done: Promise.resolve(notBuilt()) };
}

export async function pullTar(_client: DaemonClient, _path: string, _options: { signal?: AbortSignal } = {}): Promise<Result<Uint8Array>> {
	return notBuilt();
}
