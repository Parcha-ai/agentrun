// A faux model whose answer ends in a JSON record, as a template's run gives one: a line of words, then a fenced json
// block with nested objects, a list and a long string. The console's Report reads it as fields (apps/console e2e).
export const RECORD = {
  lead: { name: "Dana Whitfield", email: "dana@example.com", title: null },
  company: { name: "Example Co", what_it_does: "Provides corporate cards, expense management, bill payments and banking products for businesses of every size, with no line break anywhere in it at all.", tech_signals: ["cards", "expense software"] },
  qualified: true,
};

export default function reply(_context, faux) {
  return faux.message(`Here is the lead.\n\n\`\`\`json\n${JSON.stringify(RECORD, null, 2)}\n\`\`\``);
}
