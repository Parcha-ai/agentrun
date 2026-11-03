// The home path checks on their own (home-path.ts): plain segments, the fold that host-owned names are matched by, the
// identity check, and a seeded property over 20,000 paths against the ways a disk can take two names for one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../dist/errors.js";
import { foldName, homePath, ownedBy, ownedByIdentity } from "../dist/home-path.js";

test("the fold takes a name's compatibility form, upper then lower case, and drops combining marks", () => {
  for (const [name, folded] of [["learnıng", "learning"], ["LEARNİNG", "learning"], ["ｌｅａｒｎｉｎｇ", "learning"], ["Learning", "learning"], ["ſ", "s"], ["K", "k"], ["café", "cafe"]]) assert.equal(foldName(name), folded, JSON.stringify(name));
  // Names with letters the long s and the Kelvin sign stand for, as host-owned names: matched in those spellings.
  assert.equal(ownedBy(["skills"], "ſkills/x"), "skills");
  assert.equal(ownedBy(["kit"], "Kit"), "kit");
  assert.equal(ownedBy(["learning"], "./LEARNİNG/x"), "learning");
  for (const path of ["learning2/x", "notes/learning/x", "learn/ing", "café.md"]) assert.equal(ownedBy(["learning"], path), undefined, path);
});

test("a first segment that is on disk the same entry as learning/ is learning, whatever its spelling; absent either, it is not", async () => {
  // Stats as a disk that takes two spellings for one name would give them: given, since such a disk is not made here.
  const disk = (entries) => async (path) => entries[path] ?? null;
  assert.equal(await ownedByIdentity("/data/homes/keeper", "Other/notes.md", ["learning"], disk({ "/data/homes/keeper/Other": { dev: 1n, ino: 7n }, "/data/homes/keeper/learning": { dev: 1n, ino: 7n } })), "learning");
  assert.equal(await ownedByIdentity("/data/homes/keeper", "Other", ["learning"], disk({ "/data/homes/keeper/Other": { dev: 1n, ino: 7n }, "/data/homes/keeper/learning": { dev: 1n, ino: 7n } })), "learning");
  assert.equal(await ownedByIdentity("/data/homes/keeper", "Other/notes.md", ["learning"], disk({ "/data/homes/keeper/Other": { dev: 1n, ino: 7n }, "/data/homes/keeper/learning": { dev: 1n, ino: 8n } })), undefined, "another inode");
  assert.equal(await ownedByIdentity("/data/homes/keeper", "Other/notes.md", ["learning"], disk({ "/data/homes/keeper/Other": { dev: 1n, ino: 7n }, "/data/homes/keeper/learning": { dev: 2n, ino: 7n } })), undefined, "another device");
  assert.equal(await ownedByIdentity("/data/homes/keeper", "Other/notes.md", ["learning"], disk({ "/data/homes/keeper/Other": { dev: 1n, ino: 7n } })), undefined, "no learning/ there");
  assert.equal(await ownedByIdentity("/data/homes/keeper", "Other/notes.md", ["learning"], disk({ "/data/homes/keeper/learning": { dev: 1n, ino: 7n } })), undefined, "the segment not there");
});

/** A seeded generator (mulberry32): the same paths on every run. */
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ASCII = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"];
const SEPARATORS = ["/", ".", "-"];
const IGNORABLES = ["​", "‌", "‍", "‎", "‏", "­", "͏", "⁠", "⁡", "⁢", "⁣", "⁤", "﻿"];
const FULLWIDTH = [..."learningLEARNING"].map((c) => String.fromCodePoint(c.codePointAt(0) + 0xfee0));
const LOOKALIKES = ["ı", "İ", "ſ", "K", "́", ...FULLWIDTH];
const ALPHABET = [...ASCII, ...SEPARATORS, ...IGNORABLES, ...LOOKALIKES];

