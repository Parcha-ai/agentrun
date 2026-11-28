// Node's fetch without the transport's own bounds: undici gives up on a request after 5 minutes with no headers, or with
// no piece of its body, as "terminated: Body Timeout Error", which every model client asks again on. A hop whose wait
// a session's model proxy bounds itself (its stallMs: 30 minutes for a model on the host's own machine) goes through
// one of these, so the proxy's bound is the one that ends a silent request, in its words.
import { Agent, type Dispatcher, EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

/** Node's fetch through a dispatcher with no headers or body timeout, made at the first request and kept for the next.
 *  `proxied`: the environment's proxy settings hold (HTTP_PROXY, NO_PROXY), as for Node's own fetch; otherwise a direct
 *  connection, for a session proxy on this host. */
export function uncutFetch(proxied: boolean): typeof fetch {
  let pool: Dispatcher | undefined;
  const dispatcher = () => (pool ??= proxied ? new EnvHttpProxyAgent({ headersTimeout: 0, bodyTimeout: 0 }) : new Agent({ headersTimeout: 0, bodyTimeout: 0 }));
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => undiciFetch(input as never, { ...(init as object), dispatcher: dispatcher() } as never)) as unknown as typeof fetch;
}

/** How much longer than a proxy's own bound a client waits for its headers (the client's `timeoutMs`): the proxy has
 *  answered by then, in words, so the client's own cut never comes first. */
export const HEADERS_GRACE_MS = 60_000;
