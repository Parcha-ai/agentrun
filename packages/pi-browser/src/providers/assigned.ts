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

/** Which custody holds a session, and the holds let go of, kept per session: a host may make the provider per call (the
 *  durable adapter asks its factory at every create and every later use), and every provider over one session is one custody. */
// The names are this file's own, so the bundle renames nothing elsewhere for them; the map is made at the first provider.
type AssignedHold = { heldBy: string | null; letGo: Set<string> };
let assignedHolds: WeakMap<AssignedSession, AssignedHold> | undefined;
const assignedHoldOf = (session: AssignedSession): AssignedHold => {
  assignedHolds ??= new WeakMap();
  let assignedCustody = assignedHolds.get(session);
  if (!assignedCustody) { assignedCustody = { heldBy: null, letGo: new Set() }; assignedHolds.set(session, assignedCustody); }
  return assignedCustody;
};

export function assignedSessionProvider(input: { name: string; session: AssignedSession; maxLifetimeS?: number }): BrowserProvider {
  const { session } = input;
  const caps: ProviderCaps = { timeoutModel: "wall-clock", maxLifetimeS: input.maxLifetimeS ?? 21_600, survivesDisconnect: true, releaseIsAsync: false, extension: "preinstalled", fixedSession: true,
    // The host made the session and owns its sign-in: none of the run's session settings is applied, and no saved profile
    // can be loaded into it.
    settings: { proxies: false, verified: false, geolocation: false, region: false, context: false }, profiles: false };
  // A hold its custody let go of is over for that custody; the session goes on for the next one.
  const assignedCustody = assignedHoldOf(session);
  const ours = (ref: LeaseRef) => ref.id === session.id;
  return {
    name: input.name,
    caps,
    async create(spec) {
      // A session that can no longer be used says why (a sign-in it needs, the host took it back), never that it is open elsewhere.
      const ended = session.failure?.();
      if (ended) throw new BrowserFailureError(ended);
      if (assignedCustody.heldBy !== null && assignedCustody.heldBy !== spec.tag) throw refused("This task has one browser, the website session assigned to it, and it is already open; keep using it.");
      assignedCustody.heldBy = spec.tag;
      assignedCustody.letGo.delete(spec.tag);
      return { id: session.id, tag: spec.tag };
    },
    findByTag: async (tag) => (assignedCustody.heldBy === tag ? [{ id: session.id, tag }] : []),
    async status(ref, signal): Promise<ResourceStatus> {
      if (!ours(ref)) return "gone";
      if (assignedCustody.letGo.has(ref.tag)) return "stopped";
      return session.status(signal);
    },
    async attach(ref, signal) {
      if (!ours(ref)) throw new Error("this session is not the one the host assigned to the run");
      try { return await session.attach(signal); }
      catch (error) { throw typed(error); }
    },
    async release(ref) {
      if (!ours(ref)) return;
      if (assignedCustody.heldBy === ref.tag) assignedCustody.heldBy = null;
      assignedCustody.letGo.add(ref.tag);
    },
  };
}
