// A scripted Browserbase SDK: an in-memory account that stamps each session with the metadata it was created with,
// answers `list({ q })` for `user_metadata['k']:'v'`, serves release as an asynchronous request, and records every call.
export function fakeBrowserbase(knobs = {}) {
  const calls = [];
  const sessions = new Map();
  let seq = 0;
  let extSeq = 0;
  const record = (op, detail = {}) => calls.push({ op, ...detail });
  const httpError = (status, message) => Object.assign(new Error(message), { status });
  const sdk = {
    extensions: {
      create: async (body, options) => { record("extensions.create", { hasFile: Boolean(body?.file), options }); if (knobs.extensionError) throw knobs.extensionError; extSeq += 1; return { id: `ext_${extSeq}` }; },
    },
    sessions: {
      create: async (body, options) => {
        record("sessions.create", { body, options });
        if (knobs.createError) throw knobs.createError;
        seq += 1;
        const id = `sess_${seq}`;
        sessions.set(id, { id, status: "RUNNING", userMetadata: { ...body.userMetadata }, connectUrl: `wss://connect.usw2.browserbase.com/${id}?signingKey=SECRET`, releaseRequested: false });
        return { id, connectUrl: sessions.get(id).connectUrl };
      },
      list: async (query, options) => {
        record("sessions.list", { query, options });
        const m = /^user_metadata\['([^']+)'\]:'([^']*)'$/.exec(query?.q ?? "");
        return [...sessions.values()]
          .filter((s) => (!query?.status || s.status === query.status) && (knobs.ignoreQuery || !m || s.userMetadata[m[1]] === m[2]))
          .map(({ id, status, userMetadata }) => ({ id, status, userMetadata }));
      },
      retrieve: async (id, options) => {
        record("sessions.retrieve", { id, options });
        if (knobs.retrieveError) throw knobs.retrieveError;
        const s = sessions.get(id);
        if (!s) throw httpError(404, "no such session");
        // A requested release is served after `releaseLag` lookups: the request is asynchronous.
        if (s.releaseRequested && s.status === "RUNNING" && (s.lookupsSinceRelease += 1) > (knobs.releaseLag ?? 0)) s.status = "COMPLETED";
        return { id, status: s.status, connectUrl: s.connectUrl };
      },
      update: async (id, body, options) => {
        record("sessions.update", { id, body, options });
        const failure = knobs.releaseErrors?.shift();
        if (failure) throw failure;
        const s = sessions.get(id);
        if (!s) throw httpError(404, "no such session");
        s.releaseRequested = true; s.lookupsSinceRelease = 0;
        return {};
      },
      debug: async (id) => {
        record("sessions.debug", { id });
        return { debuggerFullscreenUrl: `https://www.browserbase.com/devtools-fullscreen/inspector.html?s=${id}`, debuggerUrl: `https://www.browserbase.com/devtools/inspector.html?s=${id}`, pages: [{ id: "p1", url: "https://example.com", title: "Example", debuggerFullscreenUrl: `https://www.browserbase.com/devtools-fullscreen/inspector.html?s=${id}&p=p1` }] };
      },
    },
  };
  // Per-file downloads (`/v1/downloads`): rows by session, bytes by id, every read recorded.
  const downloads = new Map();
  let dlSeq = 0;
  sdk.get = async (path, options = {}) => {
    record("get", { path, options });
    if (path === "/v1/downloads") {
      const rows = [...downloads.values()].filter((d) => d.sessionId === options.query.sessionId);
      const page = rows.slice(options.query.offset ?? 0, (options.query.offset ?? 0) + (options.query.limit ?? 100));
      return { downloads: page.map(({ bytes, ...row }) => row), total: rows.length, limit: options.query.limit, offset: options.query.offset ?? 0 };
    }
    const found = downloads.get(decodeURIComponent(path.slice("/v1/downloads/".length)));
    if (!found) throw httpError(404, "no such download");
    return { body: (async function* () { for (let i = 0; i < found.bytes.length; i += 4) yield found.bytes.subarray(i, i + 4); })() };
  };
  const addDownload = (sessionId, filename, content) => {
    dlSeq += 1;
    const bytes = Buffer.from(content);
    downloads.set(`dl_${dlSeq}`, { id: `dl_${dlSeq}`, sessionId, filename, mimeType: "application/octet-stream", size: bytes.length, checksum: "not-checked", createdAt: new Date(Date.UTC(2026, 9, 6, 12, 0, dlSeq)).toISOString(), bytes });
  };
  // The Fetch and Search resources of the real SDK: the response is the API's (no final URL), the input is what the provider sent.
  sdk.fetchAPI = { create: async (input, options) => { record("fetch", { input, options }); if (input.url.includes("blocked")) return { id: "f", statusCode: 403, contentType: "text/html", encoding: "utf-8", headers: {}, content: "" }; return { id: "f", statusCode: 200, contentType: "text/markdown", encoding: "utf-8", headers: {}, content: "# Example\n\nHello from fetch." }; } };
  sdk.search = { web: async (input, options) => { record("search", { input, options }); return { query: input.query, requestId: "r", results: [{ id: "1", url: "https://example.com/a", title: "A" }] }; } };
  return { sdk, calls, sessions, addDownload, only: (op) => calls.filter((c) => c.op === op) };
}
