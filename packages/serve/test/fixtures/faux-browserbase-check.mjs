// Under `faux` only (startServe's `fauxBrowserbase`): the fetch Browserbase's key check goes through, in place of its
// API (the tests' fake). It answers its list of projects for KEY alone, and 401 in Browserbase's words for any other.
// With AGENTRUN_TEST_FAUX_BROWSERBASE_STALL set, a check is held, its signal ignored as a provider answering late, until
// release(). With AGENTRUN_TEST_FAUX_BROWSERBASE_CONTEXTS_DOWN set, no context is made (503). It also makes and deletes contexts, as an agent's saved sign-in asks (sign-ins.ts): `contexts` holds
// those that exist. No network, no real key.
export const KEY = ["bb", "live", "not-a-secret"].join("_");
export const calls = [];
export const contexts = new Set();
const held = [];
export const release = () => { for (const go of held.splice(0)) go(); };

export default async function fakeBrowserbase(url, init = {}) {
  const { pathname } = new URL(String(url));
  const key = new Headers(init.headers).get("x-bb-api-key") ?? "";
  calls.push({ method: init.method ?? "GET", path: pathname, authorized: key === KEY, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
  if (process.env.AGENTRUN_TEST_FAUX_BROWSERBASE_STALL) await new Promise((go) => held.push(go));
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (key !== KEY) return json(401, { statusCode: 401, error: "Unauthorized", message: "Invalid API key" });
  // With AGENTRUN_TEST_FAUX_BROWSERBASE_CONTEXTS_DOWN set, a context is not made: 503, as a vendor down for a while.
  if (pathname === "/v1/contexts" && init.method === "POST" && process.env.AGENTRUN_TEST_FAUX_BROWSERBASE_CONTEXTS_DOWN) return json(503, { message: "Service unavailable" });
  if (pathname === "/v1/contexts" && init.method === "POST") {
    const id = `ctx-${calls.length}-${Math.random().toString(16).slice(2, 10)}`;
    contexts.add(id);
    return json(201, { id, uploadUrl: "https://upload.example.test/", publicKey: "", cipherAlgorithm: "AES-256-CBC", initializationVectorSize: 16 });
  }
  const context = /^\/v1\/contexts\/([^/]+)$/.exec(pathname)?.[1];
  if (context && init.method === "DELETE") return contexts.delete(decodeURIComponent(context)) ? new Response(null, { status: 204 }) : json(404, { message: "Not found" });
  return pathname === "/v1/projects" ? json(200, [{ id: "proj-1", name: "QA" }]) : json(404, { message: "Not found" });
}
