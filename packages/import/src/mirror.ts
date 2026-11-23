// A request two sources both wrote counts once. OpenCode's claude-agent provider runs Claude Code, which keeps its own
// transcript of each request, and the OpenCode turn names that session (its `mirrors`). When that session is counted
// too (read in the same call, or held by the caller already), the request's usage and cost are that session's, and the
// mirroring turn counts nothing. The one rule for every caller: parseHome's totals and serve's import.
import type { Answer } from "./types.js";

/** A session as the rule names it: its source and its id. */
export const sessionKey = (source: string, id: string): string => `${source}:${id}`;

/** The rule over the sessions counted (each a sessionKey): whether a request is one of theirs, so not its own session's. */
export const mirroredIn =
  (counted: ReadonlySet<string>) =>
  ({ mirrors }: Pick<Answer, "mirrors">): boolean =>
    mirrors !== undefined && counted.has(sessionKey(mirrors.source, mirrors.sessionId));

/** A session's own requests, those `mirrored` takes left out, and its cost of them: the cost it wrote when it holds none
 *  of another's, else its own requests' summed, unknown when one that used tokens is not priced. */
export function ownRequests<A extends Answer>(requests: readonly A[], cost: number | undefined, mirrored: (request: A) => boolean): { requests: A[]; cost: number | undefined } {
  const own = requests.filter((request) => !mirrored(request));
  if (own.length === requests.length) return { requests: own, cost };
  const priced = own.every((request) => request.costUsd !== undefined || !request.usage);
  return { requests: own, cost: priced ? own.reduce((n, request) => n + (request.costUsd ?? 0), 0) : undefined };
}
