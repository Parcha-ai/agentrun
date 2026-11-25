// What this package's own modules hand each other and no caller of it sees: index.ts exports none of it, and the
// package exports index.js alone.
import type { ReadOptions } from "./reader.js";

/** A read option keyed by a symbol, so no ReadOptions a caller writes can name it: true when the caller drops the read's
 *  cursor unread (parseHome with no state, the read pool's workers). A totals read's cursor then holds the read's own
 *  counts, not a copy trimmed to its requests: the copy is the size of the counts (a cursor kept carries no room to grow
 *  into). The cursor is still one a later read can go on from. */
export const DROPS_CURSOR: unique symbol = Symbol("dropsCursor");

/** ReadOptions with this package's own option. */
export type InternalReadOptions = ReadOptions & { [DROPS_CURSOR]?: boolean };
