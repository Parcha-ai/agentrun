// Where `npm run dev` sends the console's API requests and its matching public setup skill. It runs in the dev
// server's process, never in the bundle, so the API token it is given stays out of every page.

/** The AgentRun Server a developer runs on this machine, at serve's default port (DEFAULT_PORT in packages/serve). */
export const LOCAL_SERVER = "http://127.0.0.1:7340"; // key-gate: loopback-rule serve on this machine at its default port, the npm run dev default only

/** The AgentRun Server AGENTRUN_URL names, else the one on this machine. API requests alone receive AGENTRUN_TOKEN;
 *  the public skill is fetched from the same build without adding credentials. */
export type DevProxy = Record<"/v2" | "/skills/agentrun-serve/SKILL.md", { target: string; changeOrigin: true; headers: Record<string, string> }>;

export function devProxy(env: { AGENTRUN_URL?: string; AGENTRUN_TOKEN?: string }): DevProxy {
  const target = env.AGENTRUN_URL || LOCAL_SERVER;
  return {
    "/v2": { target, changeOrigin: true, headers: env.AGENTRUN_TOKEN ? { authorization: `Bearer ${env.AGENTRUN_TOKEN}` } : {} },
    "/skills/agentrun-serve/SKILL.md": { target, changeOrigin: true, headers: {} },
  };
}