/** Unicode full case folding where it differs from toLowerCase for the characters here (CaseFolding.txt, C and F). */
const FOLDING = { "ſ": "s", "İ": "i̇", "ı": "ı" };
const caseFold = (s) => [...s].map((c) => FOLDING[c] ?? c.toLowerCase()).join("");
/** When a disk takes a name for another: each maps a name to the form it compares. */
const DISKS = {
  "case-sensitive": (s) => s,
  "simple case fold": (s) => s.toLowerCase(),
  "Unicode case fold and NFD": (s) => caseFold(s.normalize("NFD")).normalize("NFD"),
  "an upcase table (upper case)": (s) => s.toUpperCase().toLowerCase(),
  "default-ignorables dropped, then folded": (s) => caseFold(s.replace(/\p{Default_Ignorable_Code_Point}/gu, "").normalize("NFD")),
};

/** A path: one to four words, each learning changed a little, random letters from the alphabet, or a fixed name. */
function pathOf(next) {
  const pick = (list) => list[Math.floor(next() * list.length)];
  const word = () => {
    const kind = next();
    if (kind < 0.45) {
      let w = [..."learning"].map((c) => (next() < 0.3 ? c.toUpperCase() : c));
      for (let edits = Math.floor(next() * 4); edits > 0; edits--) {
        const at = Math.floor(next() * (w.length + 1));
        const how = next();
        if (how < 0.35) w.splice(at, 0, pick([...IGNORABLES, "́"]));
        else if (how < 0.7 && at < w.length) w[at] = w[at] === "i" || w[at] === "I" ? pick(["ı", "İ", "ｉ", "Ｉ"]) : String.fromCodePoint(w[at].codePointAt(0) + 0xfee0);
        else w.splice(at, 0, pick(ALPHABET));
      }
      return w.join("");
    }
    if (kind < 0.8) return Array.from({ length: Math.floor(next() * 10) }, () => pick(ALPHABET)).join("");
    return pick(["learning", "Learning", "LEARNING", "learning2", "notes", "café", "x", ".", "..", ""]);
  };
  const words = Array.from({ length: 1 + Math.floor(next() * 4) }, word);
  const prefix = next() < 0.1 ? pick(["./", "a/../", "/"]) : "";
  return prefix + words.join("/");
}

test("a path the home routes take never has a host-owned name as its first segment, on any of five disks' idea of one name: 20,000 seeded paths", (t) => {
  const started = performance.now();
  const next = random(0x1310);
  const target = Object.fromEntries(Object.entries(DISKS).map(([name, fold]) => [name, fold("learning")]));
  const reached = Object.fromEntries(Object.keys(DISKS).map((name) => [name, 0]));
  let accepted = 0;
  let refused = 0;
  for (let i = 0; i < 20_000; i++) {
    const path = pathOf(next);
    const first = path.split("/")[0];
    for (const [name, fold] of Object.entries(DISKS)) if (fold(first) === target[name]) reached[name]++;
    for (const write of [false, true]) {
      let ok = true;
      try {
        homePath(path, "keeper", write);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        ok = false;
      }
      if (!ok) {
        refused++;
        continue;
      }
      accepted++;
      for (const [name, fold] of Object.entries(DISKS)) assert.notEqual(fold(first), target[name], `${JSON.stringify(path)} (${write ? "write" : "read"}) is taken, and on a disk with ${name} its first segment is learning`);
    }
  }
  // Not vacuous: paths the routes take, paths they refuse, and on every disk first segments it takes for learning.
  assert.ok(accepted > 1_000 && refused > 1_000, `accepted ${accepted}, refused ${refused}`);
  for (const [name, count] of Object.entries(reached)) assert.ok(count > 0, `no path's first segment is learning on a disk with ${name}`);
  t.diagnostic(`20000 paths, ${accepted + refused} verdicts (${accepted} taken, ${refused} refused) in ${Math.round(performance.now() - started)} ms; first segments taken for learning: ${JSON.stringify(reached)}`);
});
