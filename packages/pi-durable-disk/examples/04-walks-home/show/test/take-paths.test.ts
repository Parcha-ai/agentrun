import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
// @ts-expect-error: a plain .mjs script, without types
import { TAB_WRITABLE_PATHS } from "../scripts/take-paths.mjs";

test("the take's server lets the tab PUT exactly the paths the creature page writes (a creature file the show refuses is lost without a word)", () => {
  const source = readFileSync(new URL("../../../03-tab-to-cloud/tab/main.ts", import.meta.url), "utf8");
  const listed = /const CREATURE_WRITABLE = new Set\(\[([^\]]*)\]\)/.exec(source);
  assert.ok(listed, "CREATURE_WRITABLE is where this test looks for the page's list");
  const page = [...listed![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(page.includes("creature/fit.json") && page.includes("creature/design.json") && page.includes("creature/scene.json"));
  for (const path of page) assert.ok((TAB_WRITABLE_PATHS as string[]).includes(path), `${path} is written by the creature page and is not in the take's list`);
  // and the other way: a path the page no longer writes is not left open to it
  for (const path of TAB_WRITABLE_PATHS as string[]) assert.ok(page.includes(path), `${path} is in the take's list but the creature page does not write it`);
});
