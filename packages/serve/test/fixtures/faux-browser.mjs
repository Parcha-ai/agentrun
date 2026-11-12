// The `browser` tool's sessions and driver for the tests: a browser computer provider (the computer protocol's shape,
// as computer/src/browserbase.ts and kernel.ts give it, which serve's browser-computer.ts drives) over pi-browser's fake
// backend, with one page and no network or key, and the backend's driver. Each call it answers is appended to
// $FAUX_BROWSER_LOG, so a test reads what the run's process did; its first line says whether the Browserbase variables
// reached it in the env the real provider gets (never their values), its second which vendor the run's browser is
// (`browserbase`, `kernel`, or why it is unavailable) and whether Kernel's key reached it. The page names the vendor too,
// so the run's answer says which browser it got. Kernel's provider keeps no downloads, and neither does this one when the
// vendor is Kernel. Its provider is named for the vendor, so the run prices its session time as that vendor's, or
// $FAUX_BROWSER_PROVIDER's. A run handed its agent's saved sign-in gets a line naming it, and whether that ref is anywhere
// in its environment (process.env, the env the provider gets with its hidden properties, and the environment the kernel
// shows); each session that opens on a saved sign-in logs the vendor's object it opens on (`pointer`) and whether it saves.
// Its driver dials whichever of this process's fake backends the CDP URL names, so a test whose agent's computer is a
// browser can hand the claim a provider of this module's own and have the run's driver drive the sessions it made.
//
// A session's DevTools address (what the live view streams from) is a fake DevTools endpoint of this module's own, on
// loopback in the run's process, never the backend's sentinel vendor address: it has one page, and sends one screencast
// frame (FRAME, bytes no image decoder needs) once the page's screencast starts. It is started at the first connect. Each
// Input command it gets (the person's input, through the live view) is logged by its name alone.
//
// With $FAUX_BROWSER_STATE (a file), the backend's sessions outlive the run's process, as a vendor's do: each one created
// or released is written there, and a process that starts finds the ones still running.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { FakeBackend, fakeDriver, fixturePage } from "@parcha/pi-browser/testing";

/** The screencast frame the fake DevTools endpoint sends: its bytes, and the page's size it reports. */
export const FRAME = { bytes: Buffer.from("faux-live-view-frame"), w: 1280, h: 800 };

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const encode = (text) => {
  const payload = Buffer.from(text);
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : Buffer.from([0x81, 126, n >> 8, n & 255]);
  return Buffer.concat([head, payload]);
};
/** Masked client text frames out of a growing buffer; a close frame calls `onClose`. */
const decoder = (onText, onClose = () => {}) => {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      let length = buffer[1] & 127;
      let at = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); at = 4; }
      const masked = (buffer[1] & 128) !== 0;
      if (buffer.length < at + (masked ? 4 : 0) + length) return;
      const mask = masked ? buffer.subarray(at, at + 4) : null;
      at += masked ? 4 : 0;
      const body = Buffer.from(buffer.subarray(at, at + length));
      if (mask) for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i % 4];
      const opcode = buffer[0] & 15;
      buffer = buffer.subarray(at + length);
      if (opcode === 1) onText(body.toString("utf8"));
      else if (opcode === 8) return onClose();
    }
  };
};

let devtools;
/** The fake DevTools endpoint's address, started once. */
const devtoolsUrl = () => (devtools ??= new Promise((resolve) => {
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}${GUID}`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("error", () => {});
    const send = (message) => { if (!socket.destroyed) socket.write(encode(JSON.stringify(message))); };
    const page = { targetId: "PAGE1", type: "page", title: "Example", url: "https://example.test/", attached: false };
    socket.on("data", decoder((text) => {
      const { id, method, sessionId } = JSON.parse(text);
      // What the person's input became, for a test to read: the command's name alone, never its text.
      if (method.startsWith("Input.") && process.env.FAUX_BROWSER_LOG) appendFileSync(process.env.FAUX_BROWSER_LOG, `${JSON.stringify({ op: "devtools", method })}\n`);
      send({ id, ...(sessionId ? { sessionId } : {}), result: {} });
      if (method === "Target.setDiscoverTargets") send({ method: "Target.targetCreated", params: { targetInfo: page } });
      else if (method === "Target.attachToTarget") send({ method: "Target.attachedToTarget", params: { sessionId: "FLAT1", targetInfo: page, waitingForDebugger: false } });
      else if (method === "Page.startScreencast") send({ method: "Page.screencastFrame", sessionId: "FLAT1", params: { data: FRAME.bytes.toString("base64"), metadata: { deviceWidth: FRAME.w, deviceHeight: FRAME.h }, sessionId: 1 } });
    }, () => {
      // The client's close (the live view's stream closed at a session's release): answered and ended, as a browser's
      // DevTools endpoint does, so no half-closed socket outlives it. The runner runs in a test's own process.
      if (!socket.destroyed) socket.end(Buffer.from([0x88, 0x00]));
    }));
  });
  server.listen(0, "127.0.0.1", () => {
    server.unref();
    resolve(`ws://127.0.0.1:${server.address().port}/devtools/browser/faux`);
  });
}));

