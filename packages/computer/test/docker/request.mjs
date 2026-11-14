// A create's context for a live Docker test: a request id of its own. Docker names the container for the request, so an
// id is never reused across runs: a container another run left on this host would answer the retry, or refuse it.
import { randomUUID } from "node:crypto";

/** A fresh request, named for what asks it. */
export const newRequest = (what) => ({ requestId: `${what}-${randomUUID()}` });
