// A stand-in for monid's API (the monid tools' faux fetch, AGENTRUN_SERVE_FAUX_MONID) that refuses every call with an error
// echoing the key it was sent, as a vendor that repeats a wrong key back does. Each call's path is kept in `calls`.
export const calls = [];

export default async function echoMonid(url, init = {}) {
  const sent = new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
  calls.push(new URL(String(url)).pathname);
  return new Response(JSON.stringify({ code: 401, message: `Invalid API key: ${sent}` }), { status: 401, headers: { "content-type": "application/json" } });
}
