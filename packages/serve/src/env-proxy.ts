// The process's outbound calls through the standard proxy variables, as curl and Node's own --use-env-proxy read them:
// https_proxy or HTTPS_PROXY, http_proxy or HTTP_PROXY (lowercase first), and no_proxy or NO_PROXY for the hosts that go
// direct. cli.ts calls it first, for every command, so the server and the runner make every vendor call through one
// proxy (a gateway that holds the allowlist). Neither proxy set: nothing changes.
//
// Node's http.setGlobalProxyFromEnv covers fetch, Node's global WebSocket (both undici's global dispatcher) and
// http(s).request on the global agent. gRPC (@grpc/grpc-js, under Modal's and boxd's SDKs) reads only its own lowercase
// names, so grpc_proxy and no_grpc_proxy are set from the same values, each unless already set. The two
// clients none of this reaches, E2B's SDK and Morph's SSH gateway, read the same variables through
// @parcha/agentrun-computer's env-proxy.ts. This machine's loopback and the server's own public address
// (AGENTRUN_PUBLIC_URL, RENDER_EXTERNAL_URL: where dialing computers reach the attach hub) always go direct.
import * as http from "node:http";

type SetGlobalProxyFromEnv = (env: Record<string, string>) => () => void;

/** Installs the proxy the environment names for this process's fetch, WebSocket, http(s) and gRPC; nothing when none. */
export function installEnvProxy(env: NodeJS.ProcessEnv = process.env): void {
  const https = env.https_proxy || env.HTTPS_PROXY;
  const plain = env.http_proxy || env.HTTP_PROXY;
  if (!https && !plain) return;
  const given = (env.no_proxy || env.NO_PROXY || "").split(",").map((entry) => entry.trim()).filter(Boolean);
  // grpc-js reads grpc_proxy (else a lowercase https_proxy or http_proxy) and no_grpc_proxy (else no_proxy) when it opens
  // a channel, each no_grpc_proxy entry a suffix of the host, with no "*". Set in process.env, they reach this process's
  // children too. A name already set is left as it is.
  if (given.includes("*")) {
    // Every host direct: nothing to install (undici takes "*" only as the whole list). gRPC gets an empty entry, which
    // is a suffix of every host, so a lowercase https_proxy it reads by itself is not used either.
    env.no_grpc_proxy ||= ",";
    return;
  }
  const own = [env.AGENTRUN_PUBLIC_URL, env.RENDER_EXTERNAL_URL].flatMap((url) => (url && URL.canParse(url) ? [new URL(url).hostname] : []));
  const direct = [...given, "localhost", "127.0.0.1", "::1", "[::1]", ...own];
  const setGlobalProxyFromEnv = (http as unknown as { setGlobalProxyFromEnv: SetGlobalProxyFromEnv }).setGlobalProxyFromEnv;
  setGlobalProxyFromEnv({ ...(https ? { HTTPS_PROXY: https } : {}), ...(plain ? { HTTP_PROXY: plain } : {}), NO_PROXY: direct.join(",") });
  env.grpc_proxy ||= https || plain;
  env.no_grpc_proxy ||= direct.map((entry) => entry.replace(/^\*\./, ".")).join(",");
}
