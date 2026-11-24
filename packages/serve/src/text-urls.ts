// The timeline's reading of an http(s) URL written in text: where it ends and what tail is not its own. The timeline's
// scrub (timeline/util.ts scrubUrls) reads through it, and the console compiles it from source with the timeline, so it
// imports nothing. A fetched page's links and the eval link check's cited links read through @parcha/agentrun-web's
// text-urls.ts, which holds the same block between "URL tail, begin" and "URL tail, end", so a URL the timeline scrubs
// ends where the same URL a page holds or an answer cites does.
//
// Every reading here is linear in its text.

// URL tail, begin: the same text in packages/web/src/text-urls.ts and packages/serve/src/text-urls.ts (the console
// compiles serve's from source, so it imports nothing); serve's test/text-urls-copy.test.mjs holds the two equal.
/** What ends a URL written in text, for every reader: whitespace, a quote, an angle bracket, a backtick or a backslash. */
const URL_ENDS = "\\s\"`<>\\\\";
/** What a URL found in text may end with that is not its own: a sentence's punctuation, a closing quote, an emphasis's
 *  "*", a closing bracket the URL did not open (trimmed). */
export const TRAILING = ".,;:!?*)]}'";
const OPENER: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** A URL found in text less its tail (TRAILING): a closing bracket stays where the URL opened as many as it closes (a wiki
 *  title's `Foo_(bar)`). One count of the brackets, then one walk back, so a long run of them is linear. */
export function trimmed(raw: string): string {
  const count: Record<string, number> = { "(": 0, ")": 0, "[": 0, "]": 0, "{": 0, "}": 0 };
  for (const char of raw) if (char in count) count[char]! += 1;
  let end = raw.length;
  for (; end > 0 && TRAILING.includes(raw[end - 1]!); end--) {
    const char = raw[end - 1]!;
    const opener = OPENER[char];
    if (opener && count[opener]! >= count[char]!) break;
    if (opener) count[char]! -= 1;
  }
  return raw.slice(0, end);
}
// URL tail, end.

/** A URL written in text, as the timeline scrubs one (scrubUrls): it runs on through a "|", so a query value holding one
 *  (`?ids=1|2`) is elided whole, never shown past the "|". The scrub's only difference from TEXT_URL. */
export const SCRUBBED_URL = new RegExp(`https?://[^${URL_ENDS}]+`, "gi");
