// Where a run's process serves, as its server learns it: the one door line the process prints first on stdout, before
// any harness or agent code of it runs (pi-durable-disk's run under its host's epoch), proven with the nonce the server
// handed the process for this launch before the server records it. stdout also carries harness and agent output, so a
// line is never trusted on its own: only the first is read, it must name this launch's epoch and an http address (which
// its caller holds to loopback), and the door there must answer the server's challenge with the nonce (POST /door-proof).
// Any later line, door-looking or not, is drained and ignored.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import { doorProof } from "@parcha/pi-durable-disk/internals";

/** The longest first line read: a door line is far shorter; anything longer is not one. */
const MAX_LINE = 4_096;

/** The address the first line of `stdout` names, when it is a door line for `epoch` naming an `http:` address (its origin);
 *  undefined for anything else (another line first, a stream that ends first). Everything after it is drained, unread. */
export function firstDoorLine(stdout: Readable, epoch: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let buffered = "";
    let done = false;
    const finish = (door: string | undefined) => {
      if (done) return;
      done = true;
      stdout.off("data", onData);
      stdout.resume();
      resolve(door);
    };
    const onData = (chunk: Buffer | string) => {
      buffered += String(chunk);
      const at = buffered.indexOf("\n");
      if (at < 0) return void (buffered.length > MAX_LINE && finish(undefined));
      let said: { event?: unknown; epoch?: unknown; serve?: unknown } | undefined;
      try {
        said = JSON.parse(buffered.slice(0, at)) as typeof said;
      } catch {
        return finish(undefined);
      }
      const url = typeof said?.serve === "string" ? URL.parse(said.serve) : null;
      const door = said?.event === "door" && said.epoch === epoch && url?.protocol === "http:" ? url.origin : undefined;
      finish(door);
    };
    stdout.on("data", onData);
    stdout.once("end", () => finish(undefined));
    stdout.once("error", () => finish(undefined));
  });
}

/** Whether the door at `door` answers a fresh challenge with `nonce` (doorProof), within `timeoutMs`; `headers` carry its
 *  bearer token. */
export async function verifyDoor(door: string, nonce: string, headers: Record<string, string>, timeoutMs = 5_000): Promise<boolean> {
  const challenge = randomBytes(16).toString("hex");
  try {
    const res = await fetch(new URL("/door-proof", door), { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ challenge }), signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) return false;
    const proof = ((await res.json()) as { proof?: unknown }).proof;
    const want = Buffer.from(doorProof(nonce, challenge));
    return typeof proof === "string" && proof.length === want.length && timingSafeEqual(Buffer.from(proof), want);
  } catch {
    return false;
  }
}

/** How a wait for a door to serve its run ended: it serves, its process went first, or the deadline came, with the
 *  door's last answer to GET /status in words. */
export type Opened = { opened: true } | { opened: false; why: "gone" } | { opened: false; why: "deadline"; last: string };

/** Waits until the door at `door` serves its run (GET /status answers 200: the run opened, its app loaded), its process
 *  goes (`gone()`), or `deadline` (ms since the epoch) passes: no poll after it. A door listens before its run opens,
 *  answering 503 OPENING until then: the run is not taken for up, nor its launch for come through, before it serves. */
export async function untilOpened(door: string, headers: Record<string, string>, gone: () => boolean, deadline: number, everyMs = 100): Promise<Opened> {
  let last = "no answer";
  for (;;) {
    if (gone()) return { opened: false, why: "gone" };
    if (Date.now() > deadline) return { opened: false, why: "deadline", last };
    const res = await fetch(new URL("/status", door), { headers, signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, deadline - Date.now()))) }).catch(() => undefined);
    if (res?.status === 200) return { opened: true };
    if (res) {
      const code = await res.json().then((body: { error?: unknown }) => (typeof body?.error === "string" ? ` ${body.error}` : ""), () => "");
      last = `${res.status}${code}`;
    } else if (Date.now() < deadline) last = "no answer"; // one the deadline cut keeps the answer before it
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}
