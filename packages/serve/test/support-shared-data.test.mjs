// support.mjs serve(): a server a test starts on another server's data (a restart's, `serve(t, { data: first.data })`)
// is closed before the first server's after-hook removes that directory. node:test runs after-hooks in the order they
// were added, so the first server's runs first: were the second still open there, a directory removed under a server
// still writing to it fails with ENOTEMPTY, and the hook's failure skips the hooks after it (the second's close among
// them), so the file hangs. A hook this test adds between the two servers' runs right after the first's: by then the
// directory must be gone and the second server must take no connection. It closes the second itself before it says so,
// so a failure here reads as this test's, bounded, never as the file's timeout.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { test } from "node:test";
import { serve } from "./support.mjs";

/** Whether a TCP connection to `url`'s port on loopback is taken (true) or refused (false). */
const answers = (url) => new Promise((resolve) => {
  const socket = connect({ host: "127.0.0.1", port: Number(new URL(url).port) });
  socket.once("connect", () => (socket.destroy(), resolve(true)));
  socket.once("error", () => resolve(false));
});

test("a server started on another's data is closed before the first server's after-hook removes that directory", { timeout: 60_000 }, async (t) => {
  const first = await serve(t);
  let second;
  // Added after the first server's hook and before the second's: it runs right after the first's.
  t.after(async () => {
    const gone = !existsSync(first.data);
    const open = await answers(second.baseUrl);
    await second.close();
    assert.equal(gone, true, "the first server's hook removed its directory");
    assert.equal(open, false, "the server on that directory was closed before it went");
  });
  // A restart: the first lets go of the data (its lock), and the second opens it.
  await first.close();
  second = await serve(t, { data: first.data });
  assert.equal(await answers(second.baseUrl), true, "the second server answers while the test runs");
});
