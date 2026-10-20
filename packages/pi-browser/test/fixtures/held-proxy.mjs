// A loopback TCP proxy to one browser's CDP address. It serves only a websocket upgrade to that browser's own path and
// closes anything else: other processes on a host probe new loopback listeners, and one taking a connection the test
// counts on made the reconnect's own connect wait for Stagehand's 60 s deadline. Connections pass straight through
// until hold(); from then on each new one waits, its first bytes kept, until release() lets it through. drop() cuts
// every connection it carries, as a network would.
import net from "node:net";

export async function heldProxy({ host, port, path }) {
  const waiting = [];
  const sockets = new Set();
  let holding = false;
  const track = (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {}); };
  const server = net.createServer((client) => {
    track(client);
    let head = Buffer.alloc(0);
    const firstLine = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const text = head.toString("latin1");
      if (!text.includes("\r\n") && head.length < 4_096) return;
      client.off("data", firstLine);
      client.pause();
      if (!text.startsWith(`GET ${path} `)) return client.destroy();
      const through = () => {
        const upstream = net.connect(port, host);
        track(upstream);
        client.on("close", () => upstream.destroy());
        upstream.on("close", () => client.destroy());
        upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      };
      if (holding) waiting.push(through); else through();
    };
    client.on("data", firstLine);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    /** From now on a new connection to the browser's path waits. */
    hold() { holding = true; },
    release() { holding = false; for (const through of waiting.splice(0)) through(); },
    /** Connections to the browser's path waiting for release(). */
    waiting: () => waiting.length,
    drop() { for (const socket of sockets) socket.destroy(); },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
