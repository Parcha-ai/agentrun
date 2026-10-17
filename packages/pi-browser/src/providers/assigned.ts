// A provider over the one session a host assigned to the run (Parcha's site child: the session it reserved for this task).
// It never creates or ends a browser. create hands that session to one custody at a time, every attach asks the host for a
// fresh target (a relay's capability rotates), and release lets go of that custody's hold without asking the host: a
// custody releases at a failed launch, an orphan sweep or a conversation's end, and the session is the task's, not the
// conversation's. The host takes it back itself, once, when the task's browser closes; after that the session's own
// failure() answers every create. A second create while another custody holds it is a refusal: the run has one browser.
import { BrowserFailureError } from "../core/custody.js";
import { FAILURE_CODES, type BrowserFailure } from "../core/failures.js";
import type { AttachTarget, BrowserProvider, ProviderCaps } from "../core/host.js";
import type { LeaseRef, ResourceStatus } from "../core/lease.js";

export type AssignedSession = {
  /** The session's id: the same for every attach. */
  readonly id: string;
  /** A fresh target for the driver; it names no secret in `sdkCdpUrl` (a relay or a signed URL goes in `dial`). A failure
   *  the model should read is thrown as an error carrying `failure`. */
  attach(signal?: AbortSignal): Promise<AttachTarget>;
  status(signal?: AbortSignal): Promise<ResourceStatus>;
  /** Why the session can no longer be used (the host fenced it, took it back, it ended), or null while it can. */
  failure?(): BrowserFailure | null;
};

const refused = (message: string) => new BrowserFailureError({ ok: false, code: "refused", retryable: false, effect: "none", message });

/** A host session types a failure the model should read as an error carrying `failure`; the tool loop takes it as is. */
function typed(error: unknown): unknown {
  const failure = (error as { failure?: unknown } | null)?.failure as BrowserFailure | undefined;
  if (error instanceof BrowserFailureError || !failure || failure.ok !== false || !FAILURE_CODES.includes(failure.code)) return error;
  return new BrowserFailureError(failure);
}

export function assignedSessionProvider(input: { name: string; session: AssignedSession; maxLifetimeS?: number }): BrowserProvider {
  const { session } = input;
  const caps: ProviderCaps = { timeoutModel: "wall-clock", maxLifetimeS: input.maxLifetimeS ?? 21_600, survivesDisconnect: true, releaseIsAsync: false, extension: "preinstalled", fixedSession: true,
    // The host made the session and owns its sign-in: none of the run's session settings is applied, and no saved profile
    // can be loaded into it.
    settings: { proxies: false, verified: false, geolocation: false, region: false, context: false }, profiles: false };
  let heldBy: string | null = null;
  // A hold its custody let go of is over for that custody; the session goes on for the next one.
  const letGo = new Set<string>();
  const ours = (ref: LeaseRef) => ref.id === session.id;
  return {
    name: input.name,
    caps,
    async create(spec) {
      // A session that can no longer be used says why (a sign-in it needs, the host took it back), never that it is open elsewhere.
      const ended = session.failure?.();
      if (ended) throw new BrowserFailureError(ended);
      if (heldBy !== null && heldBy !== spec.tag) throw refused("This task has one browser, the website session assigned to it, and it is already open; keep using it.");
      heldBy = spec.tag;
      letGo.delete(spec.tag);
      return { id: session.id, tag: spec.tag };
    },
    findByTag: async (tag) => (heldBy === tag ? [{ id: session.id, tag }] : []),
    async status(ref, signal): Promise<ResourceStatus> {
      if (!ours(ref)) return "gone";
      if (letGo.has(ref.tag)) return "stopped";
      return session.status(signal);
    },
    async attach(ref, signal) {
      if (!ours(ref)) throw new Error("this session is not the one the host assigned to the run");
      try { return await session.attach(signal); }
      catch (error) { throw typed(error); }
    },
    async release(ref) {
      if (!ours(ref)) return;
      if (heldBy === ref.tag) heldBy = null;
      letGo.add(ref.tag);
    },
  };
}
