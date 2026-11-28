// A run file's text under the run's cut: the one step the served cut read (run-reads-over-store.ts cutRunFile,
// GET /runs/{id}/files/{path}?cut=run) and a share's export (run-export.ts) both take, so a file a bundle carries is
// cut at least as the server's own cut read of it is, before the share scrubber reads it.

import { redactSecrets } from "./learn/secrets.js";

/** File text `text` cut of the run's cut set `values` through redactSecrets over the whole text: each value and secret
 *  shape replaced by "[redacted]" in place, and the text "[redacted]" whole when a value still shows in another form
 *  (wrapped over line breaks, re-encoded). `census` is where the run's census says values its end erased sat in this
 *  file (run-census.ts censusCut): those spans are cut too, and "whole" withholds the text whole. */
export function cutFileText(text: string, values: readonly string[], census: readonly (readonly [number, number])[] | "whole" = []): string {
  if (census === "whole") return "[redacted]";
  return redactSecrets(text, values, Buffer.byteLength(text), census);
}
