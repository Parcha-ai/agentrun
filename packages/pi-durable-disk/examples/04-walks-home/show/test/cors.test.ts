import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { corsHeaders } from "../cors.ts";
// @ts-expect-error plain .mjs helpers shared with the check scripts
import { freePort, waitForStage } from "../scripts/cdp.mjs";

// The stage page is static files served next to the agent's tab (the 03 server's /show/); its feed is this server, on another origin. The page is cross-origin isolated (COEP), so its
// fetches and its event stream to this server need CORS. Only the one origin named in SHOW_ALLOW_ORIGIN gets it: this server takes commands (POST /api/command).
test("only the one allowed origin gets CORS, and it is told exactly which", () => {
  const allow = "http://127.0.0.1:8790";
  const h = corsHeaders(allow, allow)!;
  assert.equal(h["Access-Control-Allow-Origin"], allow);
  assert.equal(h["Vary"], "Origin");
  assert.match(h["Access-Control-Expose-Headers"]!, /x-last-event-id/i, "the page resumes the event stream from this header");
  assert.match(h["Access-Control-Allow-Headers"]!, /content-type/i);
  assert.match(h["Access-Control-Allow-Methods"]!, /POST/);
  assert.equal(h["Access-Control-Allow-Credentials"], undefined, "no credentials");
  assert.deepEqual(corsHeaders(allow, "http://evil.example"), { Vary: "Origin" }, "another origin: nothing but Vary");
  assert.deepEqual(corsHeaders(allow, undefined), { Vary: "Origin" });
  assert.deepEqual(corsHeaders(undefined, allow), {}, "no allowed origin configured: no CORS at all");
  assert.equal(corsHeaders(`${allow}/some/path?x=1`, allow)!["Access-Control-Allow-Origin"], allow, "the setting may be a URL: its origin counts");
  assert.deepEqual(corsHeaders("not a url", allow), {});
  assert.deepEqual(corsHeaders("*", "*"), {}, "never a wildcard");
});

const children: ChildProcess[] = [];
after(() => children.forEach((c) => c.kill()));
const show = join(dirname(fileURLToPath(import.meta.url)), "..");
async function realStage(env: Record<string, string>): Promise<string> {
  const port = await freePort();
  const child = spawn(process.execPath, [join(show, "serve.ts")], { env: { PATH: process.env.PATH, SHOW_PORT: String(port), SHOW_AUTOKILL: "off", ...env }, stdio: "ignore" });
  children.push(child);
  await waitForStage(port, child);
  return `http://127.0.0.1:${port}`;
}

test("the real server: the allowed origin's request, its preflight and its event stream carry CORS; another origin's and a server with no setting carry none", async () => {
  const allow = "http://127.0.0.1:8790";
  const base = await realStage({ SHOW_ALLOW_ORIGIN: allow });
  const get = await fetch(`${base}/api/state`, { headers: { origin: allow } });
  assert.equal(get.headers.get("access-control-allow-origin"), allow);
  assert.match(get.headers.get("access-control-expose-headers") ?? "", /x-last-event-id/i);
  const pre = await fetch(`${base}/api/command`, { method: "OPTIONS", headers: { origin: allow, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), allow);
  assert.match(pre.headers.get("access-control-allow-headers") ?? "", /content-type/i);
  const other = await fetch(`${base}/api/state`, { headers: { origin: "http://evil.example" } });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
  const preEvil = await fetch(`${base}/api/command`, { method: "OPTIONS", headers: { origin: "http://evil.example", "access-control-request-method": "POST" } });
  assert.equal(preEvil.headers.get("access-control-allow-origin"), null, "a preflight from another origin is not approved");
  const plain = await realStage({});
  const none = await fetch(`${plain}/api/state`, { headers: { origin: allow } });
  assert.equal(none.headers.get("access-control-allow-origin"), null);
});
