// Under `faux` only (startServe's `fauxBrowserbase`): the fetch Browserbase's key check goes through, in place of its
// API (the tests' fake). It answers its list of projects for KEY alone, and 401 in Browserbase's words for any other.
// With AGENTRUN_TEST_FAUX_BROWSERBASE_STALL set, a check is held, its signal ignored as a provider answering late, until
// release(). No network, no real key.
export const KEY = ["bb", "live", "not-a-secret"].join("_");
export const calls = [];
const held = [];
export const release = () => { for (const go of held.splice(0)) go(); };

export default async function fakeBrowserbase(url, init = {}) {
  const { pathname } = new URL(String(url));
  const key = new Headers(init.headers).get("x-bb-api-key") ?? "";
  calls.push({ method: init.method ?? "GET", path: pathname, authorized: key === KEY });
  if (process.env.AGENTRUN_TEST_FAUX_BROWSERBASE_STALL) await new Promise((go) => held.push(go));
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (key !== KEY) return json(401, { statusCode: 401, error: "Unauthorized", message: "Invalid API key" });
  return pathname === "/v1/projects" ? json(200, [{ id: "proj-1", name: "QA" }]) : json(404, { message: "Not found" });
}
