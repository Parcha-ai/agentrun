// The DevTools guard's rule (cdp-guard.ts cdpRefusal): which commands a guarded local Chrome refuses, and which pass.
// The relay itself is driven on a real Chrome (cdp_local_chrome.test.mjs, and serve's browser-chrome-egress.test.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import { ALLOWED_METHODS, allowedUrl, cdpRefusal, GUARD_REFUSAL } from "../dist/providers/cdp-guard.js";

const OWN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

test("only http, https and about:blank are pages to open, and the driver's own extension pages", () => {
  for (const url of ["http://example.com/", "https://example.com/a?b#c", "about:blank", "", undefined, `${OWN}/wake-service-worker.html`]) assert.equal(allowedUrl(url, OWN), true, String(url));
  for (const url of ["file:///etc/passwd", "FILE:///etc/passwd", "chrome://settings", "chrome://net-internals", "chrome-untrusted://x", "devtools://devtools/bundled/inspector.html", "view-source:https://example.com", "filesystem:https://example.com/temporary/x", "blob:https://example.com/1", "data:text/html,hi", "javascript:alert(1)", "about:version", "about:settings", "chrome-extension://otherotherotherotherotherother/x.html", "ws://example.com", "ftp://example.com", "not a url", 42, null]) {
    assert.equal(allowedUrl(url, OWN), false, String(url));
  }
  assert.equal(allowedUrl(`${OWN}/x.html`), false, "no extension page when none is named");
});

test("navigations and new targets: the scheme rule; refused in words that name no path", () => {
  for (const method of ["Page.navigate", "Target.createTarget"]) {
    assert.equal(cdpRefusal({ method, params: { url: "https://example.com/" } }, OWN), null);
    assert.equal(cdpRefusal({ method, params: { url: `${OWN}/blank.html` } }, OWN), null);
    assert.equal(cdpRefusal({ method, params: { url: "file:///srv/data/secret" } }, OWN), GUARD_REFUSAL);
    assert.equal(cdpRefusal({ method, params: { url: "chrome://settings" } }, OWN), GUARD_REFUSAL);
  }
  assert.equal(cdpRefusal({ method: "Target.createTarget", params: {} }), null, "no url is about:blank");
  assert.doesNotMatch(GUARD_REFUSAL, /\//, "no path in the words");
});

test("what makes the browser read or write this machine's files, or hand the protocol on, is refused; the rest passes", () => {
  const refused = [
    { method: "Network.loadNetworkResource", params: { url: "file:///etc/passwd" } },
    { method: "Network.loadNetworkResource", params: { url: "about:blank" } },
    { method: "Fetch.continueRequest", params: { requestId: "1", url: "file:///etc/passwd" } },
    { method: "DOM.setFileInputFiles", params: { files: ["/etc/passwd"], nodeId: 1 } },
    { method: "Input.dispatchDragEvent", params: { type: "drop", x: 1, y: 1, data: { items: [], files: ["/etc/passwd"], dragOperationsMask: 1 } } },
    { method: "Page.handleFileChooser", params: { action: "accept", files: ["/etc/passwd"] } },
    { method: "Browser.setDownloadBehavior", params: { behavior: "allow", downloadPath: "/srv" } },
    { method: "Page.setDownloadBehavior", params: { behavior: "allow", downloadPath: "/srv" } },
    { method: "Extensions.loadUnpacked", params: { path: "/srv" } },
    { method: "Extensions.uninstall", params: { id: "x" } },
    { method: "Target.exposeDevToolsProtocol", params: { targetId: "t" } },
    { method: "Target.setRemoteLocations", params: { locations: [{ host: "localhost", port: 9222 }] } },
    { method: "Target.openDevTools", params: { targetId: "t" } },
    { method: "Browser.executeBrowserCommand", params: { commandId: "openTabSearch" } },
    { method: "PWA.install", params: { manifestId: "x", installUrlOrBundleUrl: "file:///x" } },
    { method: "Tethering.bind", params: { port: 1 } },
    { method: "Target.sendMessageToTarget", params: { sessionId: "s", message: JSON.stringify({ id: 1, method: "Page.navigate", params: { url: "file:///etc/passwd" } }) } },
    { method: "Target.sendMessageToTarget", params: { sessionId: "s", message: "not json" } },
    // What tells of the machine the browser runs on: its command line, its host, its processes.
    { method: "SystemInfo.getInfo" },
    { method: "SystemInfo.getProcessInfo" },
    { method: "SystemInfo.getFeatureState", params: { featureState: "x" } },
    { method: "Browser.getBrowserCommandLine" },
    { method: "Browser.getVersion" },
    { method: "Browser.getHistograms" },
    { method: "Target.attachToBrowserTarget" },
    { method: "Target.sendMessageToTarget", params: { sessionId: "s", message: JSON.stringify({ id: 1, method: "SystemInfo.getInfo" }) } },
    // Anything not on the list, whatever it is.
    { method: "Memory.getDOMCounters" },
    { method: "Tracing.start" },
    { method: "Storage.getUsageAndQuota", params: { origin: "https://example.com" } },
    {},
  ];
  for (const command of refused) assert.equal(cdpRefusal(command, OWN), GUARD_REFUSAL, JSON.stringify(command));
  const passed = [
    { method: "Runtime.evaluate", params: { expression: "location.href = 'file:///etc/passwd'" } },
    { method: "Fetch.continueRequest", params: { requestId: "1" } },
    { method: "Fetch.continueRequest", params: { requestId: "1", url: "https://example.com/" } },
    { method: "Network.loadNetworkResource", params: { url: "https://example.com/map.js" } },
    { method: "Input.dispatchDragEvent", params: { type: "drop", x: 1, y: 1, data: { items: [], dragOperationsMask: 1 } } },
    { method: "Browser.setDownloadBehavior", params: { behavior: "allow" } },
    { method: "Page.setDownloadBehavior", params: { behavior: "deny" } },
    { method: "Target.sendMessageToTarget", params: { sessionId: "s", message: JSON.stringify({ id: 1, method: "Page.navigate", params: { url: "https://example.com/" } }) } },
    { method: "Page.captureScreenshot", params: {} },
    { method: "Target.attachToTarget", params: { targetId: "t", flatten: true } },
    { method: "DOM.getDocument" },
  ];
  for (const command of passed) assert.equal(cdpRefusal(command, OWN), null, JSON.stringify(command));
});

test("the list is pi-browser's and Stagehand's commands alone: no domain that tells of the host, loads an extension or hands the protocol on", () => {
  for (const method of ALLOWED_METHODS) assert.doesNotMatch(method, /^(SystemInfo|Extensions|PWA|Tethering|Cast|Tracing|Memory|IO|HeapProfiler|Profiler|Debugger|ServiceWorker|FileSystem)\./, method);
  for (const method of ["Browser.getBrowserCommandLine", "Browser.getVersion", "Browser.executeBrowserCommand", "Target.attachToBrowserTarget", "Target.exposeDevToolsProtocol", "Target.setRemoteLocations", "Target.openDevTools", "DOM.setFileInputFiles"]) assert.equal(ALLOWED_METHODS.has(method), false, method);
});
