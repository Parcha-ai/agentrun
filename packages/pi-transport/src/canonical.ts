/** JSON with every object's keys in order, and no `undefined` field: the same value is the same text. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}
