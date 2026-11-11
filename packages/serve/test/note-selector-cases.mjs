// The seeds and options the note selector's golden test (note-selector.test.mjs) runs learnedParts over: an
// agent with nothing, notes that all fit, notes past the budget, an index naming a note main does not hold whole, an index
// naming only some notes, a budget of 0, each with and without the read tool, and a note holding a value the host keeps secret.
import { note } from "./fixtures/faux-learn.mjs";

const line = (name, file, description) => `- [${name}](${file}) — ${description}`;
/** `n` notes, `bytes` long each in their body, the newest first, with an index that names each. */
function notes(n, bytes, { missing = false } = {}) {
  const files = Array.from({ length: n }, (_, i) => `note-${String(i).padStart(2, "0")}.md`);
  const text = Object.fromEntries(files.map((file, i) => [file, note(`Note ${i}`, `When note ${i} applies`, `${`Rule ${i}. `.repeat(Math.ceil(bytes / 8)).slice(0, bytes)}\n`)]));
  const index = [...files.map((file, i) => line(`Note ${i}`, file, `When note ${i} applies`)), ...(missing ? [line("Gone", "gone.md", "A note main does not hold")] : [])].join("\n");
  return { sha: "s".repeat(40), index, notes: text, files: [...files, "MEMORY.md"], skipped: [], recent: [...files].reverse() };
}

export const SECRET = "not-a-secret-selector-value-0123456789";
export const CASES = [
  ["nothing learned", { sha: "s".repeat(40), notes: {}, files: [], skipped: [] }],
  ["three that fit", notes(3, 200)],
  ["forty past the budget", notes(40, 600)],
  ["an index naming a note main lacks", notes(3, 200, { missing: true })],
  ["one note larger than the budget", notes(2, 9000)],
  ["an index naming some notes, past the budget", { ...notes(12, 900), index: notes(12, 900).index.split("\n").slice(0, 4).join("\n") }],
  ["a note holding a secret", { ...notes(2, 100), notes: { ...notes(2, 100).notes, "note-01.md": note("Note 1", "When note 1 applies", `The pass is ${SECRET}.\n`) } }],
];
export const OPTIONS = [
  ["8000, read", { budget: 8000, read: true }],
  ["8000, no read", { budget: 8000, read: false }],
  ["0, read", { budget: 0, read: true }],
  ["2000, read", { budget: 2000, read: true }],
];

/** Topics an agent learned about, each with the words its notes use. */
const TOPICS = [
  ["invoices", "Reconcile invoices", "Match each invoice total to its ledger entry, and flag an invoice whose currency differs from the ledger's."],
  ["refunds", "Refund policy pages", "Refund policies live under /help/refunds; quote the refund window in days."],
  ["shipping", "Shipping estimates", "Shipping estimates come from the carrier's tracking page; never promise a delivery date."],
  ["migrations", "Database migrations", "Every schema migration gets a down migration and runs inside one transaction."],
  ["tables", "Answer with tables", "When comparing options, answer with a table: one row per option."],
];
/** `n` notes, `per` per topic in turn, each `pad` bytes of filler after its rule, the newest first: a topic's notes are
 *  spread through the history, and the newest ones are about whatever topic came last. */
export function topical(n, pad = 400) {
  const files = Array.from({ length: n }, (_, i) => `${TOPICS[i % TOPICS.length][0]}-${String(i).padStart(2, "0")}.md`);
  const text = Object.fromEntries(files.map((file, i) => {
    const [, name, rule] = TOPICS[i % TOPICS.length];
    return [file, note(`${name} ${i}`, rule.split(";")[0].split(",")[0], `${rule}\n\n${"Kept from an earlier run. ".repeat(Math.ceil(pad / 25)).slice(0, pad)}\n`)];
  }));
  const index = files.map((file, i) => line(`${TOPICS[i % TOPICS.length][1]} ${i}`, file, TOPICS[i % TOPICS.length][2].split(";")[0].split(",")[0])).join("\n");
  return { sha: "t".repeat(40), index, notes: text, files: [...files, "MEMORY.md"], skipped: [], recent: [...files].reverse() };
}