/** Every backend this process made, by its number: a CDP URL names its backend, so the driver of one call dials a session
 *  another call's provider made (the agent's browser computer, made from its saved keys, and the run's faux driver). */
const backends = new Map();

export default function browser(env = process.env, vendor = "browserbase", signIn = undefined) {
  const log = process.env.FAUX_BROWSER_LOG;
  const seen = (name) => (env[name] ? "set" : "unset");
  if (log) appendFileSync(log, `${JSON.stringify({ op: "env", BROWSERBASE_API_KEY: seen("BROWSERBASE_API_KEY"), BROWSERBASE_PROJECT_ID: seen("BROWSERBASE_PROJECT_ID") })}\n`);
  if (log) appendFileSync(log, `${JSON.stringify({ op: "vendor", vendor, KERNEL_API_KEY: seen("KERNEL_API_KEY") })}\n`);
  if (log && signIn) {
    const values = (object) => Object.getOwnPropertyNames(object).map((name) => String(object[name]));
    const kernelEnv = (() => { try { return readFileSync("/proc/self/environ", "utf8"); } catch { return ""; } })();
    const inEnv = [...values(process.env), ...values(env), kernelEnv].some((value) => value.includes(signIn.ref));
    appendFileSync(log, `${JSON.stringify({ op: "sign-in", provider: signIn.provider, ref: signIn.ref, save: signIn.save, ref_in_env: inEnv })}\n`);
  }
  // A run's process that dies naming its sign-in's pointer in its last log line (what a run's failure message is made of).
  if (signIn && process.env.FAUX_BROWSER_DIE_WITH_REF) {
    process.stderr.write(`the browser died holding ${signIn.ref}\n`);
    process.exit(3);
  }
  const start = "https://example.test/";
  // Tests of the run's cut: FAUX_BROWSER_PAGE_ECHO names a variable of the provider's env whose value the page shows (a page
  // that echoes a key the run holds), and FAUX_BROWSER_CREATE_401_ECHO one a vendor's 401 on create echoes.
  const echoed = (name) => (name ? String(env[name] ?? "") : "");
  const pageEcho = echoed(process.env.FAUX_BROWSER_PAGE_ECHO);
  const backend = new FakeBackend({ name: process.env.FAUX_BROWSER_PROVIDER || vendor, start, caps: { profiles: true }, pages: { [start]: fixturePage(start, `The answer is forty-two. This browser is ${vendor}'s.${pageEcho ? ` The page shows ${pageEcho} here.` : ""}`, "Example") }, ...(log ? { logFile: log } : {}) });
  const number = String(backends.size + 1);
  backends.set(number, backend);
  // The vendor's sessions as the last process left them.
  const stateFile = process.env.FAUX_BROWSER_STATE;
  const saved = stateFile ? (() => { try { return JSON.parse(readFileSync(stateFile, "utf8")); } catch { return []; } })() : [];
  for (const { id, tag, url } of saved) backend.sessions.set(id, { id, tag, metadata: {}, state: "running", url, broker: false, plane: "default" });
  const save = () => { if (stateFile) writeFileSync(stateFile, JSON.stringify(backend.live().map(({ id, tag }) => ({ id, tag, url: backend.sessions.get(id)?.url ?? start })))); };
  const fake = backend.provider;
  const keeps = vendor !== "kernel";
  const id = process.env.FAUX_BROWSER_PROVIDER || vendor;
  // The label a session's custody tag rides on, as the claim's browser writes it (workspace/computer-for-claim.ts).
  const TAG = "agentrun.session";
  const ok = (value) => ({ ok: true, value });
  const fail = (code, message) => ({ ok: false, error: { code, message } });
  /** A fake vendor's failure as the computer protocol answers it: its code by status, its words as they are. */
  const failed = (error) => {
    const status = error?.status;
    return fail(status === 401 || status === 403 ? "denied" : status === 404 ? "not_found" : "unreachable", error instanceof Error ? error.message : String(error));
  };
  const refOf = (sessionId) => ({ id: sessionId, tag: backend.sessions.get(sessionId)?.tag ?? "" });
  const hello = { version: "0.0.0-faux", os: "linux", kind: "browser", arch: "unknown", groups: ["cdp", "stream", ...(keeps ? ["downloads"] : [])] };
  const computer = {
    id,
    version: "0.0.0-faux",
    capabilities: () => ({
      kind: "browser", lifetime: "vendor", network: ["open"], isolation: "vm", os: "linux", daemon: "none", groups: [...hello.groups], maxLifetimeMs: 6 * 3_600_000, release: ["delete"],
      browser: { timeout: "wall-clock", stealth: true, profiles: { settleMs: 0 }, ...(keeps ? { downloads: { path: "downloads" } } : { headless: true }) },
    }),
    check: () => [],
    async create(spec, { signal } = {}) {
      const browser = spec.browser ?? {};
      const tag = spec.labels?.[TAG] ?? "";
      const profile = browser.profile;
      if (log && profile) appendFileSync(log, `${JSON.stringify({ op: "profile", pointer: profile.pointer, save: profile.save })}\n`);
      // A saving session refused in words a vendor's refusal might use, which name the vendor's object (Kernel's name is
      // the run's pointer).
      if (signIn && profile?.save && process.env.FAUX_BROWSER_REFUSE_WITH_REF) return fail("refused", `browser profile "${signIn.ref}": one session at a time may save to a profile, and another session is saving to it now. Wait for it to end, or start without saving. No session was started.`);
      if (process.env.FAUX_BROWSER_CREATE_401_ECHO) return fail("denied", `401 Unauthorized: the API key ${echoed(process.env.FAUX_BROWSER_CREATE_401_ECHO)} is not valid for this project`);
      try {
        const made = await fake.create({ tag, maxLifetimeS: spec.lifetimeMs / 1000, idleTimeoutS: 0, proxies: false, verified: browser.stealth === true, captcha: false, viewport: browser.viewport ?? { width: 1288, height: 711 }, metadata: {}, ...(profile ? { profile: { name: profile.pointer, save: profile.save } } : {}) }, signal ?? new AbortController().signal);
        save();
        return ok({ id: made.id, name: made.id });
      } catch (error) {
        return failed(error);
      }
    },
    async attach(ref) {
      const found = backend.sessions.get(ref.id);
      if (!found) return fail("not_found", `no faux browser ${ref.id}`);
      if (found.state !== "running") return fail("gone", `the faux browser ${ref.id} has ended`);
      return ok({ id: ref.id, name: ref.id, spec: { image: "chromium", user: "unknown", network: "open", kind: "browser" } });
    },
    async list(labels) {
      try {
        const refs = await fake.findByTag(labels[TAG] ?? "");
        return ok(refs.map((ref) => ({ ref: { id: ref.id, name: ref.id }, labels: { [TAG]: ref.tag }, state: "running", network: "open" })));
      } catch (error) {
        return failed(error);
      }
    },
    async network() { return ok("open"); },
    async connect(ref) {
      try {
        const target = await fake.attach(refOf(ref.id));
        // The session's id stays in the address's query, where the fake driver reads it, beside its backend's number.
        const sessionId = new URL(target.sdkCdpUrl).searchParams.get("sessionId") ?? "";
        const client = { call: async () => ok(hello), close() {} };
        return ok({ client, hello, cdp: { url: `${await devtoolsUrl()}?sessionId=${encodeURIComponent(sessionId)}&backend=${number}` }, close: async () => {} });
      } catch (error) {
        return failed(error);
      }
    },
    async release(ref) {
      try {
        await fake.release(refOf(ref.id));
        return ok(undefined);
      } catch (error) {
        return failed(error);
      } finally {
        save();
      }
    },
    profiles: { create: async () => ok(`faux-profile-${Date.now().toString(16)}`), remove: async () => ok(undefined) },
    ...(keeps ? {
      downloads: {
        list: async (ref) => { try { return ok(await fake.downloads.list(refOf(ref.id))); } catch (error) { return failed(error); } },
        read: async (ref, name, maxBytes) => { try { return ok(await fake.downloads.read(refOf(ref.id), name, maxBytes)); } catch (error) { return failed(error); } },
      },
    } : {}),
  };
  // The driver dials the backend the URL names: this call's, or another call's whose provider made the session.
  const driver = async (target, ...rest) => {
    let named;
    try {
      named = backends.get(new URL(target.sdkCdpUrl).searchParams.get("backend") ?? "");
    } catch {
      named = undefined;
    }
    return fakeDriver(named ?? backend)(target, ...rest);
  };
  return { computer, driver };
}
