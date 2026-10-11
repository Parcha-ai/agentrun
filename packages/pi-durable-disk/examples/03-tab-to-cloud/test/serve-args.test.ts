// The server's numeric bounds are checked at parse time: a mistyped one is an error before anything starts, not a move that times out at once.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const serve = join(dirname(fileURLToPath(import.meta.url)), "..", "serve.ts");
const run = (...args: string[]) => spawnSync(process.execPath, [serve, ...args], { encoding: "utf8", timeout: 30_000 });

describe("serve.ts numeric arguments", () => {
  for (const [name, value] of [["remote-start-ms", "abc"], ["remote-start-ms", "0"], ["remote-start-ms", "-5"], ["remote-start-ms", ""], ["remote-start-ms", "Infinity"], ["grace-ms", "soon"]] as const) {
    it(`--${name} ${JSON.stringify(value)} is refused with exit 2 and says which one`, () => {
      const r = run(`--${name}=${value}`);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, new RegExp(`--${name} .*positive number of milliseconds`));
    });
  }
});
