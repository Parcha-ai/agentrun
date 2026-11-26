// Under --faux only: a fetch a provider may be handed (decisions.ts fauxFetch) that files every URL it is asked for in
// `asked`, passes a loopback one to the real fetch, and answers any other with a 500 itself, so a test that expects a
// vendor's own host never reaches it.
export const asked = [];

export default async function loopbackOnlyFetch(url, init) {
  asked.push(String(url));
  return new URL(String(url)).hostname === "127.0.0.1" ? fetch(url, init) : new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
}
