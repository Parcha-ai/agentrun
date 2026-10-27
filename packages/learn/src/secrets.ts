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

/** A matcher for `values` in a text: plain, split by whitespace, percent or form encoded, base64 or hex. Values shorter
 *  than MIN_SECRET are left out. */
export function valueMatcher(values: readonly string[]): (text: string) => boolean {
  const needles = values.filter((value) => [...value].length >= MIN_SECRET).map((value) => {
    const raw = Buffer.from(value, "utf8");
    return { plain: [squeeze(value), ...base64Needles(raw)], hex: raw.toString("hex") };
  });
  if (!needles.length) return () => false;
  return (text) => {
    const views = [...new Set([squeeze(text), squeeze(percentDecode(text, false)), squeeze(percentDecode(text, true))])];
    const lower = views.map((view) => view.toLowerCase());
    return needles.some((n) => views.some((view) => n.plain.some((needle) => view.includes(needle))) || lower.some((view) => view.includes(n.hex)));
  };
}
