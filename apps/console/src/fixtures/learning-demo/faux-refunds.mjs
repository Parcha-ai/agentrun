// A faux model for the console's learning demo: no key, no network. A refund-policy finder that works slowly (three
// drafts, a pause each) while it knows nothing, and fast once it has notes: it reads each note its index names from
// `.learning/` first, then answers. Its end-of-run turn writes the notes its instructions plan for the run's shop:
//   Learn on <word>: [[file, text], ...]   (the run whose first message holds <word>)
// The server's grader is answered here too: `Drop: <file>: <reason>` in the instructions keeps every note but that one,
// and merges none; anything else keeps every note.
const textOf = (v) => (typeof v === "string" ? v : Array.isArray(v) ? v.map((p) => (typeof p?.text === "string" ? p.text : "")).join("") : "");
const systemOf = (c) => [c.systemPrompt, ...c.messages.filter((m) => m.role === "system").flatMap((m) => [textOf(m.content), ...Object.values(m.sections ?? {}).map(textOf)])].filter(Boolean).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Sonnet-like price, so costs are known and look like a real model's. */
export const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

const shopOf = (first) => /https?:\/\/(?:www\.)?([a-z0-9.-]+)/i.exec(first)?.[1] ?? "the shop";

function grade(prompt, faux) {
  const rules = /----- begin (\w+): the agent's standing instructions -----\n([\s\S]*?)----- end \1 -----/.exec(prompt)?.[2] ?? "";
  const files = /^Give one item for each of these files, each once, and for no other: (.*)\.$/m.exec(prompt)?.[1].split(", ") ?? [];
  const drops = new Map([...rules.matchAll(/^Drop: (\S+\.md): (.+)$/gm)].map((m) => [m[1], m[2]]));
  const dropped = files.filter((f) => drops.has(f));
  return faux.message(JSON.stringify({
    merge: dropped.length === 0,
    reason: dropped.length ? drops.get(dropped[0]) : "General and new: it holds for other shops too, and no note says it yet.",
    items: files.map((file) => ({ file, keep: !drops.has(file), ...(drops.has(file) ? { question: "General" } : {}), why: drops.get(file) ?? "It holds as a general rule." })),
  }));
}

export default function reply(context, faux) {
  const users = context.messages.filter((m) => m.role === "user").map((m) => textOf(m.content));
  const [first = "", last = ""] = [users[0], users.at(-1)];
  if (first.startsWith("You grade what an agent proposes to remember.")) return grade(first, faux);
  const system = systemOf(context);
  const done = context.messages.slice(context.messages.findLastIndex((m) => m.role === "user")).filter((m) => m.role === "toolResult").length;
  const asked = /^The task is done\.[\s\S]*?Your notes from earlier runs are in `([^`]+)`/.exec(last);
  const shop = shopOf(first);
  if (asked) {
    const plan = [...system.matchAll(/^Learn on (\S+): (\[.*\])$/gm)].filter((m) => first.includes(m[1])).flatMap((m) => JSON.parse(m[2]));
    if (done >= plan.length) return sleep(600).then(() => faux.message("Reflected."));
    const [file, content] = plan[done];
    return sleep(700).then(() => faux.message(faux.toolCall("write", { path: `${asked[1]}${file}`, content }), { stopReason: "toolUse" }));
  }
  // The job. With notes: read each one first, then answer at once. Without: three drafts while it hunts for the page.
  const learned = [...new Set([...system.matchAll(/\]\(([A-Za-z0-9][A-Za-z0-9._-]*\.md)\)/g)].map((m) => m[1]))];
  if (learned.length) {
    if (done < learned.length) return sleep(500).then(() => faux.message(faux.toolCall("read", { path: `.learning/${learned[done]}` }), { stopReason: "toolUse" }));
    return sleep(900).then(() => faux.message(answer(shop, true)));
  }
  const tries = ["/pages/returns", "/pages/refund-policy", "/policies/refund-policy"];
  if (done < tries.length) {
    return sleep(2400).then(() => faux.message(faux.toolCall("write", { path: `draft-${done + 1}.md`, content: `Tried https://www.${shop}${tries[done]}: ${done < 2 ? "no policy text on this page." : "the refund policy."}\n${"Notes on the page layout, links followed and what each held. ".repeat(40)}` }), { stopReason: "toolUse" }));
  }
  return sleep(1200).then(() => faux.message(answer(shop, false)));
}

const answer = (shop, quick) => [
  `**Refund policy URL:** https://www.${shop}/policies/refund-policy`,
  "",
  "- **Return window:** 30 days from delivery, unworn with tags on.",
  "- **Return shipping:** free for exchanges; a $7.50 label fee is taken from refunds.",
  "",
  quick ? "Found on the first try: Shopify stores keep the policy at /policies/refund-policy." : "It took three tries: /pages/returns and /pages/refund-policy held no policy text.",
].join("\n");
