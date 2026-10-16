import type { Context } from "@earendil-works/chord";
import { defineDocFamily, type Harness, type JsonObject } from "@earendil-works/pi-durable";
import type { PlacementRecord } from "./placer.ts";

/**
 * The session's placement decisions, one document per decision, keyed by its id: in the session's own store, so they
 * travel with it wherever it runs, and a recording reads them as durable lines of source `transport`. The kind, the
 * version and the key are a stored format.
 */
export const PlacementsDoc = defineDocFamily<JsonObject, null>({
	kind: "transport.placements",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({}),
});

/**
 * Whether `value` is a placement record this package writes: version 1, an id, `by` only `jev` or `config`, and every
 * field a reader of the log needs. A store keeps the first record under an id, so an incomplete one is refused, never
 * kept where the whole one could no longer go.
 */
export function isPlacementRecord(value: unknown): value is PlacementRecord {
	const record = value as Partial<PlacementRecord> | null;
	return (
		typeof record === "object" &&
		record !== null &&
		record.v === 1 &&
		typeof record.id === "string" &&
		record.id !== "" &&
		typeof record.session === "string" &&
		typeof record.at === "string" &&
		(record.phase === "message" || record.phase === "turn_end") &&
		(record.what === "home" || record.what === "hands") &&
		(record.by === "jev" || record.by === "config") &&
		typeof record.current === "string" &&
		typeof record.target === "string" &&
		typeof record.moved === "boolean" &&
		typeof record.reason === "string" &&
		Number.isFinite(record.latencyMs) &&
		(record.latencyMs as number) >= 0
	);
}

/**
 * Write a decision into the session's store, in one commit of the Harness that runs it. A decision already there is
 * left as it is: the same record sent again changes nothing.
 */
export async function writePlacement(
	harness: Pick<Harness, "commit">,
	record: PlacementRecord,
	context: Context,
): Promise<void> {
	await harness.commit(async (tx) => {
		const stored = await tx.doc(PlacementsDoc, record.id, null);
		if (stored.v !== undefined) return;
		Object.assign(stored, JSON.parse(JSON.stringify(record)) as JsonObject);
	}, context);
}
