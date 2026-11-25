// The one UUIDv7 minter: every run id (a managed run's, an SDK run's, a promotion's replays, an eval's seeded runs), the
// ids of agents, revisions and tentative inline agents, and upload ids. No imports, so any module takes it alone.

/** The last millisecond a UUIDv7 was minted in, and how many were minted in it. */
let mintedMs = -1;
let mintedInMs = 0;

/** A UUIDv7: time-ordered, so a listing by (time, id) is stable. Two minted in one millisecond keep their order: the 12
 *  bits after the time count them up (RFC 9562's monotonic counter), and a clock that steps back keeps the last
 *  millisecond, so each id sorts after the one before it. Without that, two runs started in one millisecond tie on
 *  started_at, and their random ids list and claim them in either order; two edits tie on created_at, and the newer
 *  revision can be numbered first.
 *  `{ at }`: the id of that instant, outside the count: its time is `at` (one in the past is kept, never moved to the last
 *  millisecond minted), the 12 bits after it random. For a record written as of an earlier time (eval-previous.ts seeds
 *  runs that started a day apart), whose id must sort by that time. */
export function uuidv7(when: number | { at: number } = Date.now()): string {
  const bytes = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
  if (typeof when === "number") {
    if (when > mintedMs) {
      mintedMs = when;
      mintedInMs = 0;
    } else if (++mintedInMs > 0xfff) {
      mintedMs += 1;
      mintedInMs = 0;
    }
    bytes.writeUIntBE(mintedMs, 0, 6);
    bytes[6] = 0x70 | (mintedInMs >> 8);
    bytes[7] = mintedInMs & 0xff;
  } else {
    bytes.writeUIntBE(when.at, 0, 6);
    bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  }
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
