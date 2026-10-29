// The console's build (apps/console/dist) under AgentRun Server's CSP ("default-src 'self'; script-src 'self';
// style-src 'self'"): its index.html carries no inline script or style, no style= or on*= attribute, and nothing it
// loads comes from another origin; no file of the build names an https: address to load, and none holds a credential.
// CI's console job runs it after the build:  node scripts/check-console-build.mjs [apps/console/dist]
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const dir = process.argv[2] ?? join(import.meta.dirname, "..", "apps", "console", "dist");
const index = readFileSync(join(dir, "index.html"), "utf8");
const tags = [...index.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
assert.ok(tags.length >= 1, "index.html loads the console's script");
for (const [tag, body] of tags) {
  assert.match(tag, /\ssrc="\.\/assets\/[^"]+\.js"/, `a script is a file of the build: ${tag.slice(0, 80)}`);
  assert.equal(body.trim(), "", "no inline script");
}
assert.doesNotMatch(index, /<style\b/i, "no inline <style>");
assert.doesNotMatch(index, /\sstyle\s*=/i, "no style= attribute");
assert.doesNotMatch(index, /\son[a-z]+\s*=/i, "no on*= handler");
assert.doesNotMatch(index, /\b(?:src|href)\s*=\s*"(?:https?:)?\/\//i, "nothing loaded from another origin");
const files = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? (n === "storybook" ? [] : files(join(d, n))) : [join(d, n)]));
for (const file of files(dir).filter((f) => /\.(?:html|css)$/.test(f))) {
  const text = readFileSync(file, "utf8");
  assert.doesNotMatch(text, /@import\s+url\(\s*["']?https?:|url\(\s*["']?https?:/i, `${relative(dir, file)} loads nothing from another origin (fonts are bundled)`);
}
for (const file of files(dir).filter((f) => /\.(?:html|js|css)$/.test(f))) {
  const text = readFileSync(file, "utf8");
  assert.doesNotMatch(text, /ar_local_[A-Za-z0-9_-]{8,}|Bearer [A-Za-z0-9._-]{20,}/, `${relative(dir, file)} holds no credential`);
}
console.log(`The console build in ${relative(process.cwd(), dir) || "."} has no inline script or style and loads nothing from another origin.`);
