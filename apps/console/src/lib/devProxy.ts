// Where `npm run dev` sends the console's API requests and its matching public setup skill. It runs in the dev
// server's process, never in the bundle, so the key it is given stays out of every page.

/** The AgentRun Server a developer runs on this machine, at serve's default port (DEFAULT_PORT in packages/serve). */
export const LOCAL_SERVER = "http://127.0.0.1:7340"; // key-gate: loopback-rule serve on this machine at its default port, the npm run dev default only

/** The hosts AgentRun's client and CLI take as this machine (LOOPBACK in packages/client/src/client.ts, which the dev
 *  server does not import). AGENTRUN_TOKEN, the name a local server gives its token, goes to no other host. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]); // key-gate: loopback-rule the hosts AGENTRUN_TOKEN may go to

/** The variables the dev server reads, by the names AgentRun's client and CLI read them. */
export type DevProxyEnv = { AGENTRUN_BASE_URL?: string; AGENTRUN_API_KEY?: string; AGENTRUN_TOKEN?: string; AGENTRUN_URL?: string };

export type DevProxy = Record<"/v2" | "/skills/agentrun-serve/SKILL.md", { target: string; changeOrigin: true; headers: Record<string, string> }>;

/** The server AGENTRUN_BASE_URL names, as a proxy reaches it: the address with its trailing slashes and one closing /v2
 *  cut, so the value the server prints when it starts (`…/v2`) and the bare address both work, as they do for the
 *  client. The page asks for /v2/… itself, so an address whose v2 is not its last segment has nowhere to go and is
 *  refused. The address is never echoed: it may hold a password. */
export function devServerOf(given: string): string {
  const url = URL.canParse(given) ? new URL(given) : undefined;
  if (!url || !/^https?:$/.test(url.protocol) || /[?#]/.test(given) || url.username || url.password) {
    throw new Error("AGENTRUN_BASE_URL must be an http or https URL with no query, fragment, user or password: the server's address, with or without /v2.");
  }
  const server = given.replace(/\/+$/, "").replace(/\/v2$/, "");
  if (new URL(server).pathname.split("/").includes("v2")) throw new Error("AGENTRUN_BASE_URL must end at /v2 or hold none: the dev server asks for /v2 itself.");
  return server;
}

/** The AgentRun Server AGENTRUN_BASE_URL names, else the one on this machine. API requests alone carry a key, by the
 *  client's rule: AGENTRUN_API_KEY, else AGENTRUN_TOKEN for a server on this machine and no other. With neither, the
 *  page signs in as the served one does. The public skill is fetched from the same build without credentials.
 *  `note` hears what a developer would otherwise meet as a bare 401: a token that was set and not sent. The older
 *  AGENTRUN_URL is refused by name, so a shell that still sets it never looks at another server unnoticed. */
export function devProxy(env: DevProxyEnv, note: (words: string) => void = () => {}): DevProxy {
  if (env.AGENTRUN_URL && !env.AGENTRUN_BASE_URL) {
    throw new Error("AGENTRUN_URL is no longer read. Name the server with AGENTRUN_BASE_URL (its address, with or without /v2), and give AGENTRUN_API_KEY for a server that is not on this machine.");
  }
  const target = env.AGENTRUN_BASE_URL ? devServerOf(env.AGENTRUN_BASE_URL) : LOCAL_SERVER;
  const key = env.AGENTRUN_API_KEY || (LOOPBACK.has(new URL(target).hostname) ? env.AGENTRUN_TOKEN : undefined);
  if (!key && env.AGENTRUN_TOKEN) note(`AGENTRUN_TOKEN is not sent to ${new URL(target).origin}: it goes only to a server on this machine. Set AGENTRUN_API_KEY for this server, or sign in on the page.`);
  return {
    "/v2": { target, changeOrigin: true, headers: key ? { authorization: `Bearer ${key}` } : {} },
    "/skills/agentrun-serve/SKILL.md": { target, changeOrigin: true, headers: {} },
  };
}
