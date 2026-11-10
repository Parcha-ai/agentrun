import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { publicFetch } from "./core/public-fetch.js";
import { READ_MAX_CHARS, readPage, thousands } from "./core/read-page.js";
import type { EvidenceRecord, EvidenceSink } from "./core/evidence.js";
import type { WebBackup } from "./core/web.js";

export { findChrome } from "./providers/chrome-args.js";

/** One path segment of `[A-Za-z0-9._-]`; a label of only dots (`.`, `..`) is never a directory name. */
const safe = (part: string) => {
  const cleaned = part.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
  return !cleaned ? "browser" : /^\.+$/.test(cleaned) ? `_${cleaned}` : cleaned;
};

export function fileEvidenceSink(root: string, relativeTo: string): EvidenceSink {
  let seq = 0;
  return {
    async file(label: string, record: EvidenceRecord) {
      try {
        const dir = path.join(root, safe(label));
        await mkdir(dir, { recursive: true });
        const text = typeof record.body === "string";
        const header = ["tool: " + record.tool, "args: " + JSON.stringify(record.args), "status: " + record.status,
          ...Object.entries(record.facts).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${value}`), "---"];
        // A name is reserved with an exclusive create, so a later session (or a fork) never overwrites an earlier
        // receipt.
        for (;;) {
          const stem = `${String(++seq).padStart(4, "0")}-${record.tool}`;
          const [receipt, capture] = [path.join(dir, `${stem}.md`), path.join(dir, `${stem}.${record.ext ?? "bin"}`)];
          try { await writeFile(text ? receipt : capture, text ? `${header.join("\n")}\n${record.body}` : (record.body as Uint8Array), { flag: "wx" }); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
            throw error;
          }
          if (!text) await writeFile(receipt, `${header.join("\n")}\n(the capture is ${path.basename(capture)})\n`);
          const rel = (file: string) => path.relative(relativeTo, file).split(path.sep).join("/");
          return { path: rel(receipt), bodyLine: text ? header.length + 1 : undefined, ...(text ? {} : { bodyPath: rel(capture) }) };
        }
      } catch { return null; }
    },
  };
}

export { isPrivateAddress, pinnedLookup } from "./core/public-fetch.js";

/** Public hosts only, so a page-steered agent never reaches the owner's private network: each redirect hop is resolved
 *  once, checked and dialled at that address. No cookies or credentials; at most 5 MiB. An HTML page is read by
 *  readPage, off the event loop: a page cut before it was read says so on its last line. */
export function httpBackup(options: { lookup?: (host: string) => Promise<string[]>; fetchImpl?: (url: URL, init: Record<string, unknown>) => Promise<Response> } = {}): WebBackup {
  return {
    name: "http",
    async fetch(url, signal) {
      const answer = await publicFetch(url, { ...options, ...(signal ? { signal } : {}) });
      if (answer.status < 200 || answer.status >= 300) throw Object.assign(new Error(`the page answered ${answer.status}`), { status: answer.status });
      if (!/html/i.test(answer.contentType)) return answer.body!;
      const page = await readPage(answer.body!, answer.url, signal ? { signal } : {});
      return page.truncated ? `${page.text}\n\n(Cut: the page is ${thousands(page.html_chars!)} characters of HTML, and only its first ${thousands(READ_MAX_CHARS)}, scripts and styles aside, were read.)` : page.text;
    },
  };
}
