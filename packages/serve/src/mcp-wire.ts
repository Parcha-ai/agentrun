// What the MCP probe (mcp-probe.ts: a save's and a refresh's listing) and the run's gateway (mcp-gateway.ts: a call) share
// of the wire: the one credential scrubber, the one cap on an upstream answer, and the one SDK client the two build.
// A leaf: no store, no run, nothing sent here.

/** The most of one upstream answer read, by the probe and the gateway alike. */
export const MAX_RESPONSE = 4 * 1024 * 1024;

/** `text` with every credential value in `values` replaced, whole and as its bare token (with any one-word scheme, such
 *  as `Bearer ` or `Basic `, taken off): an upstream answer or error that echoes a header, or only its token, never shows
 *  it to the model, the harness, the owner's save or the run's files. A value under 8 characters is not cut (it would
 *  cut ordinary words). */
export const scrub = (text: string, values: Iterable<string>): string =>
  [...values].flatMap((value) => [value, value.replace(/^[A-Za-z][A-Za-z0-9_-]*\s+(?=\S+$)/, "")]).sort((a, b) => b.length - a.length).reduce((out, value) => (value.length >= 8 ? out.split(value).join("[redacted]") : out), text);

/** `res` with its body cut off at MAX_RESPONSE: past it the body errors, and `over` is told. */
export function capped(res: Response, over?: () => void): Response {
  if (!res.body) return res;
  let read = 0;
  const body = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      read += chunk.byteLength;
      if (read > MAX_RESPONSE) {
        over?.();
        controller.error(new Error(`its answer is longer than ${MAX_RESPONSE} bytes`));
      } else controller.enqueue(chunk);
    },
  }));
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** The official SDK client and its Streamable HTTP transport for `url`, one setup for every MCP connection: the
 *  2026-07-28 revision first, a 2025-era server through its initialize. `fetch` is how every request goes (the caller's
 *  guard: credential, address check, no redirect, cap); `requestInit` is what the transport sends with each. */
export function mcpClient(sdk: typeof import("@modelcontextprotocol/client"), { name, version, url, fetch, requestInit }: { name: string; version: string; url: URL; fetch: typeof globalThis.fetch; requestInit?: RequestInit }) {
  const transport = new sdk.StreamableHTTPClientTransport(url, { fetch, ...(requestInit ? { requestInit } : {}) });
  const client = new sdk.Client({ name, version }, { capabilities: {}, versionNegotiation: { mode: "auto" } });
  return { client, transport };
}
