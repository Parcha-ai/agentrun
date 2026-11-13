// Under `faux` only (startServe's `fauxMonidCheck`): the fetch the start's check of a monid key the server is started
// with goes through, in place of monid's API (the tests' fake for that check alone; the runs' monid calls go through
// faux-monid.mjs). It answers monid's discover for the tests' key (faux-monid.mjs' KEY), and 401 in monid's words for
// any other. No network, no real key.
import { KEY } from "./faux-monid.mjs";

export const calls = [];

export default async function fakeMonidCheck(url, init = {}) {
  const { pathname } = new URL(String(url));
  const authorized = new Headers(init.headers).get("authorization") === `Bearer ${KEY}`;
  calls.push({ method: init.method ?? "GET", path: pathname, authorized });
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (!authorized) return json(401, { code: 401, message: "Missing or invalid API key" });
  return pathname === "/v1/discover" ? json(200, { results: [], query: "company data", count: 0 }) : json(404, { code: 404, message: "Not found" });
}
