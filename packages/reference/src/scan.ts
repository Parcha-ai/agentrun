// The one scan for what a published recording must never hold: a credential's shape or a machine path. It lives here so a
// copied example keeps it: the recorder (record.ts) scans a recording before it finishes one, and the repository's
// validator and the hosted gallery's gate (scripts/recording/) import this same module.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The credential shapes a published recording must never hold, with the machine paths. The source export keeps its own
 *  list (scripts/export-source.mjs). Beyond the shapes every key has, a demo's key whose provider publishes a prefix has a
 *  shape of its own here, a backstop for the moment a run's tool result or a page carries the key itself. */
export const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ['machine path', /\/(?:home|Users)\/[A-Za-z0-9._-]+\//],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['github token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['provider secret', /\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{30,}\b/],
  ['aws access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  // A signed JSON Web Token (a ChatGPT sign-in's access and id tokens are ones): a base64url JSON header and payload, each
  // starting `{"` (`eyJ`), and a signature.
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  // Browserbase (BROWSERBASE_API_KEY): its docs show a key as `bb_live_...`.
  ['browserbase api key', /\bbb_live_[A-Za-z0-9_-]{16,}/],
  ['credential url', /https?:\/\/[^\s/:]+:[^\s/@]+@/],
  ['bearer secret', /\bBearer\s+[A-Za-z0-9._-]{24,}/],
  ['literal credential', /(?:api[_-]?key|password|access[_-]?token|auth[_-]?token|client[_-]?secret)['"]?\s*[=:]\s*['"][^'"\n]{8,}['"]/i],
];

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Query parameters that carry a credential whatever their value, compared in lower case. */
const TOKEN_PARAMETERS: ReadonlySet<string> = new Set(['token', 'access_token', 'apikey', 'api_key', 'key', 'signature', 'sig', 'x-amz-signature', 'x-goog-signature']);
/** A URL as it sits in a text: from its scheme to the first character that ends one in JSON, HTML, Markdown or prose. */
const URL_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s"'`<>\\)\]}]+/gi;
/** A live view's, debugger's or connect endpoint's URL: Browserbase's connect host and its debug and devtools paths, and any
 *  DevTools or inspector page. Such a URL carries its session's access in its query, so none is published with one. */
const liveViewUrl = (host: string, path: string): boolean => host === 'connect.browserbase.com'
  || (/(?:^|\.)browserbase\.com$/.test(host) && /^\/(?:debug|devtools|devtools-fullscreen)(?:\/|$)/.test(path))
  || /(?:^|\/)(?:devtools|devtools-fullscreen)\/|\/inspector\.html$/.test(path);
/** A parameter's name as the message may print it: its own characters only, never anything of a value. */
const nameOf = (raw: string): string => { let name = raw; try { name = decodeURIComponent(raw); } catch { /* kept as written */ } return /^[A-Za-z0-9._-]{1,40}$/.test(name) ? name : 'unnamed'; };

/** A fragment's `t` is a media time (`film.mp4#t=19,21`, `#t=npt:10,20`); a `t` that is anything else is a token (a live view's own link keeps its token there). */
const MEDIA_TIME = /^(?:npt:)?[0-9.:]+(?:,[0-9.:]+)?$/;
const tokenName = (raw: string): boolean => { let name = raw; try { name = decodeURIComponent(raw); } catch { /* compared as written */ } return TOKEN_PARAMETERS.has(name.toLowerCase()); };
/** Kernel's live view (https://www.kernel.sh/docs/browsers/live-view): api.onkernel.com/browser/live/<token>, optionally ?readOnly=true. The host is also Kernel's API base, so only this path prefix is a capability. */
const KERNEL_LIVE = { host: 'api.onkernel.com', path: /^\/browser\/live\/./ } as const;
/** A DevTools websocket endpoint is a capability by its path alone: /devtools/browser/<id>, /devtools/page/<id>. */
const DEVTOOLS_PATH = /^\/devtools\/(?:browser|page)\/./;

/** The shape of a URL that carries a credential, by name, or undefined. A URL (http, https, ws or wss) is refused when
 *  - its query holds a token-bearing parameter (`token`, `access_token`, `apiKey`, `api_key`, `key`, `signature`, `sig`,
 *    `X-Amz-Signature`, `X-Goog-Signature`) with any value;
 *  - it is a ws:// or wss:// URL with a query, or a live-view, debugger or connect URL with any query;
 *  - it is a ws:// or wss:// URL to a DevTools path (no query needed), or Kernel's live-view path on its API host;
 *  - its fragment holds one of those names, or a `t` that is not a media time.
 *  The name says the parameter or the kind and never a value, so a message that repeats it leaks nothing. There is no
 *  generic path-token rule: only the named hosts and the DevTools path. */
export function urlCredentialIn(text: string): string | undefined {
  for (const [candidate] of text.matchAll(URL_IN_TEXT)) {
    const hash = candidate.indexOf('#');
    const head = hash === -1 ? candidate : candidate.slice(0, hash);
    const fragment = hash === -1 ? '' : candidate.slice(hash + 1);
    const mark = head.indexOf('?');
    const base = mark === -1 ? head : head.slice(0, mark);
    const names = (part: string): [string, string][] => part.split('&').filter((item) => item !== '').map((item) => { const at = item.indexOf('='); return at === -1 ? [item, ''] : [item.slice(0, at), item.slice(at + 1)]; });
    const queryNames = mark === -1 ? [] : names(head.slice(mark + 1));
    const where = /^([a-z]+):\/\/([^/?]*)(\/.*)?$/i.exec(base);
    const host = where?.[2].toLowerCase() ?? '';
    const path = where?.[3] ?? '';
    const token = queryNames.find(([name]) => tokenName(name));
    if (token) return `url with a token-bearing query parameter (${nameOf(token[0])})`;
    if (queryNames.length > 0) {
      if (/^wss?:/i.test(base)) return `websocket url with a query (${nameOf(queryNames[0][0])})`;
      if (liveViewUrl(host, path)) return `live-view, debugger or connect url with a query (${nameOf(queryNames[0][0])})`;
    }
    if (/^wss?:/i.test(base) && DEVTOOLS_PATH.test(path)) return 'websocket url to a DevTools path';
    if (host === KERNEL_LIVE.host && KERNEL_LIVE.path.test(path)) return 'kernel live-view url';
    const inFragment = names(fragment).find(([name, value]) => tokenName(name) || (name.toLowerCase() === 't' && !MEDIA_TIME.test(value)));
    if (inFragment) return `url with a token-bearing fragment parameter (${nameOf(inFragment[0])})`;
  }
  return undefined;
}

/** The first credential shape in a text, by name. */
export const credentialIn = (text: string): string | undefined => FORBIDDEN.find(([, pattern]) => pattern.test(text))?.[0] ?? urlCredentialIn(text);

/** The credential shape in any string or key of a decoded JSON value: the raw text can hide one behind an escape (`sk-`). */
export function credentialInValue(value: unknown): string | undefined {
  if (typeof value === 'string') return credentialIn(value);
  if (Array.isArray(value)) { for (const inner of value) { const found = credentialInValue(inner); if (found) return found; } return undefined; }
  if (isObject(value)) { for (const [key, inner] of Object.entries(value)) { const found = credentialIn(key) ?? credentialInValue(inner); if (found) return found; } }
  return undefined;
}

/** The files a scan reads as text, by extension; the others (images, video) are kept whole and not read. */
export const TEXT_FILE = /\.(?:json|jsonl|txt|md|html|csv|svg|xml|yaml|yml|log)$/i;

/** The credential shape in a file's text: raw, then decoded when the whole text is JSON, whatever its extension (an escape
 *  hides one in any text, `\u0073k-`); and, for JSON lines, each line decoded too, since a file of lines is not one JSON
 *  value. The validator checks every text file this same way. */
export function credentialInFile(name: string, text: string): string | undefined {
  const decoded = (part: string) => { try { return credentialInValue(JSON.parse(part)); } catch { return undefined; } };
  const whole = credentialIn(text) ?? decoded(text);
  if (whole || !/\.jsonl$/i.test(name)) return whole;
  for (const line of text.split('\n')) { const found = line ? decoded(line) : undefined; if (found) return found; }
  return undefined;
}

/** Every credential shape in the text files of a recording directory, each `{ file, found }` with `file` relative to it.
 *  The recorder's own spool (`.spool/`) is its working copy, not the recording, and is skipped. */
export function scanRecording(dir: string): { file: string; found: string }[] {
  const out: { file: string; found: string }[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) { if (!(at === dir && entry.name === '.spool')) walk(path); continue; }
      if (!TEXT_FILE.test(entry.name)) continue;
      const found = credentialInFile(entry.name, readFileSync(path, 'utf8'));
      if (found) out.push({ file: relative(dir, path), found });
    }
  };
  walk(dir);
  return out;
}
