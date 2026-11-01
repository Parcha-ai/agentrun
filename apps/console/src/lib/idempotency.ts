import type { Run } from "./v2";

/** A random v4 UUID. `crypto.randomUUID` exists only in a secure context (https or localhost); a console served over
 *  plain http on another host has `getRandomValues` alone. */
export function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** One Idempotency-Key per request: sending the same request again (a retry after a lost or refused answer) reuses its
 *  key, so the server answers with what it already did; a changed request, or one after `done()`, gets a new key. */
export function keeper(newKey: () => string = uuid) {
  let held: { request: string; key: string } | null = null;
  return {
    keyFor(scope: string, body: unknown): string {
      const request = JSON.stringify([scope, body]);
      if (held?.request !== request) held = { request, key: newKey() };
      return held.key;
    },
    done() { held = null; },
  };
}

/** Sends a message to a run under its request's key, and lets the key go only once the server took it: a message whose
 *  answer was lost or refused is resent as the same request, never taken twice. */
export async function sendOnce<R>(keys: ReturnType<typeof keeper>, runId: string, content: string, send: (runId: string, content: string, key: string) => Promise<R>): Promise<R> {
  const r = await send(runId, content, keys.keyFor(runId, { content }));
  keys.done();
  return r;
}

/** The next page of runs added to those shown: the server's cursor is an offset, so a run a new one pushed down is sent
 *  again and is kept once. */
export function appendRuns(held: Run[], page: Run[]): Run[] {
  const seen = new Set(held.map((r) => r.run_id));
  return [...held, ...page.filter((r) => !seen.has(r.run_id))];
}
