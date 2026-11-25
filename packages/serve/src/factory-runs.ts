// Read-only factory pages over the ordinary run store. Scope is selected in SQL before any journal is read; the
// keyset cursor is bound to its filters so rows ending or new runs starting cannot shift an offset page.
import { ApiError } from "./errors.js";
import type { RunRow, Store } from "./store/store.js";
import { ID } from "./validate.js";

export type FactoryScope = "active" | "review";
type Filters = { scope: FactoryScope; agent?: string; revision?: string };
type Cursor = Filters & { version: 1; before: { startedAt: number; id: string } };
const badCursor = () => new ApiError("bad_request", "cursor is not a factory cursor for these filters");

function cursorOf(text: string | null, filter: Filters): Cursor["before"] | undefined {
  if (text === null) return undefined;
  if (text.length > 4096 || !/^factory\.[A-Za-z0-9_-]+$/.test(text)) throw badCursor();
  let value: Cursor;
  try { value = JSON.parse(Buffer.from(text.slice(8), "base64url").toString("utf8")) as Cursor; }
  catch { throw badCursor(); }
  if (!value || value.version !== 1 || value.scope !== filter.scope || value.agent !== filter.agent || value.revision !== filter.revision
    || !value.before || !Number.isSafeInteger(value.before.startedAt) || value.before.startedAt < 0
    || typeof value.before.id !== "string" || !ID.test(value.before.id)
    || Object.keys(value).some((key) => !["version", "scope", "agent", "revision", "before"].includes(key))
    || Object.keys(value.before).some((key) => !["startedAt", "id"].includes(key))) throw badCursor();
  return value.before;
}

export async function factoryRunsPage(
  store: Pick<Store, "runs">,
  url: URL,
  filter: { agent?: string; revision?: string },
  summarize: (rows: readonly RunRow[]) => Promise<Record<string, unknown>[]>,
  now: () => number = Date.now,
) {
  const scope = url.searchParams.get("scope");
  if (scope !== "active" && scope !== "review") throw new ApiError("bad_request", "scope is active or review");
  if (url.searchParams.has("status") || url.searchParams.has("archived")) throw new ApiError("bad_request", "scope cannot be combined with status or archived: active includes archived executions; review lists terminal reviews separately");
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && !ID.test(value)) throw new ApiError("bad_request", `${key} is an id`);
  const asked = url.searchParams.get("limit");
  const limit = asked === null ? 50 : Number(asked);
  if (asked !== null && (!/^\d+$/.test(asked) || limit < 1 || limit > 100)) throw new ApiError("bad_request", "limit is an integer from 1 to 100");
  const bound = { ...filter, scope } satisfies Filters;
  const before = cursorOf(url.searchParams.get("cursor"), bound);
  const observed_at = new Date(now()).toISOString();
  const rows = await store.runs.list({ scope, agentId: filter.agent, revisionId: filter.revision, before, limit: limit + 1 });
  const page = rows.slice(0, limit);
  // The page's rows go to the caller together, so what it reads beside them is read once for the page, never per run
  // (server.ts runsPage: each run's kept listing). Failures are surfaced, never hidden as empty.
  const runs = await summarize(page);
  const last = page.at(-1);
  const next_cursor = rows.length > limit && last
    ? `factory.${Buffer.from(JSON.stringify({ version: 1, ...bound, before: { startedAt: last.startedAt, id: last.id } } satisfies Cursor)).toString("base64url")}`
    : null;
  return { runs, next_cursor, scope, observed_at };
}
