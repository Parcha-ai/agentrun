// The scrubber's known negatives: text that looks like a secret and is not one (git SHAs, UUIDs, content hashes, lockfile
// integrity strings, base64 images, code that names a token or a password, prose about keys, public addresses, coloured
// terminal output, hash test vectors). A share page with a SHA cut out of it looks broken, so a cut here, by any rule,
// fails. The corpus is frozen in test/fixtures/scrub-negatives/ (its README says how to add a case); this file only
// reads it.
//
// Each case is scrubbed as written and as a JSON string holds it (a transcript keeps text in JSON), in count mode (no
// cut counted) and in cut mode (the text back byte for byte). A failure names the fixture file, its line, the case id,
// the rule, its kind and the span: the span's text is printed too, as every case here is synthetic.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SCRUB_RULES, scrub } from "../dist/secret-cut.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "scrub-negatives");

/** The categories, each its own file, and the fewest cases each must hold: deleting or emptying a file must not make the
 *  check pass by having nothing to check. */
const CATEGORIES = {
  "git-shas.jsonl": 40,
  "uuids.jsonl": 30,
  "content-hashes.jsonl": 30,
  "lockfiles.jsonl": 30,
  "base64-images.jsonl": 20,
  "test-vectors.jsonl": 15,
  "terminal.jsonl": 15,
  "code.txt": 40,
  "prose.txt": 20,
  "addresses.txt": 30,
};

/** The cases of one fixture file, each with the line it starts on. A `.jsonl` file is one `{"id","text"}` a line; a
 *  `.txt` file is cases each opened by a `### <id>` line and running to the next (the newline before it is not part of
 *  the case). */
function casesOf(file) {
  const body = readFileSync(join(DIR, file), "utf8");
  const lines = body.split("\n");
  const cases = [];
  if (file.endsWith(".jsonl")) {
    lines.forEach((line, at) => {
      if (!line.trim()) return;
      const parsed = JSON.parse(line);
      assert.equal(typeof parsed.id, "string", `${file}:${at + 1} has no string id`);
      assert.equal(typeof parsed.text, "string", `${file}:${at + 1} has no string text`);
      cases.push({ file, line: at + 1, id: parsed.id, text: parsed.text });
    });
  } else {
    let open;
    lines.forEach((line, at) => {
      const header = /^### (\S+)\s*$/.exec(line);
      if (header) {
        if (open) cases.push(open);
        open = { file, line: at + 1, id: header[1], body: [] };
      } else {
        assert.ok(open || !line.trim(), `${file}:${at + 1} is outside any case (a case opens with "### <id>")`);
        open?.body.push(line);
      }
    });
    if (open) cases.push(open);
    for (const c of cases) {
      if (c.body.at(-1) === "") c.body.pop();
      c.text = c.body.join("\n");
      delete c.body;
    }
  }
  return cases;
}

const files = readdirSync(DIR).filter((name) => /\.(jsonl|txt)$/.test(name)).sort();
const corpus = Object.fromEntries(files.map((file) => [file, casesOf(file)]));

/** A short, escaped view of a span of `text`, for a failure message. */
const excerpt = (text, start, end) => {
  const span = text.slice(start, end);
  return JSON.stringify(span.length > 80 ? `${span.slice(0, 77)}...` : span);
};

/** The fixture line a span starts on: a `.txt` case's own line for its text as written, else the case's line. */
const lineOf = (c, offset, form) => (c.file.endsWith(".txt") && !form ? c.line + 1 + (c.text.slice(0, offset).match(/\n/g)?.length ?? 0) : c.line);

/** Every way scrub cut or counted something in `text`, as lines naming the case, rule, kind and span. scrub may
 *  answer at once or with a promise; both are awaited. */
async function problemsOf(c, text, form) {
  const where = `${c.file}:${c.line} [${c.id}]${form ? ` (${form})` : ""}`;
  const at = (cut) => `${c.file}:${lineOf(c, cut.start, form)} [${c.id}]${form ? ` (${form})` : ""}`;
  const out = [];
  let counted;
  try {
    counted = await scrub(text, { mode: "count" });
  } catch (error) {
    return [`${where} count mode threw: ${error?.message ?? error}`];
  }
  for (const cut of counted.cuts ?? []) out.push(`${at(cut)} count: rule=${cut.rule} kind=${cut.kind} shape=${cut.shape} at ${cut.start}-${cut.end} ${excerpt(text, cut.start, cut.end)}`);
  const total = Object.values(counted.counts ?? {}).reduce((sum, n) => sum + n, 0);
  if (total > 0 && !(counted.cuts ?? []).length) out.push(`${where} count: counts ${JSON.stringify(counted.counts)} with no cut listed`);
  let result;
  try {
    result = await scrub(text, { mode: "cut" });
  } catch (error) {
    return [...out, `${where} cut mode threw: ${error?.message ?? error}`];
  }
  if (result.ok !== true) return [...out, `${where} cut: ok=${result.ok} (failed closed on a negative)`];
  if (!out.length) for (const cut of result.cuts ?? []) out.push(`${at(cut)} cut: rule=${cut.rule} kind=${cut.kind} shape=${cut.shape} at ${cut.start}-${cut.end} ${excerpt(text, cut.start, cut.end)}`);
  if (result.text !== text && !out.length) {
    let at = 0;
    while (at < text.length && text[at] === result.text[at]) at++;
    out.push(`${where} cut: text changed from offset ${at}: ${excerpt(text, at, at + 60)} became ${excerpt(result.text, at, at + 60)}`);
  }
  return out;
}

describe("the scrub-negatives corpus", () => {
  test("holds every category, none empty or thinned out", () => {
    for (const [file, fewest] of Object.entries(CATEGORIES)) {
      assert.ok(corpus[file], `${file} is missing from ${DIR}`);
      assert.ok(corpus[file].length >= fewest, `${file} holds ${corpus[file].length} cases, fewer than ${fewest}`);
    }
  });

  test("names each case once, and no case is empty", () => {
    for (const [file, cases] of Object.entries(corpus)) {
      const ids = new Set();
      for (const c of cases) {
        assert.ok(c.text.length > 0, `${file}:${c.line} [${c.id}] is empty`);
        assert.ok(!ids.has(c.id), `${file}:${c.line} repeats id ${c.id}`);
        ids.add(c.id);
      }
    }
  });

  test("stays modest in size (under 1 MB)", () => {
    const bytes = files.reduce((sum, file) => sum + readFileSync(join(DIR, file)).length, 0);
    assert.ok(bytes < 1_000_000, `the corpus is ${bytes} bytes`);
  });
});

describe("scrub", () => {
  test("has rules, and cuts a canary, so a zero below is not a no-op's", async () => {
    assert.ok(SCRUB_RULES.length > 0, "SCRUB_RULES is empty");
    // A GitHub classic token's shape, made here so no token-shaped literal sits in the repository.
    const canary = `token: ${"gh"}p_${"A1b2C3d4E5".repeat(4)}`;
    const counted = await scrub(canary, { mode: "count" });
    assert.ok(counted.cuts.length > 0, "scrub counted nothing in a ghp_ canary");
  });

  for (const file of files) {
    test(`cuts nothing in ${file}`, async () => {
      const problems = [];
      for (const c of corpus[file]) problems.push(...(await problemsOf(c, c.text, "")), ...(await problemsOf(c, JSON.stringify(c.text), "as a JSON string")));
      assert.equal(problems.length, 0, `${problems.length} cut(s) on known negatives:\n${problems.join("\n")}`);
    });
  }
});
