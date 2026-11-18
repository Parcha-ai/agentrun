// The public address this server last served at (AGENTRUN_PUBLIC_URL), kept in its data folder. A change of it signs the
// owner out (the session cookie is kept per host) and leaves the links in earlier webhook messages on the old address, so a
// start that finds it changed says so in its log, and the server sends a browser that still opens the old address on to
// the new one (server.ts, host-check.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hostName } from "./host-check.js";
import { writeDurableSync } from "./server-fs.js";

/** The file, in the data folder: `{ "url": <the address, or null for none>, "earlier": <the one before it, or null> }`. */
export const PUBLIC_ADDRESS_FILE = ".public-url";

type Kept = { url: string | null; earlier: string | null };

/** An address as the CLI takes it: parsed, without a trailing slash. None, null. */
const normal = (url: string | undefined): string | null => (url === undefined ? null : URL.canParse(url) ? new URL(url).href.replace(/\/+$/, "") : url);

const keptOf = (text: string): Kept | undefined => {
  try {
    const kept = JSON.parse(text) as Partial<Kept>;
    const field = (value: unknown) => (typeof value === "string" ? value : null);
    return kept && typeof kept === "object" && "url" in kept ? { url: field(kept.url), earlier: field(kept.earlier) } : undefined;
  } catch {
    return undefined;
  }
};

/** What a start finds: `changed` when the folder remembered another address (none counts), and `earlier`, the address the
 *  server had before its current one, kept across starts until the next change. `keep` remembers the current address; a
 *  start calls it only once it serves, so a start that fails leaves the folder's address, and its earlier one, as they were. */
export type PublicAddress = { changed?: { from: string | null; to: string | null }; earlier: string | null; keep: (warn: (said: string) => void) => void };

/** Reads the address `data` remembers and compares it with `publicUrl`. A folder that remembers none (a first start, or a
 *  file that is not one) has no change to report. `keep` writes it as the folder's other files are written (whole and
 *  synced, mode 600), and only when it differs; a write that fails is told to `warn` and stops nothing: the next start
 *  compares again. */
export function readPublicAddress(data: string, publicUrl: string | undefined): PublicAddress {
  const path = join(data, PUBLIC_ADDRESS_FILE);
  const url = normal(publicUrl);
  let text: string | undefined;
  try {
    text = readFileSync(path, "utf8");
  } catch {}
  const before = text === undefined ? undefined : keptOf(text);
  const changed = before !== undefined && before.url !== url;
  const now: Kept = { url, earlier: changed ? (before.url ?? before.earlier) : (before?.earlier ?? null) };
  const written = JSON.stringify(now);
  const keep = (warn: (said: string) => void) => {
    if (written === text) return;
    try {
      writeDurableSync(path, written);
    } catch (error) {
      warn(`the public address could not be remembered in ${PUBLIC_ADDRESS_FILE}: ${(error as Error).message}`);
    }
  };
  return { ...(changed ? { changed: { from: before.url, to: url } } : {}), earlier: now.earlier, keep };
}

/** The log line's words for a change. */
export const publicAddressChanged = "the public address (AGENTRUN_PUBLIC_URL) changed: the owner signs in again at the new address, and links in earlier webhook messages point to the old one";

/** Where a request under the earlier address is sent on to: `from`, the earlier address's name, and `to`, the address
 *  people open now (`publicUrl`, parsed, so a name in any script is written as a header carries it, without a trailing
 *  slash). Set only when the server has a public address now and the earlier one's name is none it answers to (`served`:
 *  its own names, its --allow-host names and the new address's). */
export function movedAddress(earlier: string | null, publicUrl: string | undefined, served: ReadonlySet<string>): { from: string; to: string } | undefined {
  if (earlier === null || publicUrl === undefined || !URL.canParse(earlier) || !URL.canParse(publicUrl)) return undefined;
  const from = hostName(new URL(earlier).host);
  return from !== undefined && !served.has(from) ? { from, to: normal(publicUrl)! } : undefined;
}
