// What this package's own modules hand each other and no caller of it sees: index.ts exports none of it, and the
// package exports index.js alone.
import type { ReadOptions } from "./reader.js";

/** A read option keyed by a symbol, so no ReadOptions a caller writes can name it: true when the caller drops the read's
 *  cursor unread (parseHome with no state, the read pool's workers, readSession). The read then makes no copy for that
 *  cursor: its state is the read's own. A totals read's cursor holds the read's own counts, not a copy trimmed to its
 *  requests (the copy is the size of the counts), and its session and source state keep what a kept cursor forgets. A
 *  file whose last line has no newline yet is read with no copy of its whole state to leave that line out, so the
 *  cursor's state then holds the line its offset is before: hand such a cursor to no read. */
export const DROPS_CURSOR: unique symbol = Symbol("dropsCursor");

/** ReadOptions with this package's own option. */
export type InternalReadOptions = ReadOptions & { [DROPS_CURSOR]?: boolean };
