// The receiving mail server's word on who sent a message: its Authentication-Results header (RFC 8601), read for one
// thing only, whether DMARC passed for the domain of the message's one From. A message's sender can write any header,
// that one included, so only the receiving server's own counts: the topmost Authentication-Results (a server adds its
// own above what it was handed), and only when it carries the account's provider's authserv-id (account.ts
// authservIdOf). An account whose provider's authserv-id isn't known has no verdict read at all (fail closed).

/** `value` with its comments (RFC 5322 CFWS: parentheses, nested, `\` quoting inside) made one space each, its quoted
 *  strings kept whole. Empty when a comment or quoted string never ends: such a header reads as nothing. */
function uncommented(value: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (depth > 0) {
      if (c === "\\") i++;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) out += " ";
      continue;
    }
    if (quoted) {
      out += c;
      if (c === "\\" && i + 1 < value.length) out += value[++i];
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === "(") depth = 1;
    else {
      out += c;
      if (c === '"') quoted = true;
    }
  }
  return depth > 0 || quoted ? "" : out;
}

/** `text` split at each `;` outside a quoted string, each part trimmed. */
function partsOf(text: string): string[] {
  const parts = [""];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (!quoted && c === ";") {
      parts.push("");
      continue;
    }
    parts[parts.length - 1] += c;
    if (quoted && c === "\\" && i + 1 < text.length) parts[parts.length - 1] += text[++i];
    else if (c === '"') quoted = !quoted;
  }
  return parts.map((part) => part.trim());
}

/** A value as written: a quoted string's text, else the token. */
const unquoted = (value: string) => (value.startsWith('"') && value.endsWith('"') && value.length > 1 ? value.slice(1, -1).replace(/\\(.)/g, "$1") : value);
/** Text as compared: its ASCII letters lowercased and nothing else (domain names fold ASCII only, as addresses do). */
const folded = (text: string) => text.trim().replace(/[A-Z]+/g, (letters) => letters.toLowerCase());

const VALUE = String.raw`("(?:[^"\\]|\\.)*"|[^\s";]+)`;
/** A result's start: `method[/version] = result`. */
const RESULT = new RegExp(String.raw`^([^\s=";]+)\s*=\s*${VALUE}`);
/** A property after it: `ptype.property = value` (or `reason = value`). */
const PROPERTY = new RegExp(String.raw`([^\s=";]+)\s*=\s*${VALUE}`, "g");

/** One method's result, as an Authentication-Results header says it. */
type Result = { method: string; result: string; properties: Map<string, string> };

/** An Authentication-Results header's value read: its authserv-id and each method's result. Undefined when it doesn't
 *  read: no authserv-id, a comment or quoted string that never ends, or a part that is no `method=result`. A part that
 *  says `none` holds no result. */
export function resultsOf(value: string): { authservId: string; results: Result[] } | undefined {
  const text = uncommented(value);
  const [head, ...rest] = partsOf(text);
  const id = /^("(?:[^"\\]|\\.)*"|[^\s";]+)/.exec(head ?? "")?.[1];
  if (!id) return undefined;
  const results: Result[] = [];
  for (const part of rest) {
    if (part === "" || /^none$/i.test(part)) continue;
    const first = RESULT.exec(part);
    if (!first) return undefined;
    const properties = new Map([...part.slice(first[0].length).matchAll(PROPERTY)].map((m) => [folded(unquoted(m[1]!)), unquoted(m[2]!)] as const));
    results.push({ method: folded(first[1]!.split("/")[0]!), result: folded(unquoted(first[2]!)), properties });
  }
  return { authservId: folded(unquoted(id)), results };
}

/** Whether the receiving server said DMARC passed for a message's From: `results`, the message's Authentication-Results
 *  values, topmost first; `from`, every address of its From header (exactly one, or no verdict); `authservId`, the
 *  account's provider's (undefined: none known, no verdict). Only the topmost header is read, and only when its
 *  authserv-id is the provider's: one lower down may be the sender's own. It passes when that header has a dmarc result,
 *  every dmarc result it has is `pass`, and each one's header.from is the From's domain (ASCII case-blind). dkim=pass or
 *  spf=pass alone is no pass. */
export function dmarcPassed(results: readonly string[], from: readonly string[], authservId: string | undefined): boolean {
  if (!authservId || from.length !== 1) return false;
  const at = from[0]!.lastIndexOf("@");
  const domain = at > 0 ? folded(from[0]!.slice(at + 1)) : "";
  const [top] = results;
  const read = domain && top !== undefined ? resultsOf(top) : undefined;
  if (!read || read.authservId !== folded(authservId)) return false;
  const dmarc = read.results.filter((one) => one.method === "dmarc");
  return dmarc.length > 0 && dmarc.every((one) => one.result === "pass" && folded(one.properties.get("header.from") ?? "") === domain);
}
