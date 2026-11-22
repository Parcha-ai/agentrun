// What a recipe's agent reaches beyond loopback (HARNESS.md#a-recipe): a loopback HTTP proxy that tunnels a CONNECT to
// one of the hosts a plan-billed recipe's model.hosts names and refuses everything else. harness-check runs one per check
// and lists what it saw; a server runs one per recipe for its runs, so model.hosts holds on a run as on the check.
import { createServer } from "node:http";
import { connect as netConnect, type AddressInfo, type Socket } from "node:net";

/** The proxy variables the agent is pointed at the egress proxy by, whatever the recipe sets. */
export const EGRESS_VARS = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"];
export const NO_PROXY_VARS = ["NO_PROXY", "no_proxy"];

const LOOPBACK = "127.0.0.1"; // key-gate: loopback-rule the one address the refusing egress proxy listens on

/** The variables that send the agent's requests beyond loopback to the proxy at `url`, and the hosts it reaches on this
 *  machine without it (the model proxy, MCP) around it. */
export function egressVars(url: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const name of EGRESS_VARS) vars[name] = url;
  for (const name of NO_PROXY_VARS) vars[name] = `${LOOPBACK},localhost`; // key-gate: loopback-rule the hosts the agent reaches without the refusing proxy: the model proxy and MCP on this machine
  return vars;
}

export interface EgressProxy {
  readonly url: string;
  /** What a client asked it for (harness-check's report); empty where it was started with `record` false. */
  readonly asked: { method: string; target: string; tunneled: boolean }[];
  close(): Promise<void>;
}

/** A loopback HTTP proxy that tunnels a CONNECT to one of `vendor` (a plan-billed recipe's model.hosts, `host` for port
 *  443 or `host:port`) and refuses everything else. `record`: keep what it is asked (a check's, for its report; a
 *  server's keeps nothing, so its memory never grows with its runs). `unref`: it never holds its process open. */
export async function egressProxy(vendor: readonly string[] = [], { record = true, unref = false }: { record?: boolean; unref?: boolean } = {}): Promise<EgressProxy> {
  const asked: { method: string; target: string; tunneled: boolean }[] = [];
  const note = (entry: { method: string; target: string; tunneled: boolean }) => void (record && asked.push(entry));
  const sockets = new Set<Socket>();
  const allowed = new Set(vendor.map((host) => (host.includes(":") ? host : `${host}:443`)));
  const server = createServer((req, res) => {
    // A client of a proxy names where it goes (absolute-form); a request for a path alone (origin-form) is one to this
    // port as a server, such as another process's poll of a port this proxy reused: refused, and not the agent's.
    if (!(req.url ?? "").startsWith("/")) note({ method: req.method ?? "GET", target: req.url ?? "", tunneled: false });
    res.writeHead(403).end();
  });
  server.on("connect", (req, socket: Socket, head: Buffer) => {
    const target = req.url ?? "";
    const tunneled = allowed.has(target);
    note({ method: "CONNECT", target, tunneled });
    if (!tunneled) return void socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
    const at = target.lastIndexOf(":");
    const upstream = netConnect({ host: target.slice(0, at), port: Number(target.slice(at + 1)) }, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on("close", () => (sockets.delete(upstream), socket.destroy()));
    upstream.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n"));
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });
  server.on("connection", (socket) => (sockets.add(socket), socket.on("close", () => sockets.delete(socket))));
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
  if (unref) server.unref();
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${LOOPBACK}:${port}`,
    asked,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
