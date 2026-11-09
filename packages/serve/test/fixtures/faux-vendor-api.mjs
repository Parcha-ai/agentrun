// Under `faux` only: the browser vendors' REST APIs a runner's first saved sign-in is made at (sign-ins.ts vendorsOver):
// Browserbase's POST /v1/contexts and DELETE /v1/contexts/{id}, Kernel's POST /profiles and DELETE /profiles/{name}. Each
// call is noted in `calls` with the key it was sent with (Browserbase's x-bb-api-key, Kernel's bearer), so a test can tell
// whose keys made it. With AGENTRUN_TEST_FAUX_VENDOR_DOWN set, nothing is made (503); with
// AGENTRUN_TEST_FAUX_VENDOR_DELETE_DOWN set, nothing is deleted (503). No network, no real key.
export const calls = [];
let made = 0;

export default async function fakeVendors(url, init = {}) {
  const { pathname } = new URL(String(url));
  const headers = new Headers(init.headers);
  const key = headers.get("x-bb-api-key") ?? headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const method = init.method ?? "GET";
  calls.push({ method, path: pathname, key });
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (method === "POST" && process.env.AGENTRUN_TEST_FAUX_VENDOR_DOWN) return json(503, { message: "Service unavailable" });
  if (method === "POST" && pathname === "/v1/contexts") return json(201, { id: `ctx-made-${(made += 1)}` });
  if (method === "POST" && pathname === "/profiles") return json(200, { name: JSON.parse(String(init.body)).name });
  if (method === "DELETE" && process.env.AGENTRUN_TEST_FAUX_VENDOR_DELETE_DOWN) return json(503, { message: "Service unavailable" });
  if (method === "DELETE") return new Response(null, { status: 204 });
  return json(404, { message: "Not found" });
}
