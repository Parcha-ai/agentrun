// Loaded first in a pool worker (read-ahead.test.mjs): counts the worker's FileHandle reads, the lines it parses, and
// those parsed while a read is in flight, and adds the counts to each reply the worker posts.
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
const parse = JSON.parse;
JSON.parse = function (...args) {
  watched.parsed += 1;
  if (inFlight > 0) watched.ahead += 1;
  return parse.apply(this, args);
};
const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = (message, transfer) => post(message && typeof message === "object" ? { ...message, watched } : message, transfer);
