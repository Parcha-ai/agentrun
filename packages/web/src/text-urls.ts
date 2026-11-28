// The one reading of an http(s) URL written in text, shared by a fetched page's links and serve's timeline scrub and link
// check. It imports nothing (the console compiles it from source), and every reading is linear in its text.

/** What ends a URL written in text, for every reader: whitespace, a quote, an angle bracket, a backtick or a backslash. */
const URL_ENDS = "\\s\"`<>\\\\";
/** A URL written in text, as a link is read (a page's links, an answer's cited links): it also ends at "|", so a Slack
 *  mrkdwn link `<https://a/b|text>` is `https://a/b`. */
export const TEXT_URL = new RegExp(`https?://[^${URL_ENDS}|]+`, "gi");
/** A URL written in text, as the timeline scrubs one (scrubUrls): it runs on through a "|", so a query value holding one
 *  (`?ids=1|2`) is elided whole, never shown past the "|". The scrub's only difference from TEXT_URL. */
export const SCRUBBED_URL = new RegExp(`https?://[^${URL_ENDS}]+`, "gi");
/** What a URL found in text may end with that is not its own: a sentence's punctuation, a closing quote, an emphasis's
 *  "*", a closing bracket the URL did not open (trimmed). */
export const TRAILING = ".,;:!?*)]}'";
const OPENER: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** @internal The characters this module's readings have visited, each pass's span added once when it ends: the count a
 *  test bounds as linear in a text's length. Not in the package's types (stripInternal). */
export const scanned = { steps: 0 };

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
  scanned.steps += raw.length + (raw.length - end);
  return raw.slice(0, end);
}

/** Where a markdown link's target (`text` from `from`, the character after its "](") ends: at the ")" that closes the link,
 *  so parentheses it holds in pairs (a wiki title's) stay, else at whitespace or `to`. `text[end] === ")"` says it closed. */
export function targetEnd(text: string, from = 0, to = text.length): number {
  let end = from;
  for (let depth = 0; end < to && !/\s/.test(text[end]!); end++) {
    if (text[end] === "(") depth++;
    else if (text[end] === ")" && depth-- === 0) break;
  }
  scanned.steps += end - from;
  return end;
}

/** Where a markdown target in angle brackets (`text` from `from`, the character after its "<") ends: the index of its ">",
 *  or -1 where whitespace, another "<" or `to` comes first (no such target: read it as targetEnd does). */
function angledEnd(text: string, from: number, to: number): number {
  let end = from;
  for (; end < to && !/[\s<]/.test(text[end]!); end++) if (text[end] === ">") break;
  scanned.steps += end - from;
  return end < to && text[end] === ">" ? end : -1;
}

/** A string that is one URL whole (a JSON field holding a link means all of it, its last character too), trimmed of the
 *  whitespace around it; else undefined. */
export function wholeUrl(text: string): string | undefined {
  const whole = text.trim();
  return /^https?:\/\//i.test(whole) && !/\s/.test(whole) ? whole : undefined;
}

/** Where a link starts: a markdown link's target (after its "]("), or a URL written out (TEXT_URL). */
const LINK_AT = new RegExp(`\\]\\(|${TEXT_URL.source}`, "gi");

/** A link as `text` writes it, and whether that is all of it (`exact`): a markdown link's target that its ")" closed is;
 *  a URL written out, or a target with no ")", may end in a tail that is not its own (TRAILING). */
export type WrittenLink = { raw: string; exact: boolean };

/** Every link `text` holds, in order, as written (WrittenLink): a markdown link's target (`[text](url)`, targetEnd), and a
 *  URL written out (TEXT_URL). A URL written out that runs into a "](" is a link written as its own text
 *  (`[https://a](https://a)`): what follows each "](" in it is a target. A target ends where targetEnd says, never where
 *  TEXT_URL stopped, so one holding a "|" (`](https://a/?m=1|2)`) is whole. Each link is looked for from where the last
 *  one ended, a target read past the URL running into it scanned once more at most: linear, however many unclosed "](" a
 *  hostile page holds. A page's links (hrefsIn) and an answer's cited links (link-check.ts) both read it. */
export function* linksWritten(text: string): Generator<WrittenLink> {
  const at = new RegExp(LINK_AT.source, "gi");
  // Each search runs from where the last left off (lastIndex) to its match's end, or the text's.
  const next = () => {
    const from = at.lastIndex;
    const found = at.exec(text);
    scanned.steps += (found ? at.lastIndex : text.length) - from;
    return found;
  };
  for (let found = next(); found; found = next()) {
    // A "](" alone is ["", ""]: one target, after it.
    const pieces = found[0].split("](");
    if (pieces[0]) yield { raw: pieces[0], exact: false };
    let from = found.index + pieces[0]!.length + 2;
    for (let i = 1; i < pieces.length; i++) {
      // Each target but the last ends by the next "](" in the URL; the last may run on past where TEXT_URL stopped.
      const to = i < pieces.length - 1 ? from + pieces[i]!.length : text.length;
      // A target in angle brackets (CommonMark's `](<https://a/b>)`) is what they hold, its ">" its end.
      const angled = text[from] === "<" ? angledEnd(text, from + 1, to) : -1;
      const end = angled >= 0 ? angled : targetEnd(text, from, to);
      yield angled >= 0 ? { raw: text.slice(from + 1, angled), exact: true } : { raw: text.slice(from, end), exact: text[end] === ")" };
      at.lastIndex = Math.max(at.lastIndex, end);
      from += pieces[i]!.length + 2;
    }
  }
}

