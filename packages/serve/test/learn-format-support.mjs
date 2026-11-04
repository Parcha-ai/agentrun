// Made-up notes in Claude Code's auto-memory format, a folder of them, and a run's changes to it.
import { parseNoteFile } from "../dist/learn/notes.js";

export const RUN = "2026-10-27-0412-a1b2";

/** A note's file: front matter with `name`, `description` and `type`, any `extra` lines, then the body. */
export const note = ({ name = "Refund policy path", description = "Shopify stores keep their policies at /policies/", type = "reference", extra = "", body = "Open /policies/ before searching the store.\n" } = {}) =>
  `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n${extra}---\n${body}`;

/** The seed a run started from: two active notes, one superseded, and the index. */
export const SEED = {
  "MEMORY.md": "- [Prefers tables](prefers-tables.md) — The user reads results as tables\n- [Shipping path](shipping-path.md) — Shipping lives under /policies/ too\n",
  "prefers-tables.md": note({ name: "Prefers tables", description: "The user reads results as tables", type: "user" }),
  "shipping-path.md": note({ name: "Shipping path", description: "Shipping lives under /policies/ too" }),
  "old-refunds.md": note({ name: "Old refunds", description: "Refunds were under /help/", extra: "status: superseded\nsuperseded_by: shipping-path.md\n" }),
};

/** A folder's base, as the checker reads it: every path, and its active notes. */
export const baseOf = (files = SEED) => ({
  files: Object.keys(files),
  active: Object.entries(files).flatMap(([file, text]) => {
    const parsed = file === "MEMORY.md" ? [] : parseNoteFile(file, text);
    return Array.isArray(parsed) || parsed.status !== "active" ? [] : [parsed];
  }),
});

/** A new file of the run's, as the host hands it to the checker. */
export const added = (path, text, extra = {}) => ({ path, status: "added", mode: "100644", bytes: Buffer.from(text), ...extra });
