import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResourceStatus } from "../core/lease.js";
import type { CdpSession } from "./cdp-call.js";

export const nonEmpty = (v: unknown): string => String(v ?? "").trim();

/** Values are `[A-Za-z0-9._:-]`, at most 60 characters; the tag is exact, since a query matches it whole. */
export const tagValue = (v: string): string => String(v || "").replace(/[^A-Za-z0-9._:-]+/g, "_").slice(0, 60) || "unknown";

export function assertTag(tag: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(tag)) throw new Error("a session tag is [A-Za-z0-9_.-]");
}

export function extensionArchive(): string {
  return nonEmpty(process.env.STAGEHAND_EXTENSION_ARCHIVE_PATH) || path.join(path.dirname(fileURLToPath(import.meta.resolve("@browserbasehq/stagehand"))), "assets", "stagehand-extension.zip");
}

export const accountKey = (origin: string, apiKey: string): string => `${origin}|${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}`;

export const defaultSleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));
export const DEFAULT_CONFIRM = { polls: 6, intervalMs: 500 };

/** The work itself goes on when `signal` fires: another caller may be waiting for it. */
export function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    // The outcome is taken first, so a failure after the caller left is handled, never unhandled.
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** One upload per process and account; a failed upload is forgotten so the next create tries again. */
export function uploadOnce<T>(uploads: Map<string, Promise<T>>, account: string, upload: () => Promise<T>): Promise<T> {
  let up = uploads.get(account);
  if (!up) {
    up = upload();
    uploads.set(account, up);
    up.catch(() => uploads.delete(account));
  }
  return up;
}

/** The request is asked twice at most; released means the provider says the session is no longer running, not that the
 *  request was sent. `request` answers "gone" when the provider no longer knows the session. */
export async function releaseAndConfirm(o: {
  request: () => Promise<"gone" | void>;
  status: () => Promise<ResourceStatus>;
  forget: () => void;
  confirm: { polls: number; intervalMs: number };
  sleep: (ms: number) => Promise<void>;
  stillRunning: string;
}): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if ((await o.request()) === "gone") return o.forget();
      failure = undefined;
      break;
    } catch (error) { failure = error; }
  }
  for (let poll = 0; ; poll += 1) {
    const now = await o.status();
    if (now !== "running" && now !== "pending") return o.forget();
    if (poll >= o.confirm.polls) throw failure ?? new Error(o.stillRunning);
    await o.sleep(o.confirm.intervalMs);
  }
}

// Process-wide on purpose: a provider built later (custody builds one for the release) must still close the attach socket,
// drop the dial binding and reuse the account's upload. The URLs carry tokens and are never written anywhere.
export const browserbaseHoldings = {
  connectUrls: new Map<string, string>(),
  settings: new Map<string, Pick<CdpSession, "close" | "open">>(),
  opening: new Map<string, Promise<void>>(),
  uploads: new Map<string, Promise<string>>(),
  boundDials: new Map<string, string>(),
};
export const kernelHoldings = {
  cdpUrls: new Map<string, string>(),
  liveUrls: new Map<string, string>(),
  uploads: new Map<string, Promise<{ id: string } | { name: string }>>(),
};

export function resetProviderHoldings(): void {
  for (const holdings of [browserbaseHoldings, kernelHoldings]) for (const map of Object.values(holdings)) map.clear();
}
