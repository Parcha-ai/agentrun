// A fake Kernel REST API on loopback: an account that stamps each browser with its tags, filters `tags[k]=v`, pages by
// X-Has-More and X-Next-Offset, soft-deletes on DELETE, takes a multipart extension upload, records every request, and
// answers 401 to any request without the account's Bearer key. With `backend` (the package's FakeBackend) each browser is
// a FakeBackend session, so the crash matrix's ledger and its fake driver are the truth, and a held op holds the request.
//
// knobs: createStatus, deleteStatuses[] (one per DELETE, shifted), deleteLag (lookups before a delete shows), deletedIs404,
// ignoreFilter, pageSize, hasMoreWithoutOffset, uploadStatus, uploadConflict, echo (error bodies repeat every secret held),
// listBody ("object": a 200 list that is not an array; "cut": a 200 list whose body ends early), uploadDelayMs, storedLimit
// (the plan's stored-extension count: an upload past it answers 403 insufficient_plan, as Kernel's does).
import { createHash } from "node:crypto";
import http from "node:http";

export async function fakeKernel({ key, backend = null, sentinels = {}, knobs = {} } = {}) {
  const calls = [];
  const browsers = new Map();
  const extensions = new Map();
  let seq = 0;
  const secrets = () => [key, sentinels.kernelJwt, sentinels.kernelCdpUrl, sentinels.kernelLiveViewUrl].filter(Boolean);
  const cdpUrl = (id) => `${sentinels.kernelCdpUrl ?? "wss://kernel.fake.test/browser/cdp?jwt=not-a-secret"}&sessionId=${id}`;
  const view = ({ id, tags, deletedAt, url }) => ({ session_id: id, cdp_ws_url: url, browser_live_view_url: sentinels.kernelLiveViewUrl ?? "https://kernel.fake.test/live", created_at: "2026-10-08T00:00:00Z", headless: false, stealth: false, timeout_seconds: 600, tags, ...(deletedAt ? { deleted_at: deletedAt } : {}) });
  // A backend session whose create is held (applied, never answered) is already Kernel's: it is listed and deletable.
  const sync = () => {
    for (const s of backend?.sessions.values() ?? []) if (!browsers.has(s.id)) browsers.set(s.id, { id: s.id, tags: { ...s.metadata, agentrun_tag: s.tag }, deletedAt: null, url: cdpUrl(s.id), lookupsSinceDelete: null });
  };
  const live = async (b) => {
    if (b.deletedAt) return false;
    if (!backend) return true;
    if ((await backend.provider.status({ id: b.id, tag: b.tags.agentrun_tag })) === "running") return true;
    b.deletedAt = new Date().toISOString(); // the backend ended it (endAll): Kernel shows it deleted
    return false;
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, "http://fake");
    const route = `${req.method} ${url.pathname.replace(/^\/browsers\/[^/]+/, "/browsers/{id}").replace(/^\/extensions\/[^/]+/, "/extensions/{name}")}`;
    const row = { op: route, path: url.pathname, query: Object.fromEntries(url.searchParams), authorized: req.headers.authorization === `Bearer ${key}`, contentType: req.headers["content-type"] ?? null };
    calls.push(row);
    const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(body === undefined ? "" : JSON.stringify(body)); };
    const fail = (status, code) => send(status, { code, message: knobs.echo ? `${code}: ${secrets().join(" ")} ${req.headers.authorization ?? ""} ${raw.toString("utf8").slice(0, 2000)}` : code });
    try {
      if (!row.authorized) return fail(401, "unauthorized");
      const id = decodeURIComponent(url.pathname.split("/")[2] ?? "");
      sync();

      if (route === "POST /browsers") {
        const body = JSON.parse(raw.toString("utf8"));
        row.body = body;
        if (knobs.createStatus) return fail(knobs.createStatus, "internal_error");
        const { agentrun_tag: tag, ...metadata } = body.tags ?? {};
        const ref = backend ? await backend.provider.create({ tag, metadata, viewport: body.viewport, maxLifetimeS: 0, idleTimeoutS: body.timeout_seconds, proxies: false, verified: false, captcha: false }, new AbortController().signal) : { id: `kb_${(seq += 1)}` };
        const b = { id: ref.id, tags: { ...body.tags }, deletedAt: null, url: cdpUrl(ref.id), lookupsSinceDelete: null, body };
        browsers.set(b.id, b);
        return send(200, view(b));
      }
      if (route === "GET /browsers") {
        if (knobs.listBody === "object") return send(200, { browsers: [] });
        if (knobs.listBody === "cut") { res.writeHead(200, { "content-type": "application/json", "content-length": "500" }); res.write("[{\"session_id\":"); return res.destroy(); }
        const tagFilters = [...url.searchParams].filter(([k]) => /^tags\[.+\]$/.test(k)).map(([k, v]) => [k.slice(5, -1), v]);
        const all = [];
        for (const b of browsers.values()) {
          if (url.searchParams.get("status") === "active" && !(await live(b))) continue;
          if (!knobs.ignoreFilter && !tagFilters.every(([k, v]) => b.tags[k] === v)) continue;
          all.push(view(b));
        }
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const size = Math.min(Number(url.searchParams.get("limit") ?? 100), knobs.pageSize ?? 100);
        const page = all.slice(offset, offset + size);
        const more = offset + size < all.length;
        return send(200, page, { "x-has-more": String(more), ...(more && !knobs.hasMoreWithoutOffset ? { "x-next-offset": String(offset + size) } : {}) });
      }
      if (route === "GET /browsers/{id}") {
        const b = browsers.get(id);
        if (!b) return fail(404, "not_found");
        if (b.lookupsSinceDelete !== null && (b.lookupsSinceDelete += 1) > (knobs.deleteLag ?? 0) && !b.deletedAt) b.deletedAt = new Date().toISOString();
        if (!(await live(b)) && knobs.deletedIs404) return fail(404, "not_found");
        return send(200, view(b));
      }
      if (route === "DELETE /browsers/{id}") {
        const status = knobs.deleteStatuses?.shift();
        if (status) return fail(status, "internal_error");
        const b = browsers.get(id);
        if (!b || b.deletedAt) return fail(404, "not_found");
        if (backend) await backend.provider.release({ id: b.id, tag: b.tags.agentrun_tag }, new AbortController().signal);
        b.lookupsSinceDelete = 0;
        if (!knobs.deleteLag) b.deletedAt = new Date().toISOString();
        res.writeHead(200); return res.end();
      }
      if (route === "GET /extensions") {
        const all = [...extensions.entries()].map(([name, e]) => ({ id: e.id, name, size_bytes: e.size, checksum: e.checksum ?? null, created_at: "2026-10-08T00:00:00Z" }));
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const size = Math.min(Number(url.searchParams.get("limit") ?? 100), knobs.pageSize ?? 100);
        const more = offset + size < all.length;
        return send(200, all.slice(offset, offset + size), { "x-has-more": String(more), ...(more && !knobs.hasMoreWithoutOffset ? { "x-next-offset": String(offset + size) } : {}) });
      }
      if (route === "GET /extensions/{name}/metadata") {
        const found = extensions.get(id);
        return found ? send(200, { id: found.id, name: id, size_bytes: found.size, created_at: "2026-10-08T00:00:00Z" }) : fail(404, "not_found");
      }
      if (route === "POST /extensions") {
        const boundary = /boundary=([^;]+)/.exec(row.contentType ?? "")?.[1];
        const text = raw.toString("latin1");
        const name = /name="name"\r\n\r\n([^\r]*)\r\n/.exec(text)?.[1];
        const file = new RegExp(`name="file"; filename="[^"]+"\\r\\nContent-Type: application/zip\\r\\n\\r\\n`).exec(text);
        row.upload = { name: name ?? null, hasFile: Boolean(file), closed: Boolean(boundary && text.endsWith(`--${boundary}--\r\n`)), bytes: raw.length };
        if (knobs.uploadDelayMs) await new Promise((r) => setTimeout(r, knobs.uploadDelayMs));
        if (knobs.uploadStatus) return fail(knobs.uploadStatus, "upload_failed");
        if (!name || !file || !row.upload.closed) return fail(400, "bad_multipart");
        if (extensions.size >= (knobs.storedLimit ?? Infinity)) return fail(403, "insufficient_plan");
        const start = file.index + file[0].length;
        const bytes = raw.subarray(start, raw.length - `\r\n--${boundary}--\r\n`.length);
        extensions.set(name, { id: `ext_${extensions.size + 1}`, size: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex") });
        if (knobs.uploadConflict) return fail(409, "conflict");
        return send(200, { id: extensions.get(name).id, name, size_bytes: raw.length, created_at: "2026-10-08T00:00:00Z" });
      }
      return fail(404, "no_route");
    } catch (error) {
      // A held backend op never settles, so this is a real failure: answer it the way a server would.
      send(500, { code: "fake_failed", message: String(error?.message ?? error) });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: base, calls, browsers, extensions, knobs,
    // A stray request (another program probing an ephemeral port) never carries the key, so only the provider's count.
    only: (op) => calls.filter((c) => c.op === op && c.authorized),
    alive: () => [...browsers.values()].filter((b) => !b.deletedAt),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
