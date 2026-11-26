// Loaded first in a pool worker (read-ahead.test.mjs): counts the worker's FileHandle reads, the lines it reads, and
// those read while a read is in flight, and adds the counts to each reply the worker posts.
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parentPort } from "node:worker_threads";

const watched = { reads: 0, parsed: 0, ahead: 0 };
let inFlight = 0;
const handle = await open(fileURLToPath(import.meta.url), "r");
const proto = Object.getPrototypeOf(handle);
await handle.close();
const read = proto.read;
proto.read = function (...args) {
  inFlight += 1;
  watched.reads += 1;
  return read.apply(this, args).finally(() => (inFlight -= 1));
};
// A line is counted where the reader finds its end (a chunk's indexOf(10)), not at JSON.parse: a totals read through the
// scanner (scan.ts) parses no line in JS.
const indexOf = Buffer.prototype.indexOf;
Buffer.prototype.indexOf = function (value, ...rest) {
  if (value === 10) {
    watched.parsed += 1;
    if (inFlight > 0) watched.ahead += 1;
  }
  return indexOf.call(this, value, ...rest);
};
const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = (message, transfer) => post(message && typeof message === "object" ? { ...message, watched } : message, transfer);
