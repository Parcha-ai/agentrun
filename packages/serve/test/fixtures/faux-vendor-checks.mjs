// Under `faux` only: the browser vendors' REST APIs as a test's server fakes them (startServe's `fauxBrowserbase` and
// `fauxKernel`: faux-browserbase-check.mjs and faux-kernel-check.mjs), for its in-process runner too (test/support.mjs
// startInProcessRunner, as tools.ts's FAUX_VENDOR_API_ENV): a run's first saved sign-in is made at the same fakes the
// server's own calls reach, so a test reads one set of calls and contexts. Each request goes to the fake of the vendor
// its host names. No network, no real key.
import fakeBrowserbase from "./faux-browserbase-check.mjs";
import fakeKernel from "./faux-kernel-check.mjs";

export default async function fakeVendorChecks(url, init = {}) {
  const { hostname } = new URL(String(url));
  if (hostname.endsWith("browserbase.com")) return fakeBrowserbase(url, init);
  if (hostname.endsWith("onkernel.com")) return fakeKernel(url, init);
  return new Response(JSON.stringify({ message: "Not found" }), { status: 404, headers: { "content-type": "application/json" } });
}
