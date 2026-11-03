/** Text shaped like a secret, by kind. The same shapes the Pi learning loop's guard refuses. */
const SHAPES: readonly (readonly [string, RegExp])[] = [
  ["AWS access key id", /(?:AKIA|ASIA)[0-9A-Z]{16}/],
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
  ["private key block", /-----BEGIN[ A-Z0-9]*PRIVATE KEY[ A-Z0-9]*-----/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}/],
  ["sk- key", /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/],
  ["Slack token", /xox[abposre]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}/],
  ["JWT", /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["URL with a password", /:\/\/[^\s/?#@:]+:[^\s/?#@]*@/],
];

/** The kinds of secret-shaped text in `text`. */
export const secretShapes = (text: string): string[] => SHAPES.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);

type Span = [start: number, end: number];

/** Every place `pattern` matches in `text`, overlapping places included. */
function spans(text: string, pattern: RegExp): Span[] {
  const re = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
  const out: Span[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push([m.index, m.index + m[0].length]);
    re.lastIndex = m.index + 1;
  }
  return out;
}

function places(text: string, form: string): Span[] {
  const out: Span[] = [];
  for (let at = text.indexOf(form); at >= 0; at = text.indexOf(form, at + 1)) out.push([at, at + form.length]);
  return out;
}

/** `text` with each of `values` (as written, as JSON writes it, and in each form the matcher finds as it stands: hex in
 *  any case, base64) and each secret-shaped run replaced by "[redacted]": what the checker prints never holds a secret,
 *  wherever it was found, a file's name and the branch's included. Every form is found in `text` as given, and
 *  overlapping finds are redacted as one, so one value never hides part of another from the search. A text that still
 *  holds a value or a shape after that (a form not found as it stands: percent encoded, split by whitespace, an NFKC
 *  variant) is redacted whole, never in part. */
export function redactSecrets(text: string, values: readonly string[]): string {
  const given = values.filter((v) => v.length > 0);
  const forms = new Set(given.flatMap((v) => [v, asJson(v), ...(longEnough(v) ? needlesOf(v).plain : [])]).filter((form) => form.length > 0));
  const found = [
    ...[...forms].flatMap((form) => places(text, form)),
    ...given.filter(longEnough).flatMap((v) => spans(text, new RegExp(needlesOf(v).hex, "i"))),
    ...SHAPES.flatMap(([, pattern]) => spans(text, pattern)),
  ].sort((a, b) => a[0] - b[0]);
  const merged: Span[] = [];
  for (const [start, end] of found) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let out = "";
  let from = 0;
  for (const [start, end] of merged) {
    out += `${text.slice(from, start)}[redacted]`;
    from = end;
  }
  out += text.slice(from);
  return valueMatcher(given)(out) || secretShapes(out).length > 0 ? "[redacted]" : out;
}

/** A value shorter than this matches too much text by chance to be refused. */
export const MIN_SECRET = 8;

const squeeze = (text: string) => text.normalize("NFKC").replace(/\s+/gu, "");

/** The base64 of `secret` as it can sit inside a longer blob: the characters that depend on the secret's bytes alone,
 *  at each of the three alignments, in both alphabets. */
function base64Needles(secret: Buffer): string[] {
  const out = new Set<string>();
  for (let offset = 0; offset < 3; offset++) {
    const encoded = Buffer.concat([Buffer.alloc(offset), secret]).toString("base64");
    const needle = encoded.slice(Math.ceil((8 * offset) / 6), Math.floor((8 * (offset + secret.length)) / 6));
    out.add(needle);
    out.add(needle.replaceAll("+", "-").replaceAll("/", "_"));
  }
  return [...out];
}

function percentDecode(text: string, plusIsSpace: boolean): string {
  return (plusIsSpace ? text.replaceAll("+", " ") : text).replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => Buffer.from(run.replaceAll("%", ""), "hex").toString("utf8"));
}

const asJson = (value: string) => JSON.stringify(value).slice(1, -1);

/** What a matcher looks for of `value`: its forms as they stand in a squeezed text (plain, as JSON writes it, base64 or
 *  base64url), and its hex, in any case. */
function needlesOf(value: string): { plain: string[]; hex: string } {
  const raw = Buffer.from(value, "utf8");
  return { plain: [...new Set([squeeze(value), squeeze(asJson(value)), ...base64Needles(raw)])], hex: raw.toString("hex") };
}

const longEnough = (value: string) => [...value].length >= MIN_SECRET;

/** A matcher for `values` in a text: plain, split by whitespace, as JSON writes it, percent or form encoded, base64 or
 *  hex. Values shorter than MIN_SECRET are left out. */
export function valueMatcher(values: readonly string[]): (text: string) => boolean {
  const needles = values.filter(longEnough).map(needlesOf);
  if (!needles.length) return () => false;
  return (text) => {
    const views = [...new Set([squeeze(text), squeeze(percentDecode(text, false)), squeeze(percentDecode(text, true))])];
    const lower = views.map((view) => view.toLowerCase());
    return needles.some((n) => views.some((view) => n.plain.some((needle) => view.includes(needle))) || lower.some((view) => view.includes(n.hex)));
  };
}
