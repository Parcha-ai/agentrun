// The run link, read live. A run link (`http://host:port/run/ID#SECRET`) lives in a private file that whoever starts the 03 server
// writes; a restart or a retake writes a new one (a new run, often a new port). The stage follows the file instead of reading it once,
// so "restart the server and rewrite the file" is all a retake takes. The secret is never logged and never leaves this server.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export type LinkTarget = { origin: string; run: string; secret: string; wsUrl: string };

export function parseLink(text: string): LinkTarget {
  const u = new URL(text.trim());
  const run = decodeURIComponent(u.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (!run || !u.hash.slice(1)) throw new Error("not a run link: it needs /run/<id>#<secret>");
  return { origin: u.origin, run, secret: u.hash.slice(1), wsUrl: `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}/ws` };
}

/** Identifies a run without exposing its secret: a new origin, run id or secret (a restarted server) is a different key. */
export function linkKey(t: LinkTarget): string {
  return `${t.origin}|${t.run}|${createHash("sha256").update(t.secret).digest("hex").slice(0, 12)}`;
}

export class LiveLink {
  private file: string;
  private stamp = "";
  private cached: LinkTarget | undefined;

  constructor(file: string) {
    this.file = file;
  }

  /** The link in the file now. Reads the file again only when it changed; throws if it is missing or not a run link. */
  current(): LinkTarget {
    const st = statSync(this.file);
    const stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
    if (!this.cached || stamp !== this.stamp) {
      this.cached = parseLink(readFileSync(this.file, "utf8"));
      this.stamp = stamp;
    }
    return this.cached;
  }

  /** The link if the file has one, else undefined (the server is not up yet). */
  tryCurrent(): LinkTarget | undefined {
    try {
      return this.current();
    } catch {
      return undefined;
    }
  }
}
