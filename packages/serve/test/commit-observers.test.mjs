// pi 1.5 detaches a commit observer whose `advance` throws, for good (pi-durable Session.observeCommits): every commit
// after it goes unseen, silently. In serve an observer counts money (browser-cost.ts), so each observeCommits call site
// here either catches inside its advance or only resolves a promise. This lists every site it accepts, by file:line: a
// new site fails here until it is read and listed, and an accepted one that stops catching fails too.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const SERVE = new URL("..", import.meta.url).pathname;

/** Each accepted site: where the call is, and what keeps a throw out of pi. */
export const ACCEPTED = [
  { at: "src/browser-cost.ts:166", keeps: "catches", why: "a charge it fails to count, or an early end, makes the run's spend unknown (spent null)" },
];

function sources(dir = join(SERVE, "src")) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.(m?ts|m?js)$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

/** Every observeCommits call in serve's sources, as `file:line`, with the source from the call to the end of its observer. */
function sites() {
  return sources().flatMap((file) => {
    const text = readFileSync(file, "utf8");
    return [...text.matchAll(/\.observeCommits\(/g)].map((match) => {
      const line = text.slice(0, match.index).split("\n").length;
      // The observer: from the call to its closing parenthesis, by depth.
      let depth = 0;
      let end = match.index + match[0].length - 1;
      for (; end < text.length; end += 1) {
        if (text[end] === "(") depth += 1;
        else if (text[end] === ")" && --depth === 0) break;
      }
      return { at: `${relative(SERVE, file)}:${line}`, body: text.slice(match.index, end + 1) };
    });
  });
}

test("every commit observer in serve is a listed site, read for pi 1.5's detach on a throw", () => {
  assert.deepEqual(sites().map((site) => site.at).sort(), ACCEPTED.map((site) => site.at).sort());
});

test("each listed observer keeps a throw out of pi: its advance catches, or only resolves a promise", () => {
  for (const site of sites()) {
    const accepted = ACCEPTED.find((entry) => entry.at === site.at);
    if (!accepted) continue;
    const advance = site.body.slice(site.body.indexOf("advance"));
    if (accepted.keeps === "catches") assert.match(advance, /try\s*\{[\s\S]*\}\s*catch\s*\(/, `${site.at}: its advance catches`);
    else assert.match(advance, /advance:\s*\(\)\s*=>\s*\w+\(\)/, `${site.at}: its advance only resolves`);
  }
});
