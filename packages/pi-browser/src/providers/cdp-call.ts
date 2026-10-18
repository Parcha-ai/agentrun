// The reply comes back with the socket open: a setting that lasts only as long as its socket
// (Browser.setDownloadBehavior) is held by keeping it; a caller that only asks closes it.
export type CdpSession = { result: any; close(): void; readonly open: boolean };

export function cdpCall(url: string, method: string, params: object = {}, timeoutMs = 5_000): Promise<CdpSession> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    // One outcome only: closing a socket that never opened raises `error` again on some Node lines, which would loop.
    const finish = (error: Error | null, result?: any) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.onerror = null;
      if (error) { socket.close(); reject(error); } else resolve({ result, close: () => socket.close(), get open() { return socket.readyState === 1; } });
    };
    const timer = setTimeout(() => finish(new Error(`the browser did not answer ${method}`)), timeoutMs);
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method, params }));
    // A throw in a socket listener ends the process: a frame that is not JSON is dropped, and the timeout still ends the call.
    socket.onmessage = (event) => {
      let reply: any;
      try { reply = JSON.parse(String(event.data)); } catch { return; }
      if (reply?.id === 1) finish(reply.error ? new Error(String(reply.error.message ?? "refused")) : null, reply.result);
    };
    socket.onerror = () => finish(new Error(`the CDP socket to ${new URL(url).host} failed`));
  });
}
