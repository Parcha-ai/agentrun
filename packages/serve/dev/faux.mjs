// The sample data's model: scripted replies chosen from the conversation, so the seeded runs have tool calls, questions,
// failures and long answers to draw, with no key and no network. `npm run dev:seed` and `npm run dev` both load it.
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

/** Sample prices, USD per million tokens, so every run has a cost to show. */
export const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

/** Resolves after `ms` with `then()`, or as an aborted reply as soon as the turn is stopped. */
const after = (faux, ms, then) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(then()), ms);
    faux.signal?.addEventListener("abort", () => (clearTimeout(timer), resolve(faux.message("", { stopReason: "aborted" }))), { once: true });
  });
/** A run that stays `working` until it is cancelled or stopped: six hours, and again after a restart. */
const forever = (faux) => after(faux, 6 * 3600_000, () => faux.message("Done."));
const tool = (faux, name, args) => faux.message(faux.toolCall(name, args), { stopReason: "toolUse" });

const INVOICE_REPORT = `## Invoice check

| Line | Item | Qty | Unit | Amount | Status |
| --- | --- | ---: | ---: | ---: | --- |
| 1 | Hosting, October | 1 | 420.00 | 420.00 | ok |
| 2 | Support hours | 12 | 85.00 | 1,020.00 | ok |
| 3 | Domain renewal | 2 | 18.50 | 39.00 | **off by 2.00** |

**Total on the invoice:** 1,479.00. **Recomputed:** 1,477.00.

- Line 3 multiplies to 37.00, not 39.00.
- Tax is not charged; the invoice says the buyer is exempt.

Next step: ask the vendor for a corrected invoice before paying.`;

const RELEASE_NOTES = `# Release 2.4.0

## Highlights
- **Faster search.** Results show while you type, and a query with a typo still finds what you meant.
- **Dark mode** follows the system setting, with a switch in Settings.

## Changes by area

| Area | Change | Pull request |
| --- | --- | --- |
| Search | Incremental results | #412 |
| Search | Typo tolerance (one edit) | #418 |
| Settings | Theme switch | #420 |
| Export | CSV keeps leading zeros | #423 |

## Fixes
1. Exported CSV files keep leading zeros in postal codes.
2. The sign-in page no longer jumps when the keyboard opens on a phone.
3. A very long project name wraps instead of hiding the menu button.

## Upgrade notes
No migration is needed. The \`search.legacy\` setting is ignored from this release and can be removed.`;

const MEETING = `**Decisions**
- Ship the beta to the waitlist on the 3rd.
- Keep the free tier at 100 runs a month.

**Action items**
- Write the waitlist email (owner: marketing, due Friday).
- Add a usage chart to the settings page (owner: web, due next sprint).
- Draft the pricing FAQ (owner: support).

**Open questions**
- Do we need a status page before the beta? Nobody had numbers on downtime yet.`;

/** A value for a workflow node's `submit` schema: sample text by property name, and otherwise by type. */
function sample(schema, name, said) {
  if (!schema || typeof schema !== "object") return null;
  if (Array.isArray(schema.enum)) {
    const guess = [[/password|log in|sign in/i, "account"], [/how do i|can two|is there a way/i, "question"], [/data loss|gone|crash|down/i, "bug"]].find(([test]) => test.test(said))?.[1];
    return schema.enum.includes(guess) ? guess : schema.enum[0];
  }
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  if (type === "object" || schema.properties) {
    const out = {};
    for (const [key, sub] of Object.entries(schema.properties ?? {})) out[key] = sample(sub, key, said);
    return out;
  }
  if (type === "array") return [sample(schema.items, name, said), sample(schema.items, name, said)];
  if (type === "number" || type === "integer") {
    if (name === "urgency") return /outage|down|cannot log in|data loss/i.test(said) ? 9 : 3;
    if (name === "score") return /enterprise|500 seats|annual/i.test(said) ? 86 : 41;
    return 42;
  }
  if (type === "boolean") return !/no budget|student/i.test(said);
  const words = {
    reply: "Thanks for writing in. We have reproduced the problem and a fix is on its way; we will update this ticket within one business day.",
    summary: "The customer reports the problem started after the last update and affects every user on their team.",
    reason: "Mid-size team, an active trial, and a named budget for this quarter.",
    next_step: "Book a 30-minute call with the team lead this week.",
  };
  return words[name] ?? `Sample ${name ?? "text"}`;
}

