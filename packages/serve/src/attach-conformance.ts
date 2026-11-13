// The attach binding's own conformance cases (spec/computer/attach.md), run against any driver that dials in: Computerd
// on a Mac, a driver on Android, Windows or Linux next, or the fake driver of serve's tests. It starts the binding's
// server half (createAttachRoutes over a store of its own in a scratch directory and an AttachHub, on a port), makes a
// pairing code, and waits for the driver to pair with it and dial. Then it acts on the socket as the server may (a ping, a
// quiet minute, a close with each code a driver must redial after, a drop, a binary frame, a frame over the limit, a
// second socket with the same token, a revoke) and checks what the driver does. Nothing here knows an OS: a driver passes
// by what it does on the wire. The next OS's driver passes these cases; the server is not tested again for it.
//
//   node dist/attach-conformance-cli.js [--port N] [--listen ADDR]
//
// prints the server address and a code to type into the driver, runs the cases once the driver has paired, prints a
// PASS or FAIL line for each, and exits 0 when every case passed. It takes about five minutes with a real driver (a
// minute of quiet, and the redials' waits as the protocol doubles them). serve's own test runs it on a shorter clock
// against the fake driver (test/attach-conformance.test.mjs).
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTACH_CLOSE, ATTACH_HEARTBEAT_MS, ATTACH_IDLE_MS, ATTACH_PATH, ATTACH_REDIAL_MAX_MS, ATTACH_SUBPROTOCOL, AttachHub, type HelloResult, MAX_LINE_BYTES, PROTOCOL_VERSION } from "@parcha/agentrun-computer";
import WebSocket from "ws";
import { createAttachRoutes } from "./computer-attach.js";
import { ApiError } from "./errors.js";
import { openSqliteStore } from "./store/index.js";

/** The most of a pairing request's body this server keeps (a code and a hello): a larger one is refused 413. */
export const PAIR_BODY_MAX = 1 << 20;

/** The cases, in the order they run: each later one needs the driver attached, and revoke ends it. */
export const ATTACH_CASES = [
  "pair",
  "wrong-or-used-code",
  "ping",
  "quiet",
  "redial-after-close",
  "redial-after-drop",
  "binary-frame",
  "oversize-frame",
  "same-token",
  "revoke",
] as const;
export type AttachCase = (typeof ATTACH_CASES)[number];
export type CaseResult = { readonly name: AttachCase; readonly ok: boolean; readonly detail: string };

export interface ConformanceOptions {
  /** The port to listen on (0: any free one) and the address (127.0.0.1 by default). */
  readonly port?: number;
  readonly host?: string;
  /** Every wait as a share of the protocol's (1, the default, for a real driver): heartbeat, idle and redial limits. */
  readonly scale?: number;
  /** How long the driver has to pair with the code (10 minutes, the code's life, by default). */
  readonly pairMs?: number;
  /** Told the server's address and the code: a person types them into the driver, or a test pairs its fake. */
  readonly pair: (address: string, code: string) => void | Promise<void>;
  /** Each line of progress. */
  readonly say?: (line: string) => void;
}

/** One socket the driver dialed, as the server sees it. */
type Dial = {
  readonly ws: WebSocket;
  readonly at: number;
  /** Set once the hub's hello on it was answered and kept. */
  hello?: HelloResult;
  /** Its close: the code and whether this run closed it (else the driver did, or it dropped). */
  closed?: { code: number; reason: string; byUs: boolean };
  /** The pings heard from the driver on it. */
  pings: number;
};

/** `ms` in seconds, to a tenth where it is under ten. */
const seconds = (ms: number): string => (ms < 10_000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000)));

class Failed extends Error {}
const fail = (why: string): never => {
  throw new Failed(why);
};

