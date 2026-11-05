// Under `faux` only (startServe's `fauxKernel`): the fetch a Kernel key's check goes through, in place of Kernel's API
// (the tests' fake). It answers its list of browsers for KEY alone, and 401 in Kernel's words for any other. No network,
// no real key.
export const KEY = ["sk", "kernel", "not-a-secret"].join("_");
export const calls = [];

export default async function fakeKernel(url, init = {}) {
  const { pathname, search } = new URL(String(url));
  const authorized = new Headers(init.headers).get("authorization") === `Bearer ${KEY}`;
  calls.push({ method: init.method ?? "GET", path: pathname, search, authorized });
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (!authorized) return json(401, { code: "unauthorized", message: "Invalid API key." });
  return pathname === "/browsers" ? json(200, []) : json(404, { code: "not_found", message: "Not found." });
}
