// A child process for live_view_stream.test.mjs: it opens the stream against the fake endpoint with every file write of `fs` (callback, sync and promise forms) replaced by one that records and refuses, streams frames and sends input, and
// reports what it recorded. A process of its own, so the test runner's own output cannot be mistaken for the stream's.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import { openStream } from "../dist/live-view/stream.js";

const writes = [];
const refuse = (name) => (...args) => { writes.push(`${name} ${String(args[0]).slice(0, 80)}`); throw new Error(`${name} refused`); };
for (const name of ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "createWriteStream", "mkdir", "mkdirSync", "rename", "renameSync", "copyFile", "copyFileSync", "writeSync", "write", "truncate", "truncateSync", "symlink", "symlinkSync", "unlink", "unlinkSync", "mkdtemp", "mkdtempSync"]) if (typeof fs[name] === "function") fs[name] = refuse(`fs.${name}`);
for (const name of ["writeFile", "appendFile", "mkdir", "rename", "copyFile", "truncate", "symlink", "unlink", "mkdtemp"]) if (typeof fsp[name] === "function") fsp[name] = refuse(`fsp.${name}`);
const realOpen = fs.openSync.bind(fs);
fs.openSync = (p, flags, ...rest) => { if (typeof flags === "string" && /[wa+]/.test(flags)) { writes.push(`fs.openSync ${String(p).slice(0, 80)} ${flags}`); throw new Error("open for writing refused"); } return realOpen(p, flags, ...rest); };

const list = () => { try { return fs.readdirSync(os.tmpdir()).sort(); } catch { return []; } };
const tmpBefore = list();
let frames = 0;
const stream = openStream(process.argv[2], {
  frame: (_bytes, _size, ack) => { frames += 1; ack(); },
  page() {}, dialog() {}, closed() {},
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(1500);
await stream.input({ type: "mouse", action: "move", x: 1, y: 1 }).catch(() => {});
await stream.input({ type: "text", text: "hello" }).catch(() => {});
await stream.nav({ type: "nav", action: "reload" }).catch(() => {});
await wait(500);
stream.close();
console.log("STREAMED");
console.log(`REPORT ${JSON.stringify({ frames, writes, tmpBefore, tmpAfter: list() })}`);
process.exit(0);
