// A Browser computer at its claim through the providers' own path (computer-for-claim.ts providerLaunch), with no
// launch of the server's own: the claim's computer is a CDP connect that asks the provider's connect and dials the URL
// it hands over. Before, every such claim was refused ("it gave no CDP connection"), since only a test's launch gave a
// connect. Each provider is a stand-in in the computer module's shape whose connect hands over a ws URL of a loopback
// DevTools endpoint; Browserbase and Kernel take the one path.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readBackOf } from "@parcha/agentrun-computer";
import { putSealedKey } from "../dist/server-keys.js";
import { computerForClaim, localWorkspace } from "../dist/workspace/index.js";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const dirs = [];
const servers = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  for (const server of servers) server.close();
});

/** A loopback DevTools endpoint: each CDP command is answered with its method and the path the socket was opened on. */
async function devtools() {
  const server = createServer((_, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 6) {
        const op = buffer[0] & 0x0f;
        let length = buffer[1] & 0x7f;
        let at = 2;
        if (length === 126) { length = buffer.readUInt16BE(2); at = 4; }
        if (buffer.length < at + 4 + length) return;
        const mask = buffer.subarray(at, at + 4);
        const payload = Buffer.from(buffer.subarray(at + 4, at + 4 + length).map((byte, i) => byte ^ mask[i % 4]));
        buffer = buffer.subarray(at + 4 + length);
        if (op === 8) { socket.end(); return; }
        const { id, method } = JSON.parse(payload.toString("utf8"));
        const out = Buffer.from(JSON.stringify({ id, result: { method, path: req.url } }));
        socket.write(Buffer.concat([out.length < 126 ? Buffer.from([0x81, out.length]) : Buffer.from([0x81, 126, out.length >> 8, out.length & 255]), out]));
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `ws://127.0.0.1:${server.address().port}`;
}

/** A browser provider in the computer module's shape: its connect hands over `url` as its CDP target, as Browserbase's
 *  and Kernel's do (their signed URL), and dials nothing itself. */
function browserProvider(id, url, record) {
  return {
    id,
    version: "0",
    capabilities: () => ({ lifetime: "vendor", maxLifetimeMs: 3_600_000, network: ["open"], groups: ["cdp"] }),
    check: () => [],
    list: async () => ({ ok: true, value: [] }),
    async create(spec) {
      record.created.push(spec.labels);
      return { ok: true, value: { id: `${id}-1`, name: `${id}-1` } };
    },
    async connect(ref) {
      record.connects += 1;
      return { ok: true, value: { client: { close() {} }, hello: { version: "0", kind: "browser", groups: ["cdp"] }, cdp: { url }, close: async () => {} } };
    },
    async attach() {
      return { ok: false, error: { code: "unsupported", message: "nothing is mounted in this computer" } };
    },
    async release(ref, how) {
      record.released.push([ref.id, how]);
      return { ok: true, value: undefined };
    },
  };
}

for (const [provider, keys] of [
  ["browserbase", { BROWSERBASE_API_KEY: "bb-test", BROWSERBASE_PROJECT_ID: "proj-test" }],
  ["kernel", { KERNEL_API_KEY: "kn-test" }],
]) {
  test(`a ${provider} browser computer made through its provider (no launch of the server's) gives a CDP connect to the URL its provider hands over`, async () => {
    const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-claim-browser-")));
    dirs.push(dir);
    const root = join(dir, "work");
    mkdirSync(root);
    const sealed = new Map();
    const store = {
      agents: { revision: async () => undefined },
      sealedKeys: { get: async (name) => sealed.get(name), put: async (name, value) => void sealed.set(name, value), remove: async (name) => void sealed.delete(name), all: async () => [...sealed].map(([name]) => ({ name })) },
      computerLedger: { put: async () => {}, get: async () => undefined, list: async () => [], remove: async () => {} },
    };
    const sealKey = randomBytes(32);
    for (const [name, value] of Object.entries(keys)) await putSealedKey(store, sealKey, name, value);
    const url = `${await devtools()}/devtools/browser/${provider}-1?signingKey=SECRET-${provider}`;
    const record = { created: [], released: [], connects: 0 };
    const providers = { [provider]: () => browserProvider(provider, url, record) };
    const spec = () => ({ image: "browser", lifetimeMs: 60_000, network: "open" });

    const answer = await computerForClaim({ runId: "run-1", epoch: 2, computer: { kind: "browser", provider } }, store, { mode: 1, kinds: KINDS, sealKey, providers, spec, workspace: localWorkspace(root), check: { readBackOf, epoch: 2 } });
    assert.equal(answer.computer?.kind, "browser");
    assert.deepEqual(record.created, [{ "agentrun.run": "run-1", "agentrun.epoch": "2" }]);
    const connectsAtStart = record.connects;
    const session = await answer.computer.connect();
    assert.equal(record.connects, connectsAtStart + 1, "the dial asks the provider's connect");
    assert.deepEqual(await session.send("Browser.getVersion"), { method: "Browser.getVersion", path: `/devtools/browser/${provider}-1?signingKey=SECRET-${provider}` }, "the session is a CDP socket to the URL the provider handed over");
    session.close();
    await answer.release();
    assert.deepEqual(record.released, [[`${provider}-1`, "delete"]]);
  });
}
