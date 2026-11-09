// pi 1.5 detaches a commit observer whose `advance` throws, for good (pi-durable Session.observeCommits): every commit
// after it goes unseen, silently. Observers count money (serve's browser-cost.ts), park runs and record them, so each
// observeCommits call site in every package's sources either catches inside its advance or only resolves a promise.
// This lists every site it accepts, by file:line: a new one fails here until it is read and listed, and a listed one
// that stops catching fails too. It runs in CI with the root suites (test:release, scripts/*.test.mjs).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

/** Each accepted site: where the call is, and what keeps a throw out of pi. */
export const ACCEPTED = [
  { at: "packages/pi-durable-disk/src/park.ts:209", keeps: "resolves", why: "parking's recheck: queues a check, never throws" },
  { at: "packages/pi-durable-disk/src/park.ts:242", keeps: "resolves", why: "drain's wake: resolves the promise its loop waits on" },
  { at: "packages/pi-durable-disk/src/live-events.ts:129", keeps: "catches", why: "the watchEvents adapter: a commit it cannot translate ends the stream, failed" },
  { at: "packages/pi-durable-disk/src/live-events.ts:150", keeps: "catches", why: "the adapter's followed documents: a change it cannot follow ends the stream, failed" },
  { at: "packages/pi/src/durable/recording.ts:279", keeps: "catches", why: "the recording maps and queues; a failure is the stop's to report" },
  { at: "packages/serve/src/browser-cost.ts:215", keeps: "catches", why: "a charge it fails to count, or an end before the run's close, makes the run's spend unknown (spent null)" },
  { at: "packages/serve/src/runner/loop.ts:535", keeps: "catches", why: "the runner's held state (pi.live): its advance hands the ticker a reader and catches; a value it cannot read reports nothing held, at the tick, whose read never throws; its end only returns" },
];

/** Every source file under each package's src/ (no dist/, vendor/ or declaration file). */
function sources() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "dist" || name === "vendor" || name === "node_modules") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(m?ts|m?js)$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
    }
  };
  for (const pkg of readdirSync(join(repo, "packages"))) if (existsSync(join(repo, "packages", pkg, "src"))) walk(join(repo, "packages", pkg, "src"));
  return out;
}

/** Every `.observeCommits(` and `.observeDoc(` call (pi's Session methods, both detaching an observer whose advance
 *  throws; a local function of that name is not one), as `file:line`, with its source from the call to the parenthesis
 *  that closes it. */
function sites() {
  return sources().flatMap((file) => {
    const text = readFileSync(file, "utf8");
    return [...text.matchAll(/\.(?:observeCommits|observeDoc)\(/g)].map((match) => {
      const line = text.slice(0, match.index).split("\n").length;
      let depth = 0;
      let end = match.index + match[0].length - 1;
      for (; end < text.length; end += 1) {
        if (text[end] === "(") depth += 1;
        else if (text[end] === ")" && --depth === 0) break;
      }
      return { at: `${relative(repo, file)}:${line}`, body: text.slice(match.index, end + 1) };
    });
  });
}

test("every commit observer in the packages' sources is a listed site, read for pi 1.5's detach on a throw", () => {
  assert.deepEqual(sites().map((site) => site.at).sort(), ACCEPTED.map((site) => site.at).sort());
});

test("each listed observer keeps a throw out of pi: its advance catches, or only resolves", () => {
  for (const site of sites()) {
    const accepted = ACCEPTED.find((entry) => entry.at === site.at);
    if (!accepted) continue;
    const advance = site.body.slice(site.body.indexOf("advance"));
    if (accepted.keeps === "catches") assert.match(advance, /try\s*\{[\s\S]*\}\s*catch\s*[({]/, `${site.at}: its advance catches`);
    else assert.match(advance, /^advance:\s*\(\)\s*=>\s*\w+\(\)\s*,/, `${site.at}: its advance only calls a resolver`);
  }
});
