// The MCP server over stdio, for an ACP agent that takes no MCP over HTTP: a bridge the agent starts as its stdio MCP
// server, which forwards each JSON-RPC line to the adapter's loopback HTTP server (mcp.ts) and writes back what it
// answers, its progress notifications among them. Written for AgentRun.
//  - Its endpoint and key come in its environment (AGENTRUN_MCP_URL, AGENTRUN_MCP_KEY), which the adapter gives the agent
//    for it in session/new; nothing else is read.
//  - `notifications/cancelled` aborts the request it names, so a call the agent gave up on is aborted on the server too.
//  - It ends when its stdin does.
import { createInterface } from "node:readline";

const url = process.env.AGENTRUN_MCP_URL ?? "";
const key = process.env.AGENTRUN_MCP_KEY ?? "";
const inFlight = new Map<unknown, AbortController>();
const write = (message: unknown) => void process.stdout.write(`${JSON.stringify(message)}\n`);

async function forward(message: { id?: unknown; method?: unknown; params?: unknown }): Promise<void> {
  const controller = new AbortController();
  if (message.id !== undefined) inFlight.set(message.id, controller);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(message),
      signal: controller.signal,
    });
    if (response.status === 202 || message.id === undefined) {
      await response.body?.cancel();
      return;
    }
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const text = await response.text();
      write(text ? JSON.parse(text) : { jsonrpc: "2.0", id: message.id, error: { code: -32603, message: `the server answered ${response.status}` } });
      return;
    }
    // An event stream: each event's data is one message, written as it comes.
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
        const event = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(line.startsWith("data: ") ? 6 : 5)).join("\n");
        if (data) write(JSON.parse(data));
      }
    }
  } catch (error) {
    if (message.id !== undefined && !controller.signal.aborted) write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String((error as Error)?.message ?? error).slice(0, 300) } });
  } finally {
    if (message.id !== undefined) inFlight.delete(message.id);
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message: { id?: unknown; method?: unknown; params?: { requestId?: unknown } };
  try {
    message = JSON.parse(line) as typeof message;
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "the line is not JSON" } });
    return;
  }
  if (message.method === "notifications/cancelled") inFlight.get(message.params?.requestId)?.abort();
  void forward(message);
});
lines.on("close", () => {
  for (const controller of inFlight.values()) controller.abort();
  process.exit(0);
});
