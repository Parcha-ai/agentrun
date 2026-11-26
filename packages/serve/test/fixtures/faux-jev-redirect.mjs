// Under --faux only: a TypeSafe host that answers on loopback. Each request the web tools' Jev sends (web-run.ts
// jevWebOf) goes, with the init serve's handed fetch gave it, to the address AGENTRUN_TEST_FAUX_JEV_REDIRECT_FROM names,
// on the same path. The test runs a server there that answers 307 to another port.
export default async function redirectingJev(url, init = {}) {
  const from = process.env.AGENTRUN_TEST_FAUX_JEV_REDIRECT_FROM;
  if (!from) throw new Error("AGENTRUN_TEST_FAUX_JEV_REDIRECT_FROM is not set");
  const { pathname, search } = new URL(String(url));
  return fetch(`${from}${pathname}${search}`, init);
}