/** Runs every case against the driver that pairs with the printed code; answers each case's result. */
export async function runAttachConformance(options: ConformanceOptions): Promise<CaseResult[]> {
  const scale = options.scale ?? 1;
  const say = options.say ?? (() => {});
  const ms = (protocolMs: number) => Math.max(1, Math.round(protocolMs * scale));
  /** How long a driver may take to dial back: the protocol's longest redial, and slack for a dial and its hello. */
  const redialWithin = ms(ATTACH_REDIAL_MAX_MS + 5_000) + 2_000;
  const dir = mkdtempSync(join(tmpdir(), "attach-conformance-"));
  const store = await openSqliteStore({ dataDir: dir });
  const hub = new AttachHub();
  const dials: Dial[] = [];
  /** Every dial at the attach path, a refused one too (a revoked token is refused before any socket). */
  let attempts = 0;
  const waiters = new Set<() => void>();
  const changed = () => {
    for (const wake of [...waiters]) wake();
  };
  let paired: { computer: string; token: string; hello: HelloResult } | undefined;
  const ourCloses = new WeakSet<WebSocket>();
  const routes = createAttachRoutes({
    store,
    hub,
    timing: { heartbeatMs: ms(ATTACH_HEARTBEAT_MS), idleMs: ms(ATTACH_IDLE_MS) },
    log: (event, fields) => {
      if (event !== "computer_attached") return;
      const dial = [...dials].reverse().find((one) => one.closed === undefined);
      const hello = hub.hello(fields.computer ?? "");
      if (dial && hello) dial.hello = hello;
      changed();
    },
    onSocket: (_computer, ws) => {
      const dial: Dial = { ws, at: Date.now(), pings: 0 };
      dials.push(dial);
      ws.on("ping", () => void (dial.pings++, changed()));
      ws.on("close", (code, reason) => {
        dial.closed = { code, reason: reason.toString("utf8"), byUs: ourCloses.has(ws) };
        changed();
      });
      changed();
    },
  });

  const server = createServer((req, res) => void answer(req, res));
  async function answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/v2/computers/pair") return send(404, { error: { code: "not_found", message: "the conformance server answers POST /v2/computers/pair and the attach socket only" } });
    try {
      // Only up to PAIR_BODY_MAX bytes are kept (a code and a hello are small), the rest is read through and refused, so the
      // client gets the answer and a body of any size cannot grow this process.
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size <= PAIR_BODY_MAX) chunks.push(chunk as Buffer);
      }
      if (size > PAIR_BODY_MAX) throw new ApiError("payload_too_large", `the pairing body is over ${PAIR_BODY_MAX} bytes`);
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
      const made = await routes.pair(body, req.socket.remoteAddress ?? "unknown");
      paired = { ...made, hello: (body as { hello: HelloResult }).hello };
      changed();
      send(201, made);
    } catch (error) {
      if (error instanceof ApiError) return send(error.status, { error: { code: error.code, message: error.message, ...error.extra } });
      send(400, { error: { code: "bad_request", message: error instanceof Error ? error.message : String(error) } });
    }
  }
  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== ATTACH_PATH) return socket.destroy();
    attempts++;
    changed();
    routes.upgrade(req, socket, head, (status, words, headers = {}) => {
      if (!socket.writable) return void socket.destroy();
      const text = words ?? status;
      socket.end(`HTTP/1.1 ${status}\r\n${Object.entries({ ...headers, "content-type": "text/plain; charset=utf-8", "content-length": String(Buffer.byteLength(text)), connection: "close" }).map(([key, value]) => `${key}: ${value}\r\n`).join("")}\r\n${text}`);
    });
  });
  await new Promise<void>((done) => server.listen(options.port ?? 0, options.host ?? "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const host = options.host ?? "127.0.0.1";
  // An IPv6 address goes in brackets in a URL ("http://[::1]:7392").
  const address = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;

  /** Resolves once `ready` answers something, or fails after `within` ms saying `what`. */
  const until = <T>(ready: () => T | undefined | false, within: number, what: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const check = () => {
        const value = ready();
        if (value === undefined || value === false) return false;
        finish();
        resolve(value);
        return true;
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Failed(`${what}, within ${(within / 1000).toFixed(1)} s`));
      }, within);
      const finish = () => {
        clearTimeout(timer);
        waiters.delete(wake);
      };
      const wake = () => void check();
      waiters.add(wake);
      check();
    });
  /** No `happened` for `within` ms; fails saying `what` as soon as it does. */
  const never = (happened: () => boolean, within: number, what: () => string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(wake);
        resolve();
      }, within);
      const wake = () => {
        if (!happened()) return;
        clearTimeout(timer);
        waiters.delete(wake);
        reject(new Failed(what()));
      };
      waiters.add(wake);
      wake();
    });
  const live = (): Dial | undefined => {
    const last = dials.at(-1);
    return last && last.closed === undefined && last.hello ? last : undefined;
  };
  /** The next socket after `before` (a count of dials) whose hello was kept. */
  const redialed = (before: number, what: string) => until(() => dials.slice(before).find((dial) => dial.hello && dial.closed === undefined), redialWithin, what);
  const closeOurs = (dial: Dial, code: number, reason: string) => {
    ourCloses.add(dial.ws);
    dial.ws.close(code, reason);
  };

  const results: CaseResult[] = [];
  async function run(name: AttachCase, body: () => Promise<string>): Promise<void> {
    const prior = results.find((result) => !result.ok && result.name === "pair");
    if (prior && name !== "wrong-or-used-code") {
      results.push({ name, ok: false, detail: "not run: the driver never paired and attached" });
      return say(`FAIL ${name}: not run: the driver never paired and attached`);
    }
    try {
      const detail = await body();
      results.push({ name, ok: true, detail });
      say(`PASS ${name}: ${detail}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ name, ok: false, detail });
      say(`FAIL ${name}: ${detail}`);
    }
  }

  try {
    const pairing = await routes.createPairing();
    say(`Server address ${address}, code ${pairing.code}: type both into the driver (it has ${seconds(options.pairMs ?? 600_000)} s).`);
    await options.pair(address, pairing.code);

    await run("pair", async () => {
      await until(() => paired, options.pairMs ?? 600_000, "the driver did not pair with the code");
      const dial = await until(() => live(), ms(30_000) + 2_000, "the driver paired but did not dial the attach socket and answer hello");
      const hello = dial.hello!;
      if (dial.ws.protocol !== ATTACH_SUBPROTOCOL) fail(`it asked for ${dial.ws.protocol || "no subprotocol"}, not ${ATTACH_SUBPROTOCOL}`);
      if (hello.protocol !== PROTOCOL_VERSION) fail(`its hello says protocol ${hello.protocol}, not ${PROTOCOL_VERSION}`);
      if (hello.kind !== paired!.hello.kind || hello.os !== paired!.hello.os) fail(`it paired as ${paired!.hello.os} ${paired!.hello.kind} and its hello says ${hello.os} ${hello.kind}`);
      if (!Array.isArray(hello.groups) || hello.groups.length === 0) fail("its hello offers no groups");
      return `paired and attached as ${hello.os} ${hello.kind} (driver ${hello.version}), offering ${hello.groups.join(", ")}`;
    });

    await run("wrong-or-used-code", async () => {
      const tries = [{ what: "a wrong code", code: "ZZZZ-ZZZZ" }, { what: "the used code", code: pairing.code }];
      for (const { what, code } of tries) {
        const res = await fetch(`${address}/v2/computers/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "another", hello: paired?.hello ?? {} }) });
        if (res.status !== 404) fail(`${what} answered ${res.status}, not 404`);
      }
      return "a wrong code and a used code are each refused 404, with nothing said of which";
    });

    await run("ping", async () => {
      const dial = live() ?? fail("no live socket");
      const pong = new Promise<void>((done) => dial.ws.once("pong", () => done()));
      dial.ws.ping();
      await Promise.race([pong, new Promise((_, reject) => setTimeout(() => reject(new Failed("it did not answer a ping")), ms(5_000) + 1_000))]);
      const before = dial.pings;
      await until(() => dial.pings > before || dial.closed !== undefined, ms(ATTACH_HEARTBEAT_MS + 5_000) + 1_000, `it sent no ping of its own in ${ATTACH_HEARTBEAT_MS / 1000} s`);
      if (dial.closed) fail(`its socket closed (${dial.closed.code}) while waiting for its ping`);
      return "it answers a ping, and pings every heartbeat itself";
    });

    await run("quiet", async () => {
      const dial = live() ?? fail("no live socket");
      await never(() => dial.closed !== undefined, ms(ATTACH_IDLE_MS + 10_000), () => `its socket closed with ${dial.closed?.code} during a quiet spell`);
      return `with no calls for ${seconds(ms(ATTACH_IDLE_MS + 10_000))} s its socket stays up: its pongs and pings keep it`;
    });

    await run("redial-after-close", async () => {
      const codes = [ATTACH_CLOSE.idle, ATTACH_CLOSE.normal, ATTACH_CLOSE.going, ATTACH_CLOSE.replaced];
      for (const code of codes) {
        const dial = live() ?? fail("no live socket");
        const before = dials.length;
        closeOurs(dial, code, `conformance: a close with ${code}`);
        await redialed(before, `it did not dial back after a close with ${code}`);
      }
      return `it dials back after a close with ${codes.join(", ")}`;
    });

    await run("redial-after-drop", async () => {
      const dial = live() ?? fail("no live socket");
      const before = dials.length;
      ourCloses.add(dial.ws);
      dial.ws.terminate();
      await redialed(before, "it did not dial back after a drop with no close frame");
      return "it dials back after a drop";
    });

    for (const [name, frame, code] of [["binary-frame", Buffer.from([0x7b, 0x7d]), ATTACH_CLOSE.binary], ["oversize-frame", "x".repeat(MAX_LINE_BYTES + 1), ATTACH_CLOSE.tooBig]] as const) {
      await run(name, async () => {
        const dial = live() ?? fail("no live socket");
        const before = dials.length;
        dial.ws.send(frame, { binary: typeof frame !== "string" });
        await until(() => dial.closed, ms(5_000) + 2_000, `it did not close its socket on ${name === "binary-frame" ? "a binary frame" : "a frame over the limit"}`);
        if (dial.closed!.code !== code) fail(`it closed with ${dial.closed!.code}, not ${code}`);
        await redialed(before, `it did not dial back after closing with ${code}`);
        return `it closes with ${code}, then dials back`;
      });
    }

    await run("same-token", async () => {
      const dial = live() ?? fail("no live socket");
      const hello = dial.hello!;
      const before = dials.length;
      // This run dials as a second driver with the same token and answers hello as the driver did.
      const twin = new WebSocket(`${address.replace(/^http/, "ws")}${ATTACH_PATH}`, ATTACH_SUBPROTOCOL, { headers: { authorization: `Bearer ${paired!.token}` } });
      twin.on("error", () => undefined);
      let twinClosed: number | undefined;
      twin.on("close", (code) => void ((twinClosed = code), changed()));
      twin.on("message", (data) => {
        const message = JSON.parse(String(data)) as { id?: number; method?: string };
        if (message.method === "hello" && message.id !== undefined) twin.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: hello }));
      });
      await until(() => dial.closed, redialWithin, "the driver's socket was not closed when a second socket with its token went live");
      if (dial.closed!.code !== ATTACH_CLOSE.replaced) fail(`the driver's socket closed with ${dial.closed!.code}, not ${ATTACH_CLOSE.replaced}`);
      // The driver dials back (4409 is redialed) and its new socket replaces the twin's.
      await until(() => dials.slice(before + 1).find((one) => one.hello && one.closed === undefined), redialWithin, "the driver did not dial back after 4409");
      await until(() => twinClosed, ms(5_000) + 2_000, "the second socket was not closed when the driver dialed back");
      if (twinClosed !== ATTACH_CLOSE.replaced) fail(`the second socket closed with ${twinClosed}, not ${ATTACH_CLOSE.replaced}`);
      return "a second socket with its token closes its socket with 4409; it dials back, and its new socket replaces the second";
    });

    await run("revoke", async () => {
      const dial = live() ?? fail("no live socket");
      await routes.remove(paired!.computer);
      await until(() => dial.closed, ms(5_000) + 2_000, "its socket was not closed when it was removed");
      if (dial.closed!.code !== ATTACH_CLOSE.unauthorized) fail(`its socket closed with ${dial.closed!.code}, not ${ATTACH_CLOSE.unauthorized}`);
      const before = attempts;
      // As long as a redial may wait: a driver that wrongly dials after 4401 does so within it, however far the cases
      // before this one drove its delay.
      const quiet = redialWithin;
      await never(() => attempts > before, quiet, () => "it dialed again after 4401, which needs the person to pair it again");
      return `removed, its socket closes with 4401 and it does not dial again in ${seconds(quiet)} s`;
    });
  } finally {
    await routes.close();
    // closeAllConnections right after close starts: a pairing request left unfinished would hold the close callback.
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