/** Every link `text` holds, in order (linksWritten): a target its ")" closed as it is, any other less its tail (trimmed). */
export function* hrefsIn(text: string): Generator<string> {
  for (const { raw, exact } of linksWritten(text)) yield exact ? raw : trimmed(raw);
}

/** The entities XML names (`&apos;` HTML's `&#39;` too, a numeric reference), undone once in a text that is not JSON. */
const ENTITY = /&(?:(quot|amp|lt|gt|apos)|#(\d{1,7})|#x([0-9a-f]{1,6}));/gi;
const NAMED: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'" };
/** An XML attribute: its name, and its value in double quotes (kept as it is, so an "='" in its query is never taken for
 *  an attribute) or in single quotes (the fourth group). */
const ATTRIBUTE = /(\s)([^\s=<>"'/]+)(\s*=\s*)(?:"[^"]*"|'([^'<]*)')/g;

/** @internal Every pattern this module scans a whole text with, for the test that compiles each on V8's linear engine (a
 *  pattern that backtracks is refused there). Not in the package's types (stripInternal). */
export const scanPatterns: readonly RegExp[] = [TEXT_URL, SCRUBBED_URL, LINK_AT, ENTITY, ATTRIBUTE];

/** `text` read for its links, where it is not JSON: its entities undone once, so an escaped `&lt;a href=&quot;…&quot;&gt;`
 *  (an Atom feed's content) ends its URL at the quote, never running on to the next space, and an attribute's
 *  `href="https://a/?x=1&amp;y=2"` is the URL `https://a/?x=1&y=2`. One pass, so `&amp;lt;` is `&lt;`. Where it is XML,
 *  first: a single-quoted attribute (`href='https://a/b'`) is requoted to end at its quote as a double-quoted one does (its
 *  value holds no "'" or "<" of its own), and a namespace's name (`xmlns="http://www.w3.org/2005/Atom"`), an identifier,
 *  never a link, is dropped. Attributes are read in order, each whole. */
function readable(text: string): string {
  scanned.steps += text.length;
  const xml = /^\s*<[?!A-Za-z]/.test(text)
    ? text.replace(ATTRIBUTE, (attribute, space: string, name: string, equals: string, single: string | undefined) => {
        if (/^xmlns(:|$)/i.test(name)) return space;
        return single === undefined ? attribute : `${space}${name}${equals}"${single}"`;
      })
    : text;
  scanned.steps += xml.length;
  return xml.replace(ENTITY, (entity, name: string | undefined, decimal: string | undefined, hex: string | undefined) => {
    if (name) return NAMED[name.toLowerCase()]!;
    const code = Number.parseInt(decimal ?? hex!, decimal ? 10 : 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

/** A JSON body's links as written, in the body's order: each string value's (hrefsIn), one that is a URL whole taken as
 *  it is (wholeUrl); undefined for a text that is not JSON. Read from the parsed body, so an escape (`\/`) never hides or
 *  cuts one. */
function jsonHrefs(text: string): Iterable<string> | undefined {
  // An object, an array or one string: the bodies that can hold a URL (a string body is one, or holds some).
  if (!/^\s*[[{"]/.test(text)) return undefined;
  let body: unknown;
  scanned.steps += text.length;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  return (function* () {
    // A stack, not recursion: a deeply nested body never overflows it.
    const stack = [body];
    while (stack.length) {
      const next = stack.pop();
      if (typeof next === "string") {
        const whole = wholeUrl(next);
        yield* whole === undefined ? hrefsIn(next) : [whole];
      } else if (typeof next === "object" && next !== null) {
        const values = Object.values(next);
        for (let i = values.length - 1; i >= 0; i--) stack.push(values[i]);
      }
    }
  })();
}

/** The absolute http(s) URLs a text holds, each once and without its fragment, in order: for JSON, those of its string
 *  values (jsonHrefs); for any other text (markdown, plain text, XML), its markdown link targets and the URLs it writes
 *  out (hrefsIn), read with its entities undone (readable). A fetched page's links (linksWithin keeps those within the
 *  caps and counts the rest), and the urls the link check takes from a call that is not a web call. */
export function* linksOf(text: string): Generator<string> {
  const seen = new Set<string>();
  for (const href of jsonHrefs(text) ?? hrefsIn(readable(text))) {
    scanned.steps += href.length;
    const link = /^https?:\/\//i.test(href) ? URL.parse(href) : null;
    if (!link) continue;
    link.hash = "";
    if (seen.has(link.href)) continue;
    seen.add(link.href);
    yield link.href;
  }
}
