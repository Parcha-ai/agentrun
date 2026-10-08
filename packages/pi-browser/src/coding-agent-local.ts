// What a coding agent on one person's machine has and a hosted run does not: a Chrome on disk, a directory to file
// evidence in, and no fetch service. Three small functions the coding-agent adapter composes; each stands alone.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { Agent, fetch as undiciFetch } from "undici";
import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import type { EvidenceRecord, EvidenceSink } from "./core/evidence.js";
import type { WebBackup } from "./core/web.js";

const LINUX_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

/** The Chrome to launch: the one a person named (`PI_BROWSER_CHROME`, then `CHROME_PATH`), else the first of the usual
 *  install locations that exists; null when there is none. */
export function findChrome(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = existsSync): string | null {
  for (const named of [env.PI_BROWSER_CHROME, env.CHROME_PATH]) if (named && exists(named)) return named;
  const onPath = (env.PATH ?? "").split(path.delimiter).filter(Boolean).flatMap((dir) => LINUX_NAMES.map((name) => path.join(dir, name)));
  const fixed = ["/opt/google/chrome/chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"];
  return [...onPath, ...fixed].find((file) => exists(file)) ?? null;
}

/** One path segment of `[A-Za-z0-9._-]`: a label that is only dots (`.`, `..`) is never a directory name. */
const safe = (part: string) => {
  const cleaned = part.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
  return !cleaned ? "browser" : /^\.+$/.test(cleaned) ? `_${cleaned}` : cleaned;
};

/** Files each record under `<root>/<label>/<n>-<tool>.md` with the receipt header the package's evidence uses (`tool:`,
 *  `args:`, `status:`, one line per fact, `---`) and the body after it; an image body goes beside its receipt as
 *  `<n>-<tool>.<ext>`. The model is told the path relative to `relativeTo`. A write that fails files nothing. */
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
        // A name is reserved with an exclusive create, so a later session (or a fork) never overwrites an earlier receipt.
        for (;;) {
          const stem = `${String(++seq).padStart(4, "0")}-${record.tool}`;
          const [receipt, capture] = [path.join(dir, `${stem}.md`), path.join(dir, `${stem}.${record.ext ?? "bin"}`)];
          try { await writeFile(text ? receipt : capture, text ? `${header.join("\n")}\n${record.body}` : (record.body as Uint8Array), { flag: "wx" }); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
            throw error;
          }
          if (!text) await writeFile(receipt, `${header.join("\n")}\n(the capture is ${path.basename(capture)})\n`);
          return { path: path.relative(relativeTo, receipt).split(path.sep).join("/"), bodyLine: text ? header.length + 1 : undefined };
        }
      } catch { return null; }
    },
  };
}

const V4_PRIVATE: ReadonlyArray<readonly [number, number]> = [[0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12], [0xc0a80000, 16], [0x00000000, 8], [0xe0000000, 4]];
const v4 = (ip: string) => ip.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
/** Loopback, private, link-local, carrier-grade and multicast addresses, v4 and v6 (including v4-mapped). */
export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return isPrivateAddress(mapped);
  if (net.isIPv4(ip)) return V4_PRIVATE.some(([base, bits]) => Math.floor(v4(ip) / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
  if (net.isIPv6(ip)) return /^(::1?|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:|ff[0-9a-f]{2}:)/i.test(ip) || ip === "::";
  return true;
}

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** A `connect.lookup` that answers `address` whatever name it is asked for: the address a request was checked against is the
 *  one it connects to, so a name that resolves differently a moment later is never dialled. */
export const pinnedLookup = (address: string) => (_host: string, options: { all?: boolean }, callback: (...args: any[]) => void): void => {
  const family = net.isIPv6(address) ? 6 : 4;
  if (options?.all) callback(null, [{ address, family }]);
  else callback(null, address, family);
};

/** `web_fetch` for a machine with no fetch service: a plain HTTP read, HTML turned into markdown. It reads only public
 *  hosts (an agent steered by a page must not reach the owner's loopback or private network): each hop of a redirect is
 *  resolved once, checked, and dialled at that same address. It never sends cookies or credentials, and reads at most 5 MiB. */
export function httpBackup(options: { lookup?: (host: string) => Promise<string[]>; fetchImpl?: (url: URL, init: Record<string, unknown>) => Promise<Response> } = {}): WebBackup {
  const lookup = options.lookup ?? (async (host: string) => (await dns.lookup(host, { all: true })).map((a) => a.address));
  const request = options.fetchImpl ?? ((url, init) => undiciFetch(url, init as never) as unknown as Promise<Response>);
  return {
    name: "http",
    async fetch(url, signal) {
      let target = new URL(url);
      for (let hop = 0; ; hop += 1) {
        const host = target.hostname.replace(/^\[|\]$/g, "");
        if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new Error(`refused: ${host} is not a public host`);
        const addresses = net.isIP(host) ? [host] : await lookup(host);
        if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error(`refused: ${host} is not a public host`);
        const dispatcher = new Agent({ connect: { lookup: pinnedLookup(addresses[0]) } });
        let res: Response | undefined;
        try {
          res = await request(target, { redirect: "manual", signal, dispatcher, headers: { accept: "text/html,text/plain;q=0.9,*/*;q=0.1", "user-agent": "pi-browser" } });
          if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
            if (hop >= MAX_REDIRECTS) throw new Error("refused: too many redirects");
            target = new URL(res.headers.get("location")!, target);
            if (!/^https?:$/.test(target.protocol)) throw new Error("refused: a redirect left http(s)");
            continue;
          }
          if (!res.ok) throw Object.assign(new Error(`the page answered ${res.status}`), { status: res.status });
          const type = res.headers.get("content-type") ?? "";
          if (!/^(text\/|application\/(xhtml\+xml|json|xml))/i.test(type)) throw new Error(`refused: ${type || "an unknown content type"} is not text`);
          const chunks: Uint8Array[] = [];
          let size = 0;
          for (const reader = res.body!.getReader(); ; ) {
            const { done, value } = await reader.read();
            if (done) break;
            if ((size += value.length) > MAX_BYTES) { await reader.cancel(); throw new Error("refused: the page is over 5 MiB"); }
            chunks.push(value);
          }
          const text = Buffer.concat(chunks).toString("utf8");
          if (!/html/i.test(type)) return text;
          const { NodeHtmlMarkdown } = await import("node-html-markdown");
          return NodeHtmlMarkdown.translate(text, { keepDataImages: false });
        } finally {
          // A reply refused unread (not text, an error status, a redirect) still holds its connection: close() waits for it.
          await res?.body?.cancel().catch(() => undefined);
          await dispatcher.close().catch(() => undefined);
        }
      }
    },
  };
}
