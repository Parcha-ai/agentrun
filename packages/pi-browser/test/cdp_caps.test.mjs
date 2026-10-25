import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { cdpProvider } from "../dist/providers/cdp.js";

test("a cdp provider on an endpoint the host names shares that one browser across its sessions; one that starts its own Chrome per session does not (#1078)", () => {
  assert.equal(cdpProvider({ endpoint: "ws://127.0.0.1:9/devtools/browser/shared" }).caps.sharedBrowser, true);
  assert.equal(cdpProvider({ chrome: { executablePath: "/nonexistent/chrome", profileRoot: os.tmpdir() } }).caps.sharedBrowser ?? false, false);
});