export default function reply(context, faux) {
  const users = context.messages.filter((m) => m.role === "user").map(textOf);
  const [first = "", last = ""] = [users[0], users.at(-1)];
  const answered = context.messages.at(-1)?.role === "toolResult";
  const toolResults = context.messages.filter((m) => m.role === "toolResult").length;

  // A workflow's model node delivers its record through `submit`.
  const submit = context.messages.flatMap((m) => (m.role === "system" ? (m.toolsAdded ?? []) : [])).find((t) => t.name === "submit");
  if (submit) {
    if (answered) return faux.message("Submitted.");
    const said = context.messages.map(textOf).join("\n");
    // The node's schema is in its prompt; the tool's own parameters are any object.
    const stated = /Required JSON Schema \(authoritative\): (\{.*\})$/m.exec(said)?.[1];
    const record = () => tool(faux, "submit", sample(stated ? JSON.parse(stated) : submit.parameters, undefined, first.split("\nWhen you are done")[0]));
    if (/takes a while/i.test(said)) return after(faux, 6 * 3600_000, record);
    return record();
  }

  // Invoice checker: writes its findings to a file, then answers with a table; asks for the currency when it is missing.
  if (/invoice/i.test(first)) {
    if (/currency is missing/i.test(first) && users.length === 1 && !answered) {
      return faux.message([faux.thinking("The amounts carry no currency symbol, and the vendor bills in two."), faux.toolCall("ask_person", { question: "Which currency are these amounts in: USD or EUR?" })], { stopReason: "toolUse" });
    }
    if (toolResults === 0 || (users.length > 1 && toolResults === 1)) {
      return faux.message([faux.thinking("Recompute each line, then the total."), faux.toolCall("write", { path: "findings.md", content: `${INVOICE_REPORT}\n` })], { stopReason: "toolUse" });
    }
    return faux.message([faux.text(users.length > 1 ? `Using ${last.trim()}.\n\n${INVOICE_REPORT}` : INVOICE_REPORT)]);
  }

  // Release notes: drafts the file, edits it, then answers with the whole note.
  if (/release notes/i.test(first)) {
    if (/outage/i.test(first)) return faux.message("", { stopReason: "error", errorMessage: "The model provider returned 503 Service Unavailable (sample failure)." });
    if (toolResults === 0) return tool(faux, "write", { path: "CHANGELOG.md", content: RELEASE_NOTES.replace("Typo tolerance (one edit)", "Typo tolerance") });
    if (toolResults === 1) return tool(faux, "edit", { path: "CHANGELOG.md", edits: [{ oldText: "Typo tolerance |", newText: "Typo tolerance (one edit) |" }] });
    return faux.message([faux.thinking("Both files agree; answer with the note."), faux.text(RELEASE_NOTES)]);
  }

  // Meeting notes: long-running until stopped (a follow-up then answers), failing, or plain, by the input.
  if (/workshop/i.test(first)) return users.length === 1 ? forever(faux) : faux.message([faux.text(`So far:\n\n${MEETING}`)]);
  if (/meeting/i.test(first)) {
    if (/garbled/i.test(first)) return faux.message("", { stopReason: "error", errorMessage: "The model's response was cut off and could not be read (sample failure)." });
    return faux.message([faux.thinking("Group what was said into decisions, actions and questions."), faux.text(MEETING)]);
  }

  if (/recipe|servings/i.test(first)) return faux.message("For 6 servings: 450 g pasta, 3 cloves garlic, 90 ml olive oil, 1.5 tsp chili flakes, and salt to taste.");
  return faux.message(`On "${last.slice(0, 120)}": done.`);
}
