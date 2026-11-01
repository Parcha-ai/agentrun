// What the faux providers share: reading a request body (JSON, or the multipart a request with images is), finding the
// demo documents a request is about, a deterministic jitter, and a wait scaled by DEMO_FAUX_SPEED (default 1; 0 answers
// at once, 2 takes twice as long).
import { createHash } from "node:crypto";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { labels } from "./fixtures.mjs";

const byFile = new Map(labels.documents.map((d) => [d.file, d]));
const stems = labels.documents.map((d) => [d.file.replace(/\.pdf$/, ""), d]).sort((a, b) => b[0].length - a[0].length);

/** The request's JSON payload and how many image parts it carried. */
export async function readRequest(url, init = {}) {
  const request = url instanceof Request ? url : undefined;
  const headers = new Headers(init.headers ?? request?.headers);
  let body = init.body ?? (request ? await request.arrayBuffer() : undefined);
  const encoding = headers.get("content-encoding");
  if (encoding) {
    const bytes = Buffer.from(await new Response(body).arrayBuffer());
    body = encoding === "gzip" ? gunzipSync(bytes) : encoding === "br" ? brotliDecompressSync(bytes) : encoding === "deflate" ? inflateSync(bytes) : bytes;
  }
  const type = headers.get("content-type") ?? "";
  if (type.startsWith("multipart/form-data")) {
    const form = await new Response(body, { headers: { "content-type": type } }).formData();
    let images = 0;
    let json;
    for (const [name, value] of form.entries()) {
      if (name === "request") json = JSON.parse(typeof value === "string" ? value : await value.text());
      else if (typeof value !== "string" && /^image\//.test(value.type)) images += 1;
    }
    return { json, images, headers };
  }
  const text = typeof body === "string" ? body : await new Response(body).text();
  return { json: JSON.parse(text), images: 0, headers };
}

/** The labelled documents a request names (by file name or stem, as a page image path holds it), in order of first
 *  mention. */
export function documentsIn(value) {
  let text = JSON.stringify(value);
  const found = [];
  // Longest stem first, each blanked once found, so kyb-brisklow-bank inside kyb-brisklow-bank-mismatch is not counted.
  for (const [stem, doc] of stems) {
    const at = text.indexOf(stem);
    if (at < 0) continue;
    found.push({ at, doc });
    text = text.split(stem).join("\u0000".repeat(stem.length));
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.doc);
}

export const documentNamed = (file) => byFile.get(file);

/** A number in [-1, 1) fixed by the strings given: the same request answers the same way every rehearsal. */
export function jitter(...parts) {
  const h = createHash("sha256").update(parts.join("\u0000")).digest();
  return h.readUInt32BE(0) / 2 ** 31 - 1;
}

export const clamp = (p) => Math.min(0.995, Math.max(0.005, p));
export const round = (p) => Math.round(p * 1000) / 1000;

/** Waits `ms` times DEMO_FAUX_SPEED, or until the signal aborts (then throws, as fetch does). */
export function wait(ms, signal) {
  const speed = Number(process.env.DEMO_FAUX_SPEED ?? "1");
  const total = Number.isFinite(speed) && speed >= 0 ? ms * speed : ms;
  if (!total) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    const timer = setTimeout(resolve, total);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new DOMException("aborted", "AbortError")); }, { once: true });
  });
}

export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A choice answer with the chosen option at `p` and the rest spread over the others, plus its confidence the way
 *  TypeSafe documents it for Jev: (p - 1/n) / (1 - 1/n). */
export function choiceAnswer(options, chosen, p) {
  const others = options.filter((o) => o !== chosen);
  // Two places, as System One reports them.
  const two = (x) => Math.round(x * 100) / 100;
  const probabilities = Object.fromEntries(options.map((o) => [o, two(o === chosen ? p : (1 - p) / Math.max(1, others.length))]));
  const n = options.length;
  return { type: "choice", choice: chosen, confidence: round(Math.max(0, (p - 1 / n) / (1 - 1 / n))), probabilities };
}

/** A choice answer whose confidence is `confidence`: the chosen option's probability that gives it. */
export function choiceAtConfidence(options, chosen, confidence) {
  const n = options.length;
  return choiceAnswer(options, chosen, confidence * (1 - 1 / n) + 1 / n);
}

/** Appends one line per call to DEMO_FAUX_LOG, when set: what each fake was asked, for checking a rehearsal. */
export async function logCall(record) {
  if (!process.env.DEMO_FAUX_LOG) return;
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.DEMO_FAUX_LOG, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...record })}\n`);
}
