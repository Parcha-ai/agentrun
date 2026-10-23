// A run that asks for a pi version (scripts/pi-leg.mjs sets PI_EXPECT_VERSION) runs on exactly that one: the pi-durable,
// chord and pi-ai this package loads, and the chord and pi-ai its pi-durable loads, as a host's install resolves them.
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
/** The copy of `name` a module in `dir` loads: the nearest `node_modules/<name>` above the directory's real path. */
const copyOf = (dir, name) => {
  for (let at = realpathSync(dir); ; at = dirname(at)) {
    const manifest = join(at, "node_modules", name, "package.json");
    if (existsSync(manifest)) return { dir: realpathSync(dirname(manifest)), version: JSON.parse(readFileSync(manifest, "utf8")).version };
    if (at === dirname(at)) throw new Error(`${name} does not resolve from ${dir}`);
  }
};
const expected = process.env.PI_EXPECT_VERSION;

test("the package and the pi-durable it loads run on the pi version they were asked to run on", { skip: expected ? false : "no version asked for" }, () => {
  const durable = copyOf(here, "@earendil-works/pi-durable");
  const seen = {
    "@earendil-works/pi-durable": durable.version,
    "@earendil-works/chord": copyOf(here, "@earendil-works/chord").version,
    "@earendil-works/pi-ai": copyOf(here, "@earendil-works/pi-ai").version,
    "pi-durable's chord": copyOf(durable.dir, "@earendil-works/chord").version,
    "pi-durable's pi-ai": copyOf(durable.dir, "@earendil-works/pi-ai").version,
  };
  assert.deepEqual(seen, Object.fromEntries(Object.keys(seen).map((name) => [name, expected])));
});
