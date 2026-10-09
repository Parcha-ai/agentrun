// Child of the listener test: onFenced throws. The failing call must still reject with the fenced error, and the
// listener's own error must surface as an uncaught exception instead of being swallowed.
const uncaught: string[] = [];
process.on("uncaughtException", (error) => void uncaught.push(error.message));
import { Fence, FencedDatabase, StoreFencedError } from "../../src/store.ts";

const inner = {
  exec: async () => {},
  run: async () => {
    throw Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode: 778, errstr: "disk I/O error" });
  },
  get: async () => undefined,
  all: async () => [],
  transaction: async () => undefined as never,
  close: async () => {},
};
const facade = new FencedDatabase(inner, new Fence(() => {
  throw new Error("listener bug");
}));
const failure = await facade.run("INSERT").then(() => undefined, (error: unknown) => error);
await new Promise((resolve) => setImmediate(resolve));
process.stdout.write(`${JSON.stringify({ typed: failure instanceof StoreFencedError, fenced: facade.fenced, uncaught })}\n`);
