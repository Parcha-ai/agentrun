const NOT_IN_RFC3986 = /%(?![0-9A-Fa-f]{2})|[^A-Za-z0-9\-._~!$&'()*+,;=:@/?%]/gu;

/** Percent-encodes, as UTF-8, what RFC 3986 refuses after a URL's authority. */
export const encodeRefused = (part: string): string => part.replace(NOT_IN_RFC3986, (c) => { try { return encodeURIComponent(c); } catch { return c; } });

/** What a URL keeps after its authority, as fetchableUrl sends it: the first '#' stays the fragment's, the rest is
 *  encodeRefused. */
export function encodeAfterAuthority(rest: string): string {
  const hash = rest.indexOf("#");
  return hash < 0 ? encodeRefused(rest) : `${encodeRefused(rest.slice(0, hash))}#${encodeRefused(rest.slice(hash + 1))}`;
}

/** Every spelling fetchableUrl can give `value` inside a URL, from the same encoders: holding the URL's first '#' or after
 *  it, and with a trailing incomplete escape either encoded or completed by hex digits that follow it in the URL (the
 *  encoder looks two characters ahead of a '%', so a two-digit probe after the value decides it, then is cut off). */
export function fetchedSpellings(value: string): string[] {
  const probe = "AA";
  return [encodeRefused, encodeAfterAuthority].flatMap((encode) => [encode(value), encode(value + probe).slice(0, -probe.length)]);
}

/** Fetch APIs refuse what RFC 3986 does not allow (Browserbase: 400 `url must match format "uri"`) though a browser takes it raw. */
export function fetchableUrl(raw: string): string {
  const hostStart = raw.indexOf("//") + 2;
  const hostLength = raw.slice(hostStart).search(/[/?#]/);
  const authority = hostLength < 0 ? raw : raw.slice(0, hostStart + hostLength);
  const rest = hostLength < 0 ? "" : raw.slice(hostStart + hostLength);
  const encoded = encodeAfterAuthority(rest);
  if (/^[\x21-\x7e]*$/.test(authority)) return authority + encoded;
  try { return new URL(authority).href.replace(/\/$/, "") + encoded; } catch { return authority + encoded; }
}
