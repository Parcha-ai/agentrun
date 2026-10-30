// A box's egress proxy, written for AgentRun: the one way out of a box whose network namespace has only its own loopback.
// It listens on a Unix socket (0600) in the run's directory, bound into the box, and speaks HTTP CONNECT, plain HTTP
// forwarding and SOCKS5 CONNECT (told apart by the first byte), each to the public internet only (egress-table.ts):
//  - a host is resolved once, every address in the answer is checked, and the connection goes to exactly the address
//    that was checked, so a name cannot point elsewhere between the check and the dial; an IP literal is checked the
//    same way, by its bytes, whatever form the client wrote it in;
//  - a refusal is an answer, sent before any socket opens: 403 (or SOCKS reply 2) with the class in its reason;
//  - plain HTTP goes to the request URI's host, and a Host header that names another host is refused (400);
//  - a redirect is never followed here: it reaches the client as the origin sent it, and the client's next request is
//    one more request through this proxy, checked the same way;
//  - SOCKS5 BIND and UDP ASSOCIATE are refused by name, and so is an HTTP upgrade;
//  - a run has a cap on connections open at once and a budget of connections in all, each refused by name;
//  - a log line holds the host, the port, the address and the class, never a path, a query, a header or a body.
// It holds no key. `close()` ends every connection and removes the socket.
import { randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { chmod, link, lstat, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect, createServer, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { addressBytes, checkAddress } from "./egress-table.js";

/** `dns.lookup` with `{ all: true }`: every address a name resolves to. */
export type EgressLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void
) => void;

export interface EgressProxyOptions {
  /** Where the socket is made: a path in the run's directory. A socket there that refuses a connection (its proxy died
   *  without removing it) is replaced; one that answers is a live proxy's, and the start is refused
   *  (`egress_socket_in_use`); anything else there is refused and left as it is (`egress_socket_path_taken`). */
  socketPath: string;
  /** Connections open at once (tunnels and forwarded requests), past which a new one is refused. */
  maxTunnels: number;
  /** Connections in all, for the proxy's life, past which a new one is refused. */
  maxConnections: number;
  /** One line per decision: the host, the port, the address and the class. */
  log: (line: string) => void;
  /** How a name is resolved (a test's seam). Default: `dns.lookup`. */
  lookup?: EgressLookup;
  /** How a connection is opened to an address the table passed, in its canonical text (a test's seam). Default:
   *  `net.connect`. Only an address that was checked ever reaches it. */
  dial?: (address: string, port: number) => Socket;
  /** More addresses to refuse as this host's, beside the interfaces read at each dial (a test's seam: it can only refuse
   *  more). */
  alsoLocal?: () => readonly string[];
}

export interface EgressProxy {
  readonly socketPath: string;
  close(): Promise<void>;
}

/** Why a connection was not made, besides an address class. */
type Refusal = { status: number; reason: string; socks: number };

const HOP = new Set(["connection", "proxy-connection", "keep-alive", "proxy-authorization", "proxy-authenticate", "te", "trailer", "upgrade", "transfer-encoding"]);

/** The canonical text of an address's bytes: what is dialled. */
function addressText(bytes: Uint8Array): string {
  if (bytes.length === 4) return [...bytes].join(".");
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  return groups.join(":");
}

const hostOf = (text: string) => JSON.stringify(text.slice(0, 255));

export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const { socketPath, maxTunnels, maxConnections, log } = options;
  const lookup: EgressLookup = options.lookup ?? ((hostname, opts, callback) => dnsLookup(hostname, opts, callback));
  const dial = options.dial ?? ((address: string, port: number) => netConnect({ host: address, port }));
  const sockets = new Set<Duplex>();
  let open = 0;
  let used = 0;
  let closed = false;

  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    if (closed) socket.destroy();
  };

  /** The host's addresses at this moment: every interface's, and the seam's. */
  const local = (): string[] => [
    ...Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((entry) => entry.address)),
    ...(options.alsoLocal?.() ?? []),
  ];

  /** Resolves `host` once and checks every answer: the address to dial, or the refusal. */
  const resolve = async (host: string): Promise<{ address: string } | { refused: Refusal; address?: string }> => {
    const literal = addressBytes(host);
    let answers: Uint8Array[];
    if (literal) answers = [literal];
    else {
      if (!/^[A-Za-z0-9._-]+$/.test(host) || host.length > 253) return { refused: { status: 400, reason: "invalid host", socks: 4 } };
      try {
        const found = await new Promise<{ address: string }[]>((ok, fail) => lookup(host, { all: true, verbatim: true }, (error, list) => (error ? fail(error) : ok(list))));
        answers = found.map((entry) => addressBytes(entry.address)).filter((bytes): bytes is Uint8Array => bytes !== undefined);
      } catch {
        return { refused: { status: 502, reason: "name not resolved", socks: 4 } };
      }
      if (answers.length === 0) return { refused: { status: 502, reason: "name not resolved", socks: 4 } };
    }
    const here = local();
    for (const bytes of answers) {
      const verdict = checkAddress(bytes, here);
      if (!verdict.ok) return { refused: { status: 403, reason: verdict.class, socks: 2 }, address: addressText(bytes) };
    }
    return { address: addressText(answers[0]!) };
  };

  /** A connection may open now: the cap and the budget. Takes a slot; `release` gives it back. */
  const admit = (): Refusal | undefined => {
    if (open >= maxTunnels) return { status: 429, reason: "tunnel cap", socks: 2 };
    if (used >= maxConnections) return { status: 429, reason: "connection budget", socks: 2 };
    open++;
    used++;
    return undefined;
  };

  /** Resolve, check, admit and dial: the upstream socket once it connects, or the refusal. */
  const reach = async (kind: string, host: string, port: number): Promise<{ socket: Socket; address: string } | { refused: Refusal }> => {
    const target = await resolve(host);
    if ("refused" in target) {
      log(`egress ${kind} host=${hostOf(host)} port=${port} ip=${target.address ?? "-"} class=${target.refused.reason}`);
      return target;
    }
    const full = admit();
    if (full) {
      log(`egress ${kind} host=${hostOf(host)} port=${port} ip=${target.address} class=${full.reason}`);
      return { refused: full };
    }
    log(`egress ${kind} host=${hostOf(host)} port=${port} ip=${target.address} class=ok`);
    const upstream = dial(target.address, port);
    track(upstream);
    upstream.once("close", () => open--);
    return await new Promise((ok) => {
      upstream.once("connect", () => ok({ socket: upstream, address: target.address }));
      upstream.once("error", () => ok({ refused: { status: 502, reason: "dial failed", socks: 5 } }));
    });
  };

  // HTTP: CONNECT, and plain requests in absolute form.
  const http = createHttpServer();
  const refuseRaw = (socket: Duplex, refusal: Refusal) => {
    const body = `egress refused: ${refusal.reason}\n`;
    socket.end(`HTTP/1.1 ${refusal.status} Egress refused: ${refusal.reason}\r\nx-egress-refused: ${refusal.reason}\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
  };
  const refuse = (res: ServerResponse, refusal: Refusal) => {
    const body = `egress refused: ${refusal.reason}\n`;
    res.writeHead(refusal.status, `Egress refused: ${refusal.reason}`, { "x-egress-refused": refusal.reason, "content-type": "text/plain", "content-length": Buffer.byteLength(body), connection: "close" });
    res.end(body);
  };

  http.on("connect", (req: IncomingMessage, client: Duplex, head: Buffer) => {
    void (async () => {
      const target = /^\[([0-9A-Fa-f:.%a-zA-Z]+)\]:(\d{1,5})$/.exec(req.url ?? "") ?? /^([^:[\]/@\s]+):(\d{1,5})$/.exec(req.url ?? "");
      const port = Number(target?.[2]);
      if (!target || !(port >= 1 && port <= 65535)) return refuseRaw(client, { status: 400, reason: "invalid target", socks: 1 });
      const reached = await reach("connect", target[1]!, port);
      if ("refused" in reached) return refuseRaw(client, reached.refused);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) reached.socket.write(head);
      reached.socket.pipe(client).pipe(reached.socket);
      reached.socket.on("error", () => client.destroy());
      client.on("error", () => reached.socket.destroy());
      reached.socket.on("close", () => client.destroy());
      client.on("close", () => reached.socket.destroy());
    })();
  });

  http.on("upgrade", (_req: IncomingMessage, client: Duplex) => refuseRaw(client, { status: 400, reason: "upgrade not supported", socks: 7 }));

  http.on("request", (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let url: URL;
      try {
        url = new URL(req.url ?? "");
      } catch {
        return refuse(res, { status: 400, reason: "not an absolute URI", socks: 1 });
      }
      if (url.protocol !== "http:") return refuse(res, { status: 400, reason: "not an http URI", socks: 1 });
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const port = url.port === "" ? 80 : Number(url.port);
      if (req.headers.host !== undefined) {
        let named: URL | undefined;
        try {
          named = new URL(`http://${req.headers.host}`);
        } catch {}
        if (!named || named.hostname !== url.hostname || (named.port === "" ? 80 : Number(named.port)) !== port) {
          log(`egress http host=${hostOf(host)} port=${port} ip=- class=host mismatch`);
          return refuse(res, { status: 400, reason: "host mismatch", socks: 1 });
        }
      }
      const reached = await reach("http", host, port);
      if ("refused" in reached) return refuse(res, reached.refused);
      const headers: IncomingHttpHeaders = {};
      for (const [name, value] of Object.entries(req.headers)) if (!HOP.has(name)) headers[name] = value;
      headers.host = url.host;
      headers.connection = "close";
      // The request goes over the socket already dialled to the checked address. Its host and port name that address too,
      // so nothing else is reached even if the socket were not used (with `agent: false`, Node ignores createConnection
      // and dials host and port itself).
      const upstream = httpRequest({ host: reached.address, port, method: req.method, path: `${url.pathname}${url.search}`, headers, createConnection: () => reached.socket });
      upstream.on("response", (answer) => {
        const out: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(answer.headers)) if (!HOP.has(name) && value !== undefined) out[name] = value;
        res.writeHead(answer.statusCode ?? 502, answer.statusMessage, out);
        answer.pipe(res);
      });
      upstream.on("error", () => (res.headersSent ? res.destroy() : refuse(res, { status: 502, reason: "upstream failed", socks: 1 })));
      req.pipe(upstream);
      res.on("close", () => reached.socket.destroy());
    })();
  });

  // SOCKS5: a greeting offering "no authentication", then one CONNECT.
  const socks = (client: Socket) => {
    let buffer = Buffer.alloc(0);
    let stage: "greet" | "request" | "done" = "greet";
    const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 1024) return client.destroy();
      if (stage === "greet") {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return;
        const methods = buffer.subarray(2, 2 + buffer[1]!);
        buffer = buffer.subarray(2 + buffer[1]!);
        if (!methods.includes(0)) return client.end(Buffer.from([5, 0xff]));
        client.write(Buffer.from([5, 0]));
        stage = "request";
      }
      if (stage !== "request" || buffer.length < 5) return;
      const [version, command, , type] = buffer;
      if (version !== 5) return client.destroy();
      const length = type === 1 ? 4 : type === 4 ? 16 : type === 3 ? 1 + buffer[4]! : -1;
      if (length < 0) return client.end(reply(8));
      if (buffer.length < 4 + length + 2) return;
      stage = "done";
      client.off("data", onData);
      client.setTimeout(0);
      const raw = buffer.subarray(4, 4 + length);
      const host = type === 3 ? raw.subarray(1).toString("latin1") : addressText(raw);
      const port = buffer.readUInt16BE(4 + length);
      const rest = buffer.subarray(4 + length + 2);
      if (command !== 1) {
        const name = command === 2 ? "socks bind" : command === 3 ? "socks udp associate" : "socks command";
        log(`egress socks host=${hostOf(host)} port=${port} ip=- class=${name}`);
        return client.end(reply(7));
      }
      void (async () => {
        const reached = await reach("socks", host, port);
        if ("refused" in reached) return client.end(reply(reached.refused.socks));
        client.write(reply(0));
        if (rest.length) reached.socket.write(rest);
        reached.socket.pipe(client).pipe(reached.socket);
        reached.socket.on("error", () => client.destroy());
        client.on("error", () => reached.socket.destroy());
        reached.socket.on("close", () => client.destroy());
        client.on("close", () => reached.socket.destroy());
      })();
    };
    client.on("data", onData);
  };

  const server: Server = createServer((client) => {
    track(client);
    client.on("error", () => client.destroy());
    client.setTimeout(30_000, () => client.destroy());
    client.once("data", (first: Buffer) => {
      client.pause();
      client.unshift(first);
      if (first[0] === 5) {
        socks(client);
        client.resume();
      } else {
        client.setTimeout(0);
        http.emit("connection", client);
        client.resume();
      }
    });
  });

  // A socket already at the path belongs to another proxy while it answers, and is never taken from it. Only one that
  // refuses a connection is removed; anything that is not a socket is left where it is.
  const taken = (code: string, what: string) => Object.assign(new Error(`egress proxy: ${socketPath} ${what}`), { code });
  let found: Stats | undefined;
  try {
    found = await lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (found) {
    if (!found.isSocket()) throw taken("egress_socket_path_taken", "exists and is not a socket");
    const answer = await new Promise<true | NodeJS.ErrnoException>((ok) => {
      const probe = netConnect(socketPath);
      probe.once("connect", () => {
        probe.destroy();
        ok(true);
      });
      probe.once("error", (error: NodeJS.ErrnoException) => ok(error));
    });
    if (answer === true) throw taken("egress_socket_in_use", "is a live egress proxy's socket");
    if (answer.code !== "ECONNREFUSED") throw answer;
    await unlink(socketPath);
  }
  // Made under a name of its own and made 0600 before it gets its path, so it is never reachable there with a wider
  // mode. The path is a hard link, never a rename: a link fails if anything reached the path since the check above,
  // where a rename would replace it.
  const making = join(dirname(socketPath), `.egress-${randomBytes(6).toString("hex")}.sock`);
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(making, () => {
      server.off("error", fail);
      ok();
    });
  });
  try {
    await chmod(making, 0o600);
    await link(making, socketPath);
  } catch (error) {
    server.close();
    await unlink(making).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw taken("egress_socket_in_use", "was taken while this proxy started");
    throw error;
  }
  await unlink(making).catch(() => {});

  return {
    socketPath,
    async close() {
      if (closed) return;
      closed = true;
      const done = new Promise<void>((ok) => server.close(() => ok()));
      for (const socket of sockets) socket.destroy();
      http.close();
      await done;
      await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}
