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

/** A read option keyed by a symbol, as DROPS_CURSOR is: true reads a file's next chunk only after this one's lines are
 *  read, into one buffer. Unset, the next chunk is read while this one's lines are, which pays where a core is spare to
 *  make the read (parseHome's own thread). The read pool's workers set it: their threads take every core they are given,
 *  so a read made ahead waits for one, and its chunk lands on another core than the one that reads it. */
export const NO_READ_AHEAD: unique symbol = Symbol("noReadAhead");

/** ReadOptions with this package's own options. */
export type InternalReadOptions = ReadOptions & { [DROPS_CURSOR]?: boolean; [NO_READ_AHEAD]?: boolean };
