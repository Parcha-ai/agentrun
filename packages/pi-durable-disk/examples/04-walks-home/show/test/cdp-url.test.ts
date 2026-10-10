import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

// scripts/own-chrome.mjs sets CDP_URL after the check's other imports may already have run, so the CDP client must read it when it opens a tab, not when it is imported.
// (It once read it at import: every check run through own-chrome silently drove the shared Chrome on :9222 instead of its own.)
test("the CDP client opens its tab on the CDP_URL in force when the tab is opened, even one set after the client was imported", async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.statusCode = 500;
    res.end("no");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const before = process.env.CDP_URL;
  try {
    // @ts-expect-error the scripts are plain .mjs with no declarations
    const { openTab } = (await import("../scripts/cdp.mjs")) as { openTab: (url: string) => Promise<unknown> };
    process.env.CDP_URL = `http://127.0.0.1:${port}`; // after the import
    await assert.rejects(() => openTab("http://127.0.0.1:9/"), /json\/new: HTTP 500/);
    assert.deepEqual(requests, ["PUT /json/new?about:blank"]);
  } finally {
    if (before === undefined) delete process.env.CDP_URL;
    else process.env.CDP_URL = before;
    server.close();
  }
});
