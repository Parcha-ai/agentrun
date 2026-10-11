// The stage's file list for the agent's offline copy (/show/offline.json, `{files: ["/show/", "/show/main.js", ...]}`): what the page needs to start, so a reload of the stage with the network
// off still loads it. The 03 server's service worker caches these at checkout. Entries are URL paths under `prefix` ("/show/"); `version` changes when any listed file's bytes do.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

/** `dist`: the built page's folder (its index.html is the stage's); `prefix`: where the 03 server mounts it ("/show/"). */
export function stageFileList(dist, prefix) {
  const files = new Set([prefix, `${prefix}index.html`]);
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const local = (ref) => !/^([a-z]+:)?\/\//i.test(ref) && !ref.startsWith("data:");
  for (const m of html.matchAll(/(?:src|href)="([^"#?]+)"/g)) if (local(m[1])) files.add(posix.join(prefix, m[1]));
  for (const css of [...files].filter((f) => f.endsWith(".css"))) {
    const text = readFileSync(join(dist, css.slice(prefix.length)), "utf8");
    for (const m of text.matchAll(/url\(["']?([^"')]+)["']?\)/g)) if (local(m[1])) files.add(posix.join(posix.dirname(css), m[1]));
  }
  const sorted = [...files].sort();
  const hash = createHash("sha256");
  for (const f of sorted) {
    hash.update(f).update("\0");
    if (!f.endsWith("/")) hash.update(createHash("sha256").update(readFileSync(join(dist, f.slice(prefix.length)))).digest());
  }
  return { version: hash.digest("hex"), files: sorted };
}
