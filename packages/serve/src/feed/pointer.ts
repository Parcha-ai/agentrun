// A JSON Pointer read (RFC 6901), kept apart from the feed parser so the trigger reads it without loading the parser.

/** The value at JSON Pointer `pointer` in `doc`, or undefined. */
export function pointed(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc;
  let at: unknown = doc;
  for (const raw of pointer.split("/").slice(1)) {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(at) && /^(0|[1-9]\d*)$/.test(part)) at = at[Number(part)];
    else if (at && typeof at === "object" && !Array.isArray(at) && Object.hasOwn(at, part)) at = (at as Record<string, unknown>)[part];
    else return undefined;
  }
  return at;
}
