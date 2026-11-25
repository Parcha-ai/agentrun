// Where `npm run dev` sends the console's API requests and its matching public setup skill. It runs in the dev
// server's process, never in the bundle, so the key it is given stays out of every page.

/** The AgentRun Server a developer runs on this machine, at serve's default port (DEFAULT_PORT in packages/serve). */
export const LOCAL_SERVER = "http://127.0.0.1:7340"; // key-gate: loopback-rule serve on this machine at its default port, the npm run dev default only

/** The hosts AgentRun's client and CLI take as this machine (LOOPBACK in packages/client/src/client.ts, which the dev
 *  server does not import; scripts/loopback-hosts.test.mjs holds the copies to one set). AGENTRUN_TOKEN, the name a local
 *  server gives its token, goes to no other host. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]); // key-gate: loopback-rule the hosts AGENTRUN_TOKEN may go to

/** The variables the dev server reads, by the names AgentRun's client and CLI read them. */
export type DevProxyEnv = { AGENTRUN_BASE_URL?: string; AGENTRUN_API_KEY?: string; AGENTRUN_TOKEN?: string; AGENTRUN_URL?: string };

export type DevProxy = Record<"/v2" | "/skills/agentrun-serve/SKILL.md", { target: string; changeOrigin: true; headers: Record<string, string> }>;

/** What the dev server says once, when it starts: where it proxies and under which variable's key (`info`), or that a
 *  token was set and not sent (`warn`). A server's address and a variable's name, never a key. */
export type DevProxyNote = (kind: "info" | "warn", words: string) => void;

/** The server AGENTRUN_BASE_URL names, as a proxy reaches it: the address with its trailing slashes and one closing /v2
 *  cut, so the value the server prints when it starts (`…/v2`) and the bare address both work, as they do for the
 *  client. It is the URL parser's own spelling of the address, so the host the key rule reads is the host the proxy
 *  connects to: the proxy reads its target with an older parser, which takes `http:localhost` or `127.1` another way.
 *  The page asks for /v2/… itself, so an address whose v2 is not its last segment has nowhere to go and is refused.
 *  The address is never echoed: it may hold a password. */
export function devServerOf(given: string): string {
  const url = URL.canParse(given) ? new URL(given) : undefined;
  if (!url || !/^https?:$/.test(url.protocol) || /[?#]/.test(given) || url.username || url.password) {
    throw new Error("AGENTRUN_BASE_URL must be an http or https URL with no query, fragment, user or password: the server's address, with or without /v2.");
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v2$/, "").replace(/\/+$/, "");
  if (path.split("/").includes("v2")) throw new Error("AGENTRUN_BASE_URL must end at /v2 or hold none: the dev server asks for /v2 itself.");
  return `${url.origin}${path}`;
}

/** The AgentRun Server AGENTRUN_BASE_URL names, else the one on this machine. API requests alone carry a key:
 *  AGENTRUN_API_KEY to the server AGENTRUN_BASE_URL names, else AGENTRUN_TOKEN to a server on this machine and no other
 *  (the client's rule). AGENTRUN_API_KEY with no address is some other server's key and stays here, so a shell that
 *  exports it for the CLI still signs in on the page as before. With no key, the page signs in as the served one does.
 *  The public skill is fetched from the same build without credentials. The older AGENTRUN_URL is refused by name, so
 *  a shell that still sets it never looks at another server unnoticed. */
export function devProxy(env: DevProxyEnv, note: DevProxyNote = () => {}): DevProxy {
  if (env.AGENTRUN_URL && !env.AGENTRUN_BASE_URL) {
    throw new Error("AGENTRUN_URL is no longer read. Name the server with AGENTRUN_BASE_URL (its address, with or without /v2), and give AGENTRUN_API_KEY for a server that is not on this machine.");
  }
  const target = env.AGENTRUN_BASE_URL ? devServerOf(env.AGENTRUN_BASE_URL) : LOCAL_SERVER;
  const local = LOOPBACK.has(new URL(target).hostname);
  const from = env.AGENTRUN_BASE_URL && env.AGENTRUN_API_KEY ? "AGENTRUN_API_KEY" : local && env.AGENTRUN_TOKEN ? "AGENTRUN_TOKEN" : undefined;
  if (env.AGENTRUN_API_KEY && !env.AGENTRUN_BASE_URL) note("info", "AGENTRUN_API_KEY is not sent: it goes to the server AGENTRUN_BASE_URL names, and none is named.");
  if (from) note("info", `Proxying /v2 to ${target} with ${from}.`);
  else if (env.AGENTRUN_TOKEN) note("warn", `AGENTRUN_TOKEN is not sent to ${target}: it goes only to a server on this machine. Set AGENTRUN_API_KEY for this server.`);
  else if (env.AGENTRUN_BASE_URL) note("info", `Proxying /v2 to ${target} with no key.`);
  return {
    "/v2": { target, changeOrigin: true, headers: from ? { authorization: `Bearer ${env[from]}` } : {} },
    "/skills/agentrun-serve/SKILL.md": { target, changeOrigin: true, headers: {} },
  };
}

/** Whether a request the dev server received is the console page's own, or no browser's (a command line): the only ones
 *  the key rides on. Any page open in the developer's browser reaches this port as freely as the console does, and a
 *  server takes some writes a page can send with no preflight (an upload). A browser says where a request came from:
 *  Sec-Fetch-Site on every request, Origin on a write. One from another site, or from another page on this machine, goes
 *  on without the key, and the server answers it as it answers anyone.
 *  What this does not decide: a name that only resolves to this machine is turned away earlier, by Vite's own host check
 *  (its default `allowedHosts`), which this relies on. A request that says neither header counts as own: besides a
 *  command line, that is a read from a browser too old to send Sec-Fetch-Site, whose answer the other site cannot read. */
export function ownRequest(headers: { host?: string; origin?: string; "sec-fetch-site"?: string | string[] }): boolean {
  const site = headers["sec-fetch-site"];
  if (site !== undefined) return site === "same-origin" || site === "none";
  return headers.origin === undefined || (!!headers.host && headers.origin === `http://${headers.host}`);
}
