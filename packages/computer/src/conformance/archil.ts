// A run's folder on an Archil disk for the mount cases, made, read and written from outside the computer through the
// disk's S3-compatible file API (the calls serve's ArchilWorkspace makes: a GET, a PUT and a DELETE of
// <S3 endpoint>/<disk>/<key> with the account key as a Bearer token, and ListObjectsV2 to clear the folder). Every
// setting is given: the conformance CLI reads them from COMPUTER_ARCHIL_* (ARCHIL_ENV); this module reads no environment
// of its own. The folder is agents/conformance/runs/<run>/work, a fresh run each time, removed when the case ends.
import { randomBytes } from "node:crypto";
import type { RunFolder } from "./types.js";

/** The environment the conformance CLI reads for an Archil run folder, by name. */
export const ARCHIL_ENV = {
	/** The disk's id, dsk- and 16 hex digits: the file API names it so. */
	disk: "COMPUTER_ARCHIL_DISK",
	/** Its region, such as aws-us-east-1. */
	region: "COMPUTER_ARCHIL_REGION",
	/** The disk's mount token, which only the helper in the computer gets. */
	token: "COMPUTER_ARCHIL_TOKEN",
	/** The account key the file API takes. */
	apiKey: "COMPUTER_ARCHIL_API_KEY",
	/** The disk's S3-compatible endpoint, https on an Archil host for the region. */
	s3Url: "COMPUTER_ARCHIL_S3_URL",
} as const;

export interface ArchilFolderOptions {
	disk: string;
	region: string;
	token: string;
	apiKey: string;
	s3Url: string;
	/** For tests; default the global fetch. */
	fetch?: typeof fetch;
}

/** The settings from `env` when all five are there; undefined when none is; throws in words when only some are. */
export function archilSettingsFromEnv(env: Record<string, string | undefined>): ArchilFolderOptions | undefined {
	const values = Object.fromEntries(Object.entries(ARCHIL_ENV).map(([field, name]) => [field, env[name]?.trim() ?? ""])) as Record<keyof typeof ARCHIL_ENV, string>;
	const missing = Object.entries(ARCHIL_ENV).filter(([field]) => values[field as keyof typeof ARCHIL_ENV] === "").map(([, name]) => name);
	if (missing.length === Object.keys(ARCHIL_ENV).length) return undefined;
	if (missing.length > 0) throw new Error(`an Archil run folder needs ${Object.values(ARCHIL_ENV).join(", ")}: ${missing.join(", ")} not set`);
	return values;
}

/** The endpoint, checked: https on an Archil host whose name carries the region, since the account key goes there. */
function endpointOf(s3Url: string, region: string): string {
	const url = new URL(s3Url);
	const [, provider = "", location = ""] = /^([a-z]+)-(.+)$/.exec(region) ?? [];
	if (url.protocol !== "https:" || !url.hostname.endsWith(".archil.com") || !url.hostname.includes(`.${location}.${provider}.`)) {
		throw new Error(`the Archil S3 endpoint must be https on an Archil host for region ${region}, not ${url.origin}`);
	}
	return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** A fresh run's folder on the disk: made (each folder of its path, as the disk's directory markers), and its outside. */
export async function archilFolder(options: ArchilFolderOptions): Promise<RunFolder> {
	const doFetch = options.fetch ?? fetch;
	const base = `${endpointOf(options.s3Url, options.region)}/${encodeURIComponent(options.disk)}`;
	const run = `c${randomBytes(6).toString("hex")}`;
	const runDir = `agents/conformance/runs/${run}`;
	const folder = `${runDir}/work`;
	const url = (key: string) => `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
	const call = async (method: string, key: string, body?: Uint8Array, query = "") => {
		const response = await doFetch(`${url(key)}${query}`, {
			method,
			headers: { Authorization: `Bearer ${options.apiKey}` },
			redirect: "error",
			...(body === undefined ? {} : { body: new Blob([new Uint8Array(body)]) }),
			signal: AbortSignal.timeout(60_000),
		});
		return response;
	};
	const must = async (method: string, key: string, body?: Uint8Array) => {
		const response = await call(method, key, body);
		if (!response.ok) throw new Error(`the Archil file API answered ${method} ${key} with ${response.status}`);
		return response;
	};
	for (const dir of ["agents/", "agents/conformance/", "agents/conformance/runs/", `${runDir}/`, `${folder}/`]) await must("PUT", dir, new Uint8Array());
	return {
		mount: { kind: "archil", disk: options.disk, region: options.region, folder, token: options.token },
		run,
		async read(path) {
			const response = await call("GET", `${folder}/${path}`);
			if (response.status === 404) return undefined;
			if (!response.ok) throw new Error(`the Archil file API answered GET ${path} with ${response.status}`);
			return new Uint8Array(await response.arrayBuffer());
		},
		async write(path, data) {
			await must("PUT", `${folder}/${path}`, data);
		},
		async close() {
			// Every key below the run's folder, deepest first, then the folder's own markers.
			const listed = await doFetch(`${base}?list-type=2&prefix=${encodeURIComponent(`${runDir}/`)}`, {
				headers: { Authorization: `Bearer ${options.apiKey}` },
				redirect: "error",
				signal: AbortSignal.timeout(60_000),
			});
			const keys = listed.ok ? [...(await listed.text()).matchAll(/<Key>([^<]*)<\/Key>/g)].map(([, key]) => key as string) : [];
			for (const key of [...new Set([...keys, `${folder}/`, `${runDir}/`])].sort((a, b) => b.length - a.length)) await call("DELETE", key).catch(() => undefined);
		},
	};
}
