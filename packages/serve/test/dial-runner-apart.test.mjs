// A provider whose machines dial this server (the computer package's connectOf "dial": Fly Machines, Cloudflare and
// Render, and E2B, Daytona or Modal set to dial) on a server whose runner runs in a process of its own (--no-runner; the image's
// server-and-runner): the machine's socket is taken by the attach hub of the server's process, where no run reaches it,
// and the runner's create refuses. Settings → Computers says so before any run starts: the provider's row in
// GET /v2/computers carries runs_refused, as a paired computer's does, and its test (the console's Test connection)
// fails in the same words, naming the fix, where it would pass in the server's process. A provider whose machines the
// server reaches through the vendor (Docker, E2B on exec) says nothing of the kind, and neither does a server with its
// runner beside it.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { client, scratch, startServe } from "./support.mjs";

/** The two fixes, as an operator reads them wherever they are said (workspace/attached-computers.ts RELAY_FIX, then
 *  ONE_PROCESS_FIX): the runner relays the machine's socket once it has the server's public address, as it relays a
 *  paired computer's, or the server runs its runs in its own process. */
const FIX = "give the runner AGENTRUN_PUBLIC_URL (this server's public address), or start the image with the server options alone, without server-and-runner (outside the image: agentrun-serve without --no-runner)";
/** The providers whose machines dial this server as serve makes them (its settings name no connect): the descriptors'. */
const DIALS = [["fly", "Fly Machines"], ["cloudflare", "Cloudflare"], ["render", "Render"]];
/** Providers the server reaches through the vendor: Docker on this machine, and E2B, Daytona and Modal on exec. */
const REACHED = ["docker", "e2b", "daytona", "modal"];

/** Every row of provider `id` in GET /v2/computers' kinds: one per kind it serves. */
const rowsOf = (view, id) => view.kinds.flatMap((kind) => kind.providers.filter((one) => one.id === id));

/** `said` is a dial provider's runner-apart line: no run here can use it, why, and the fix. */
function saysDialApart(said, label, where) {
  assert.equal(typeof said, "string", `${where}: ${JSON.stringify(said)}`);
  assert.equal(said, `no run on this server can use ${label}: its machines dial this server, and its runner runs in a process of its own and relays no machine's socket: ${FIX}`, where);
}

async function served(t, options) {
  const server = await startServe({ data: join(await scratch(t), "agents"), port: 0, ...options });
  t.after(() => server.close());
  return client(server.baseUrl, server.token);
}

test("on a server started with --no-runner, a dial provider's row says no run here can use it and names the fix; its test fails in those words; a provider the server reaches through the vendor says nothing", { timeout: 120_000 }, async (t) => {
  const api = await served(t, { runnerApart: true });
  const listed = await api("GET", "/computers");
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  for (const [id, label] of DIALS) {
    const rows = rowsOf(listed.body, id);
    assert.ok(rows.length > 0, `${id} is listed`);
    for (const row of rows) saysDialApart(row.runs_refused, label, `${id}'s row`);
    // The test: the console's Test connection. It would read the vendor's account in the server's process, and pass
    // there with good keys, while every run fails at the runner: it fails first, in the row's words, with no vendor call.
    const tested = await api("POST", `/computers/${id}/test`);
    assert.equal(tested.status, 200, JSON.stringify(tested.body));
    assert.equal(tested.body.ok, false, JSON.stringify(tested.body));
    saysDialApart(tested.body.why, label, `${id}'s test`);
  }
  for (const id of REACHED) {
    const rows = rowsOf(listed.body, id);
    assert.ok(rows.length > 0, `${id} is listed`);
    for (const row of rows) assert.equal(row.runs_refused, null, `${id}: its runs can use it`);
  }
  const e2b = await api("POST", "/computers/e2b/test");
  assert.deepEqual(e2b.body, { ok: false, why: "E2B needs E2B_API_KEY saved: save it in Settings → Computers" }, "a provider reached through the vendor tests its keys as before");
});

test("on a server with its runner beside it, no provider's row says runs are refused, and a dial provider's test reads its keys", { timeout: 120_000 }, async (t) => {
  const api = await served(t, {});
  const listed = await api("GET", "/computers");
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const rows = listed.body.kinds.flatMap((kind) => kind.providers);
  assert.ok(rows.length > 0);
  for (const row of rows) assert.equal(row.runs_refused, null, `${row.id}: its runs can use it`);
  const tested = await api("POST", "/computers/fly/test");
  assert.deepEqual(tested.body, { ok: false, why: "Fly Machines needs FLY_API_TOKEN and FLY_APP saved: save them in Settings → Computers" });
});
