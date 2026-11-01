// Where `npm run dev` sends the console's /v2 requests. It runs in the dev server's process, never in the bundle, so
// the token it is given stays out of every page.

/** The AgentRun Server a developer runs on this machine, at serve's default port (DEFAULT_PORT in packages/serve). */
export const LOCAL_SERVER = "http://127.0.0.1:7340"; // key-gate: loopback-rule serve on this machine at its default port, the npm run dev default only

/** The dev server's proxy for /v2: the AgentRun Server AGENTRUN_URL names (its origin), else the one on this machine,
 *  with AGENTRUN_TOKEN as a bearer header when it is set. */
export type DevProxy = Record<"/v2", { target: string; changeOrigin: true; headers: Record<string, string> }>;

export function devProxy(env: { AGENTRUN_URL?: string; AGENTRUN_TOKEN?: string }): DevProxy {
  const target = env.AGENTRUN_URL || LOCAL_SERVER;
  return { "/v2": { target, changeOrigin: true, headers: env.AGENTRUN_TOKEN ? { authorization: `Bearer ${env.AGENTRUN_TOKEN}` } : {} } };
}
