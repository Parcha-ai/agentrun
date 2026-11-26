// Each text redact-main-glued.test.mjs reads, written again with what code or prose glues to its quotes: a word before
// each apostrophe and each quote that follows no word character (Python's string prefixes in their cases, and words
// that are none), and a line of prose with an apostrophe, or an apostrophe its line ends, before the text, on its line
// or a line up. The text as it came is first. Fixed, so the verdicts pinned for main (fixtures/redact-main-glued.json)
// stay in step: one per variant.
const PREFIXES = ["r", "R", "b", "B", "u", "U", "f", "F", "rb", "BR", "Br", "fr", "Fr", "rF", "RF", "ur", "N", "E", "X", "L", "u8"];
const WORDS = ["x", "ab", "Ur", "s", "t", "rt", "_r", "1", "#13", "K=x"];
const LEADS = ["Here's it: ", "Here's it:\n", "l'eau ", "C'est ", "Plan B's\n", "Plan B's ", "it's r'", "the servers' ", "it's ", "O'Brien's: ", "the servers'\n", "r'\n", "x = '\n"];

/** The text's variants, each `[how, text]`, the text as it came first, and none that is the text again. */
export function gluedVariants(text) {
  const out = [["as it came", text]];
  for (const word of [...PREFIXES, ...WORDS]) {
    out.push([`${word}'`, text.replace(/(^|[^\p{L}\p{N}_'\\])'/gu, `$1${word}'`)]);
    out.push([`${word}"`, text.replace(/(^|[^\p{L}\p{N}_"\\])"/gu, `$1${word}"`)]);
  }
  for (const lead of LEADS) out.push([`${JSON.stringify(lead)} before`, lead + text]);
  return out.filter(([, variant], at) => at === 0 || variant !== text);
}
