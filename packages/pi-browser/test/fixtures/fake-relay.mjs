// A recorded CDP relay: a loopback WebSocket endpoint that answers an upgrade only when it carries the expected
// Authorization header, records every upgrade it saw (path and headers), and holds an answered socket open. It speaks
// WebSocket by hand, so no package is needed.
import { createHash } from "node:crypto";
import http from "node:http";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** `token` is the bearer the relay accepts. */
export async function fakeRelay({ token, path = "/cdp" } = {}) {
  const upgrades = [];
  const sockets = new Set();
  const server = http.createServer((_req, res) => { res.writeHead(404).end(); });
  server.on("upgrade", (req, socket) => {
    upgrades.push({ path: req.url, headers: { ...req.headers } });
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    if (req.url !== path || req.headers.authorization !== `Bearer ${token}`) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    // A client's close frame is answered with one and the socket ends, as a relay does.
    socket.on("data", (chunk) => { if ((chunk[0] & 15) === 8) { socket.write(Buffer.from([0x88, 0])); socket.end(); } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `ws://127.0.0.1:${port}${path}`,
    upgrades,
    /** Sockets the relay still holds open. */
    open: () => [...sockets].filter((s) => !s.destroyed).length,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
