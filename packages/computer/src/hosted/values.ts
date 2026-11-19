// Small readings every hosted vendor makes of what its API answers: a whole number, a value in words, a date; and the
// label codec of a vendor whose labels can't hold the adapter's as they are.
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { HostFacts } from "../host.js";
import type { ComputerSpec, Refusal } from "../provider.js";

/** A host name, as a vendor's domain option is one: DNS labels and a top-level name of letters. */
export const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const isWhole =(value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

/** A vendor whose computer has its image's size: a spec's cpus or memoryMb, refused in words (computer: "an E2B computer"). */
export function sizeRefusals(spec: Partial<ComputerSpec>, computer: string, image: string): Refusal[] {
	return (["cpus", "memoryMb"] as const).filter((field) => spec[field] !== undefined).map((field) => ({ field, message: `${computer} has the size of its ${image}: name a ${image} of the size you need, not ${field}` }));
}

/** A time the vendor reports: a Date, an ISO string, or a whole number of ms (or seconds); undefined when it is none of them. */
export function dateOf(value: unknown, unit: "ms" | "s" = "ms"): Date | undefined {
	const at = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : isWhole(value) ? value * (unit === "s" ? 1000 : 1) : Number.NaN;
	return Number.isNaN(at) ? undefined : new Date(at);
}

/** The label a packed machine is listed by (packLabels): its value is the machine's name, MachineRequest.name. */
export const PACKED_NAME = "agentrun";
/** The packed map's parts: agentrun-0, agentrun-1, and on. */
const PART = `${PACKED_NAME}-`;
/** The most bytes of a packed map's JSON: unpackLabels inflates no more. */
const PACKED_JSON_MAX = 1 << 20;

/**
 * A machine's labels as a vendor whose labels can't hold them as they are stores them (facts.labels.packed): a cap of 5
 * tags, Kubernetes' values, Cloudflare's 16-byte names, a list of strings. PACKED_NAME, the one label a host's list
 * filters on, holds name; the whole map, as JSON, deflated and base64url, goes in parts of at most valueBytes. Every name
 * is at most 11 bytes of [a-z0-9-], every value [A-Za-z0-9_-] with a letter or digit at each end, and no "=", so a
 * host of a string list stores each as name=value. unpackLabels reads the map back exactly. A map that does not fit
 * room (count, bytes and valueBytes, of the packed labels), or whose JSON is past PACKED_JSON_MAX, is refused in words.
 */
export function packLabels(labels: Record<string, string>, name: string, room: Exclude<HostFacts["labels"], "machine"> = {}): { labels: Record<string, string> } | { problem: string } {
	const json = Buffer.from(JSON.stringify(labels));
	if (json.length > PACKED_JSON_MAX) return { problem: `its labels come to ${json.length} bytes as JSON, past the ${PACKED_JSON_MAX} a packed map holds` };
	const payload = deflateRawSync(json).toString("base64url");
	const { count, bytes, packed } = room;
	// base64url can begin or end with - or _, which a Kubernetes value can't: each part is wrapped in a letter.
	const size = (packed?.valueBytes ?? payload.length + 2) - 2;
	if (size < 1 || Buffer.byteLength(name) > size + 2) return { problem: `its labels' values hold at most ${packed?.valueBytes} bytes, too few for the name ${name} and a part of the rest` };
	const parts: Array<[string, string]> = [];
	for (let at = 0; at < payload.length; at += size) parts.push([`${PART}${parts.length}`, `p${payload.slice(at, at + size)}p`]);
	const all: Array<[string, string]> = [[PACKED_NAME, name], ...parts];
	const total = all.reduce((sum, [key, value]) => sum + key.length + Buffer.byteLength(value), 0);
	if ((count !== undefined && all.length > count) || (bytes !== undefined && total > bytes))
		return { problem: `its labels pack into ${all.length} labels of ${total} bytes in all, past the ${[count === undefined ? "" : `${count} labels`, bytes === undefined ? "" : `${bytes} bytes`].filter(Boolean).join(" and ")} it keeps` };
	return { labels: Object.fromEntries(all) };
}

/** The labels packLabels packed in stored, exactly; undefined where stored holds no packed map (a machine not the adapter's). */
export function unpackLabels(stored: Record<string, string>): Record<string, string> | undefined {
	let payload = "";
	for (let part = 0; stored[`${PART}${part}`] !== undefined; part++) payload += stored[`${PART}${part}`]?.slice(1, -1);
	if (payload === "") return undefined;
	try {
		const map: unknown = JSON.parse(inflateRawSync(Buffer.from(payload, "base64url"), { maxOutputLength: PACKED_JSON_MAX }).toString());
		return typeof map === "object" && map !== null && !Array.isArray(map) && Object.values(map).every((value) => typeof value === "string") ? (map as Record<string, string>) : undefined;
	} catch {
		return undefined;
	}
}
