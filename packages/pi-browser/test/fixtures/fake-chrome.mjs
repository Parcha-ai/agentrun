#!/usr/bin/env node
// A stand-in for Chrome as the cdp provider sees it: it opens a debugging port and says so in the profile (DevToolsActivePort), links the profile to a
// singleton socket directory under its TMPDIR, and, like Chrome's network stack, makes `com.google.Chrome.chrome_chrome_url_fetcher_.<six>` entries under
// its TMPDIR that nothing removes when it is killed. It records the TMPDIR it was given in the profile (`fake-chrome.json`), and, with
// FAKE_CHROME_WRITER=1, keeps adding files to its url_fetcher entry until it is killed.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const profile = arg("user-data-dir");
const tmp = process.env.TMPDIR;
const entry = (prefix) => { const dir = fs.mkdtempSync(path.join(tmp, prefix)); return dir; };
const socketDir = entry(".org.chromium.Chromium.");
fs.writeFileSync(path.join(socketDir, "SingletonSocket"), "");
try { fs.symlinkSync(path.join(socketDir, "SingletonSocket"), path.join(profile, "SingletonSocket")); } catch {}
const fetcher = entry("com.google.Chrome.chrome_chrome_url_fetcher_.");
fs.writeFileSync(path.join(fetcher, "0"), "x");
if (process.env.FAKE_CHROME_EXIT) process.exit(Number(process.env.FAKE_CHROME_EXIT)); // after its temp entries, as a Chrome that dies at start leaves them
const server = http.createServer((req, res) => {
  if (req.url === "/json/version") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ Browser: "Fake/1", webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/fake` })); return; }
  res.statusCode = 404; res.end();
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(path.join(profile, "fake-chrome.json"), JSON.stringify({ tmpdir: tmp, argv: process.argv.slice(2), env: Object.keys(process.env) }));
  fs.writeFileSync(path.join(profile, "DevToolsActivePort"), `${server.address().port}\n/devtools/browser/fake\n`);
  if (process.env.FAKE_CHROME_WRITER === "1") { let n = 1; setInterval(() => { try { fs.writeFileSync(path.join(fetcher, String(n++)), "x"); } catch {} }, 1); }
});
