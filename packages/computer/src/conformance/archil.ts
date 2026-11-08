// The Archil run folder for the mount cases, shared by every remote provider's conformance module (Daytona, Modal,
// E2B): a fresh agents/<agent>/runs/<run>/work on the owner's disk, the mount that reaches it from inside a computer,
// and its outside, read and written through the disk's object API. The object API is given, or the host's own Archil
// SDK (the npm package `disk`, not a dependency of this package, imported only here and only when asked): `new Archil({
// apiKey, region, s3BaseUrl })`, then `disks.get(disk)`, whose disk has getObject, putObject and deleteObject with keys
// relative to the disk's root, and rejects with the HTTP `status` when there was an answer (404: not there). Every
// setting is passed to the SDK, so it reads none of its own from the environment.
//
// Two secrets ride here, never in a word: the disk token, which only the mount takes (the root helper's stdin in the
// computer), and the account API key, which only the SDK takes, for the object API. The settings are options; each
// module reads them from the COMPUTER_ARCHIL_* names ARCHIL_ENV lists (archilSettings).
import { randomBytes } from "node:crypto";
import type { RunFolder } from "./types.js";

/** The settings of the Archil mount cases, by the names a conformance module reads them from. */
export const ARCHIL_ENV = {
	/** The disk the run folders are made on: dsk-<16 hex digits>, or owner/name. */
	archilDisk: "COMPUTER_ARCHIL_DISK",
	/** Its region, such as aws-us-east-1. */
	archilRegion: "COMPUTER_ARCHIL_REGION",
	/** A disk token, which the mount in the computer takes. */
	archilToken: "COMPUTER_ARCHIL_TOKEN",
	/** The account API key, which the object API outside takes. */
	archilApiKey: "COMPUTER_ARCHIL_API_KEY",
	/** The disk's S3-compatible endpoint, https on an Archil host of the region: the key goes to it. */
	archilS3Url: "COMPUTER_ARCHIL_S3_URL",
} as const;

/** The part of an Archil disk's object API a run folder is reached through from outside: keys relative to the disk's root. */
export interface ArchilObjects {
	getObject(key: string): Promise<Uint8Array>;
	putObject(key: string, body: Uint8Array): Promise<unknown>;
	deleteObject(key: string): Promise<void>;
}

/** The SDK's Archil client constructor, as far as a run folder calls it. */
export type ArchilConstructor = new (options: { apiKey: string; region: string; s3BaseUrl: string; baseUrl?: string }) => {
	disks: { get(id: string): Promise<ArchilObjects> };
};

export interface ArchilRunFolderOptions {
	/** The disk: dsk-<16 hex digits>, or owner/name. */
	disk: string;
	/** Its region, such as aws-us-east-1. */
	region: string;
	/** The disk token the mount takes. */
	token: string;
	/** The folder's agent; default "conformance". */
	agent?: string;
	/** The folder's run; default a fresh one. */
	run?: string;
	/** The disk's object API. Default: the SDK's client (Archil), with apiKey and s3BaseUrl. */
	objects?: ArchilObjects;
	/** The account API key, for the SDK's client. */
	apiKey?: string;
	/** The disk's S3-compatible endpoint, for the SDK's client. */
	s3BaseUrl?: string;
	/** Another control plane than the region's, for the SDK's client. */
	baseUrl?: string;
	/** The SDK's Archil client; default the host's `disk` package's. */
	Archil?: ArchilConstructor;
}

