// A loopback port takes requests from more than the code under test. A process on the box probes each new loopback
// listener with a bare `GET /` (a Go HTTP client, no key, no body, within seconds of the listen), and another test
// process's client may still call a port it freed, which a fake then took. A fake that keeps the requests it got, to
// count them or to read what they carried, keeps only its own: each fake's handler starts with
//
//   if (stranger(req, res)) return;
//
// before it records anything. A stranger's request is answered 404 (its body drained) and never recorded among the
// fake's requests; `strays`, when given, keeps it apart for a test that wants to see it.
//
// `own(path, method)` names the fake's own requests (`path` without its query). With none, every request but a bare
// `GET /` (or `HEAD /`) is the fake's: no fake serves `/` to the code under test.

/** Whether `req` is a stranger's, which is then answered 404 here and kept in `strays` (when given) as
 *  `{ method, path, at }`. */
export function stranger(req, res, { own, strays } = {}) {
  const method = req.method ?? "GET";
  const path = new URL(req.url ?? "/", "http://fake.invalid").pathname;
  if (own ? own(path, method) : !((method === "GET" || method === "HEAD") && path === "/")) return false;
  strays?.push({ method, path, at: Date.now() });
  req.resume();
  res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `not this fake's: ${method} ${path}` } }));
  return true;
}
