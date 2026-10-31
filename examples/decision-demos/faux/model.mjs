// serve's --faux model module: answers the batch-20 workflow's one `llm` call (the zero-shot report) document by
// document from the records in its prompt, slowly enough to look like a model writing. Any other prompt gets a short
// reply. Priced (USD per million tokens) so the run shows a cost; the price is a fixture, not a real model's.
export const cost = { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 };

const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

const after = (text, marker) => {
  const at = text.indexOf(marker);
  if (at < 0) return undefined;
  const line = text.slice(at + marker.length).trimStart().split("\n")[0];
  try { return JSON.parse(line); } catch { return undefined; }
};

const KIND = { certificate_of_incorporation: "certificate of incorporation", ein_letter: "IRS EIN notice (CP 575)", bank_letter: "bank account letter", other: "document of another kind" };
const NEXT = {
  valid: "No action needed; file it with the case.",
  invalid: "Do not accept it. Ask the applicant for a certified copy straight from the issuer.",
  review: "A reviewer should compare it against the issuer's own record before accepting it.",
};

function report(prompt) {
  const records = after(prompt, "RECORDS (JSON):") ?? [];
  const unreadable = after(prompt, "UNREADABLE (JSON):") ?? [];
  const totals = after(prompt, "Totals:") ?? {};
  const lines = ["# Document review", ""];
  for (const r of records) {
    const p = r.probabilities ?? {};
    const shown = Object.entries(p).filter(([, v]) => typeof v === "number").map(([k, v]) => `${k.replace(/_/g, " ")} ${v.toFixed(2)}`).join(", ");
    lines.push(`## ${r.document}`, "", `**${String(r.verdict).toUpperCase()}**, a ${KIND[r.kind] ?? r.kind}.`);
    if (r.verdict === "valid") lines.push(r.decided_by === "second_look" ? `The first pass left a check unclear; a second look at the page cleared it. Probabilities: ${shown}.` : `Every check passed on the first pass (${shown}).`);
    else lines.push(`The checks found: ${(r.reasons ?? []).join("; ") || "no specific reason recorded"}.${r.decided_by === "second_look" ? " A second look at the page did not clear it." : ""}`);
    lines.push(NEXT[r.verdict] ?? "", "");
  }
  for (const u of unreadable) lines.push(`## ${u.document}`, "", "**UNREADABLE**.", `The ${u.step} step failed (${u.error}). Ask for a clean copy.`, "");
  lines.push("## Summary", "", `Of ${totals.total ?? records.length} documents, ${totals.valid ?? 0} are valid, ${totals.invalid ?? 0} invalid, ${totals.review ?? 0} need a person and ${totals.unreadable ?? 0} could not be read. The invalid ones show tampering or missing marks a reviewer can see on the page; none should be accepted without a fresh copy from the issuer.`);
  return lines.join("\n");
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const speed = Number(process.env.DEMO_FAUX_SPEED ?? "1");
  const timer = setTimeout(resolve, ms * (Number.isFinite(speed) && speed >= 0 ? speed : 1));
  signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
});

export default async function reply(context, faux) {
  const prompt = context.messages.filter((m) => m.role === "user").map(textOf).join("\n");
  if (prompt.includes("DOCUMENT REVIEW REPORT REQUEST")) {
    await sleep(3200, faux.signal);
    return faux.message(report(prompt));
  }
  // A model node that must submit a record gets nothing useful here: the demo workflows have none.
  if (context.messages.some((m) => m.role === "system" && m.toolsAdded?.some((tool) => tool.name === "submit"))) return faux.message("The demo's faux model only writes the batch report.");
  return faux.message(`Faux model: ${prompt.slice(0, 200)}`);
}
