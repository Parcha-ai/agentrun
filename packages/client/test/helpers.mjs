// What the client's tests share: the server started with a faux model on loopback, and a loopback listener that plays a
// server, each under its own random path prefix.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVE = new URL("../../serve/dist/cli.js", import.meta.url).pathname;
const DROPPED = ["AGENTRUN_BASE_URL", "AGENTRUN_API_KEY", "AGENTRUN_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL", "AGENTRUN_BOXES", "PARALLEL_API_KEY"];

// Writes the file the first message names (`write NAME.md`); asks its person first when told to ask, and writes what
// they said; then answers. Priced on output only, $100 a million, as the server's cap tests price it: a request's least
// (1,024 tokens) is $0.1024, so a run capped under that stops at its cap before its first request.
const FAUX = `const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));
export default (context, faux) => {
  const users = context.messages.filter((m) => m.role === "user").map(textOf);
  const wrote = context.messages.some((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((c) => c.type === "toolCall" && c.name === "write"));
  if (wrote) return faux.message("Done.");
  if (users[0].includes("Ask me") && users.length === 1 && context.messages.at(-1)?.role !== "toolResult") return faux.message(faux.toolCall("ask_person", { question: "Which region?" }), { stopReason: "toolUse" });
  const file = /write (\\S+\\.md)/i.exec(users[0])?.[1] ?? "out.md";
  return faux.message(faux.toolCall("write", { path: file, content: "# " + users.at(-1) + "\\n" }), { stopReason: "toolUse" });
};
export const cost = { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 };
`;

/** The server on loopback with the priced faux model: its base URL and its token. */
export async function serve(t) {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-client-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !DROPPED.includes(name))), HOME: dir, XDG_CONFIG_HOME: join(dir, ".config") };
  writeFileSync(join(dir, "faux.mjs"), FAUX);
  const data = join(dir, "data");
  const child = spawn(process.execPath, [SERVE, "--data", data, "--port", "0", "--faux", join(dir, "faux.mjs")], { stdio: ["ignore", "pipe", "pipe"], env: { ...env, AGENTRUN_ACCOUNTS: "0", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") } });
  t.after(() => child.exitCode === null && child.kill("SIGKILL"));
  let err = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk) => (err += chunk));
  for (let i = 0; !existsSync(join(data, ".server.json")); i++) {
    assert.ok(i < 600 && child.exitCode === null, `the server started: ${err}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const record = JSON.parse(readFileSync(join(data, ".server.json"), "utf8"));
  return { baseUrl: record.base_url, token: readFileSync(join(data, ".token"), "utf8").trim() };
}

/** A loopback HTTP server that records every request under its own random path prefix (part of `base`; a request's `url`
 *  is recorded without it) and answers with `answer(request, res)`: [status, headers, body], or nothing once it wrote the
 *  answer itself. Anything else, such as another test's late retry to a port this one now holds, is a 404, neither
 *  answered nor recorded. */
export async function listener(t, answer = () => [200, { "content-type": "application/json" }, "{}"]) {
  const requests = [];
  const prefix = `/${randomBytes(8).toString("hex")}`;
  const server = createServer((req, res) => {
    if (!req.url.startsWith(`${prefix}/`)) return void res.writeHead(404).end();
    req.url = req.url.slice(prefix.length);
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const request = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(request);
      const answered = answer(request, res);
      if (answered) res.writeHead(answered[0], answered[1]).end(answered[2]);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, prefix, base: `${origin}${prefix}/v2`, requests };
}

export const JSON_HEADERS = { "content-type": "application/json" };
