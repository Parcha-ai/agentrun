/** Compatibility routes for the existing source-side CLI. Only bearer auth; browser cookies confer no authority. */
import { createHash, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  observationCapabilities,
  ObservationError,
  Observations,
} from "./observer.js";
const PREFIX = "/api/v2/control";
const digest = (v: string) => createHash("sha256").update(v).digest();
const send = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
};
async function read(req: IncomingMessage): Promise<unknown> {
  if (
    String(req.headers["content-type"] ?? "").split(";")[0] !==
    "application/json"
  )
    throw new ObservationError(415, "connector_otlp_encoding");
  const encoding = String(req.headers["content-encoding"] ?? "identity");
  if (!["identity", "gzip"].includes(encoding))
    throw new ObservationError(415, "connector_otlp_encoding");
  let length = 0;
  const chunks: Buffer[] = [];
  const timer = setTimeout(() => req.destroy(), 15_000);
  timer.unref();
  try {
    for await (const part of req) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      length += chunk.length;
      if (length > 65536) throw new ObservationError(413, "request_too_large");
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(timer);
  }
  try {
    let raw = Buffer.concat(chunks);
    if (encoding === "gzip") raw = gunzipSync(raw, { maxOutputLength: 65536 });
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch (error) {
    if (error instanceof ObservationError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE")
      throw new ObservationError(413, "request_too_large");
    throw new ObservationError(400, "connector_otlp_invalid");
  }
}
export function isObservationRoute(path: string) {
  return path === PREFIX || path.startsWith(PREFIX + "/");
}
export async function observationHttp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  observer: Observations,
  ownerToken: string,
): Promise<void> {
  try {
    const path = url.pathname.slice(PREFIX.length),
      method = req.method ?? "GET";
    const credential = String(req.headers.authorization ?? "").replace(
      /^Bearer /,
      "",
    );
    if (req.headers.origin)
      throw new ObservationError(403, "connector_browser_origin_denied");
    if (method === "GET" && path === "/connectors/capabilities")
      return send(res, 200, observationCapabilities());
    const scoped =
      /^\/connectors\/([A-Za-z0-9_-]+)\/(heartbeat|events|otel\/v1\/logs)$/.exec(
        path,
      );
    if (scoped && method === "POST") {
      const [, id, operation] = scoped;
      await observer.authenticate(id!, credential);
      const body = await read(req);
      const result =
        operation === "heartbeat"
          ? await observer.heartbeat(id!, credential, body)
          : operation === "events"
            ? await observer.events(id!, credential, body)
            : await observer.otlp(
                id!,
                credential,
                body,
                Number(req.headers["x-agentrun-selections-revision"]),
              );
      return send(res, 200, result);
    }
    if (
      !timingSafeEqual(
        digest(String(req.headers.authorization ?? "")),
        digest("Bearer " + ownerToken),
      )
    )
      throw new ObservationError(401, "connector_unauthorized");
    const workspace = url.searchParams.get("workspace_id");
    if (workspace !== null && workspace !== "local")
      throw new ObservationError(403, "workspace_not_authorized");
    if (method === "GET" && path === "/identity")
      return send(res, 200, { user_id: "owner", workspace_ids: ["local"] });
    if (method === "GET" && path === "/auth/device")
      return send(res, 200, { enabled: false });
    if (path === "/connectors" && method === "POST")
      return send(res, 200, await observer.register(await read(req)));
    if (path === "/connectors" && method === "GET")
      return send(res, 200, paginate((await observer.list()).items, url));
    const owned =
      /^\/connectors\/([A-Za-z0-9_-]+)(?:\/(rotate-credential|selections))?$/.exec(
        path,
      );
    if (owned) {
      const [, id, operation] = owned;
      if (!operation && method === "DELETE")
        return send(res, 200, await observer.revoke(id!));
      if (operation === "rotate-credential" && method === "POST") {
        const body = await read(req);
        if (
          !body ||
          Array.isArray(body) ||
          typeof body !== "object" ||
          Object.keys(body).length
        )
          throw new ObservationError(422, "connector_invalid");
        return send(res, 200, await observer.rotate(id!));
      }
      if (operation === "selections" && method === "PATCH")
        return send(res, 200, await observer.select(id!, await read(req)));
    }
    if (method === "GET" && path === "/connected-sessions") {
      const current = url.searchParams.get("current_only") === "true";
      const view = await observer.snapshot();
      const sessions = view.sessions.filter(
        (s) =>
          !current ||
          (s.selection_active &&
            s.connection_state !== "disconnected" &&
            !["finished", "failed", "stopped"].includes(s.reported_activity)),
      );
      return send(res, 200, paginate(sessions, url));
    }
    throw new ObservationError(404, "connector_route_not_found");
  } catch (error) {
    if (!(error instanceof ObservationError)) throw error;
    send(
      res,
      error.status,
      { detail: { code: error.code, ...error.details } },
      {
        ...(error.status === 429
          ? { "retry-after": String(error.details.retry_after_seconds ?? 60) }
          : {}),
      },
    );
  }
}
function paginate<T extends { id: string }>(items: T[], url: URL) {
  const limit = Number(url.searchParams.get("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new ObservationError(422, "invalid_limit");
  const ordered = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const cursor = url.searchParams.get("cursor");
  const index = cursor ? ordered.findIndex((r) => r.id === cursor) : -1;
  if (cursor && index < 0) throw new ObservationError(422, "invalid_cursor");
  const page = ordered.slice(index + 1, index + 1 + limit);
  return {
    items: page,
    next_cursor: ordered.length > index + 1 + limit ? page.at(-1)!.id : null,
  };
}
