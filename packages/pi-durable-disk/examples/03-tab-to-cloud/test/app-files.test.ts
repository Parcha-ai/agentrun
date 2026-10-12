// The files a box installs must hold everything the box's entry points import: a module added to remote-host.ts that the bundle does not
// carry makes the remote host fail at start, and the server waits on a box that never answers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { APP_FILES } from "../pipe/daytona.ts";

const DEMO = join(dirname(fileURLToPath(import.meta.url)), "..");

test("every file the box's modules import (not types) is in the bundle", () => {
  const missing: string[] = [];
  for (const file of APP_FILES) {
    const text = readFileSync(join(DEMO, file), "utf8");
    // import ... from "./x.ts" and export ... from "./x.ts", but not `import type`.
    for (const m of text.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+"(\.[^"]+)"/gm)) {
      const target = relative(DEMO, normalize(join(DEMO, dirname(file), m[1]!)));
      if (!APP_FILES.includes(target)) missing.push(`${file} imports ${target}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("a demo layered on the app adds its own files to the bundle, inside it, and they change the bundle's digest", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { appBundle } = await import("../pipe/daytona.ts");
  const dir = mkdtempSync(join(tmpdir(), "bundle-extra-"));
  try {
    const source = join(dir, "extra.ts");
    writeFileSync(source, "export default 1;\n");
    const plain = appBundle();
    const withExtra = appBundle({ "robot/vm/extra.ts": source });
    assert.notEqual(withExtra.digest, plain.digest);
    const names = spawnSync("tar", ["-tzf", "-"], { input: Buffer.from(withExtra), encoding: "utf8" }).stdout;
    assert.match(names, /\.\/robot\/vm\/extra\.ts/);
    assert.doesNotMatch(spawnSync("tar", ["-tzf", "-"], { input: Buffer.from(plain), encoding: "utf8" }).stdout, /robot\/vm\/extra\.ts/);
    assert.throws(() => appBundle({ "../escape.ts": source }), /stay inside the bundle/);
    assert.throws(() => appBundle({ "/abs.ts": source }), /stay inside the bundle/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