/** Not a literal, so no type checker or bundler resolves the SDK from this package. */
const ARCHIL_PACKAGE: string = "disk";
// The shapes the root helper takes (box/agentrun-archil), so a run folder is one a computer can mount.
const DISK = /^(?:dsk-[0-9a-f]{16}|[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
const REGION = /^[a-z0-9]+-[a-z0-9][a-z0-9-]{0,62}$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Why an S3 endpoint is not one the account key may go to, or undefined: https, on an Archil host of the region. */
function s3Problem(s3BaseUrl: string, region: string): string | undefined {
	let url: URL;
	try {
		url = new URL(s3BaseUrl);
	} catch {
		return "is not a URL";
	}
	if (url.protocol !== "https:") return "must be https: the account key goes to it";
	if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return "carries more than a scheme, a host and a path";
	const [, provider = "", location = ""] = /^([a-z0-9]+)-(.+)$/.exec(region) ?? [];
	const host = url.hostname.toLowerCase();
	if (!host.endsWith(".archil.com") || !host.includes(`.${location}.${provider}.`)) return `must be an Archil host of the region ${region}, not ${host}`;
	return undefined;
}

/**
 * The Archil mount cases' settings from the COMPUTER_ARCHIL_* names (ARCHIL_ENV); undefined when none is set. Some set
 * and some not, a disk or region of another shape, or an S3 endpoint the key must not go to, is a mistake said in
 * words that name the setting and hold no secret.
 */
export function archilSettings(env: Record<string, string | undefined>): Required<Pick<ArchilRunFolderOptions, "disk" | "region" | "token" | "apiKey" | "s3BaseUrl">> | undefined {
	const names = Object.values(ARCHIL_ENV);
	if (names.every((name) => !env[name])) return undefined;
	const missing = names.filter((name) => !env[name]);
	if (missing.length > 0) throw new Error(`the Archil mount cases need ${names.join(", ")} together: ${missing.join(", ")} is not set`);
	const read = (name: string) => env[name] as string;
	const [disk, region, token, apiKey, s3BaseUrl] = [read(ARCHIL_ENV.archilDisk), read(ARCHIL_ENV.archilRegion), read(ARCHIL_ENV.archilToken), read(ARCHIL_ENV.archilApiKey), read(ARCHIL_ENV.archilS3Url)];
	if (!DISK.test(disk)) throw new Error(`${ARCHIL_ENV.archilDisk} is a disk id (dsk- and 16 hex digits) or owner/name`);
	if (!REGION.test(region)) throw new Error(`${ARCHIL_ENV.archilRegion} is a provider, a dash and its region, such as aws-us-east-1`);
	const s3 = s3Problem(s3BaseUrl, region);
	if (s3 !== undefined) throw new Error(`${ARCHIL_ENV.archilS3Url} ${s3}`);
	return { disk, region, token, apiKey, s3BaseUrl };
}

/** An SDK failure in words: its status and message, with the key taken out. */
function failure(what: string, error: unknown, apiKey: string): Error {
	const status = (error as { status?: unknown } | null)?.status;
	const message = (error instanceof Error ? error.message : String(error)).replaceAll(apiKey, "[key]").replace(/\s+/g, " ").slice(0, 300);
	return Object.assign(new Error(`${what}: ${message}`), typeof status === "number" ? { status } : {});
}

/** The disk's object API from the SDK's client: every setting given, the disk looked up once. */
async function sdkObjects({ disk, region, apiKey, s3BaseUrl, baseUrl, Archil }: ArchilRunFolderOptions): Promise<ArchilObjects> {
	if (!apiKey || !s3BaseUrl) throw new Error(`the Archil run folder reaches its disk through the object API: give objects, or apiKey and s3BaseUrl (${ARCHIL_ENV.archilApiKey}, ${ARCHIL_ENV.archilS3Url})`);
	const Client = Archil ?? ((await import(ARCHIL_PACKAGE)) as { Archil: ArchilConstructor }).Archil;
	try {
		return await new Client({ apiKey, region, s3BaseUrl, ...(baseUrl === undefined ? {} : { baseUrl }) }).disks.get(disk);
	} catch (error) {
		throw failure(`looking up the Archil disk ${disk}`, error, apiKey);
	}
}

/**
 * A fresh run folder, agents/<agent>/runs/<run>/work on the disk, and the Archil mount that reaches it, with the token.
 * Outside, a file reads undefined when it is not there (the SDK's 404), and any other failure is thrown; a path is
 * inside the folder or refused. close removes every file the case wrote or read there (so those the computer wrote and
 * the case read back), and the folder's other keys are the disk's to keep.
 */
export async function archilRunFolder(options: ArchilRunFolderOptions): Promise<RunFolder> {
	const { disk, region, token, agent = "conformance", run = `c${randomBytes(6).toString("hex")}` } = options;
	if (!SEGMENT.test(agent)) throw new Error("the Archil run folder's agent is letters, digits, _ and -, starting with a letter or digit");
	if (!SEGMENT.test(run)) throw new Error("the Archil run folder's run is letters, digits, _ and -, starting with a letter or digit");
	const objects = options.objects ?? (await sdkObjects(options));
	const folder = `agents/${agent}/runs/${run}/work`;
	const touched = new Set<string>();
	const key = (path: string) => {
		if (typeof path !== "string" || path === "" || path.startsWith("/") || path.split("/").includes("..")) throw new Error(`a run folder's file is a path inside it, not ${JSON.stringify(path)}`);
		const at = `${folder}/${path}`;
		touched.add(at);
		return at;
	};
	return {
		mount: { kind: "archil", disk, region, folder, token },
		read: async (path) => {
			const at = key(path);
			try {
				return await objects.getObject(at);
			} catch (error) {
				if ((error as { status?: unknown } | null)?.status === 404) return undefined;
				throw error;
			}
		},
		write: async (path, data) => {
			await objects.putObject(key(path), data);
		},
		close: async () => {
			for (const at of touched) await objects.deleteObject(at).catch(() => {});
		},
	};
}
