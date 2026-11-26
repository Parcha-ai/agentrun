// scan reads a line's fields from its bytes (src/scan.ts, wasm/scan.rs): for every line it is sure of, what JSON.parse
// of the decoded text gives, cut to the Shape; for every line JSON.parse rejects, or gives no object, nothing (the reader
// then parses it as before). Thousands of generated lines, each with the escapes, broken UTF-8, duplicate keys, wrong
// kinds and byte-level breakage a session file can hold, are read both ways, by scan alone and by the readers.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { lineReader } from "../dist/index.js";
import { claudeCodeLines } from "../dist/readers/claude-code.js";
import { codexLines } from "../dist/readers/codex.js";
import { fieldsOf, scan } from "../dist/scan.js";
import { anthropicUsage, at, claudeAnswer, claudeFile, claudeUser, codexAnswer, codexContext, codexFile, codexMeta, codexTokens, codexUser, openaiUsage, tempHome } from "./fixtures.mjs";

/** A seeded generator, so a failure is the same line on every run. */
function random(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n) => Math.floor(next() * n);
  return { next, int, pick: (list) => list[int(list.length)], chance: (p) => next() < p };
}

// A value as a line writes it, so a line can hold what JSON.stringify never writes: an object is a list of members
// (a key twice, a key escaped), a string a list of pieces (escapes JSON.stringify would not choose, raw bytes that are
// no UTF-8), a number its text.
const obj = (...members) => ({ members });
const str = (...pieces) => ({ pieces });
const num = (text) => ({ num: text });
const raw = (...bytes) => ({ raw: Buffer.from(bytes) });

const NUMBERS = ["0", "-0", "1", "-12", "3.25", "1e3", "1E+2", "-1.5e-7", "0.1", "123456789012345", "1234567890123456", "12345678901234567890", "1e400", "-1e400", "9007199254740993"];
const PIECES = ["a", "fixture", " ", "é", "€", "😀", " ", '"', "\\", "/", "\n", "\t", "\r", "\b", "\f", "\u0000", "\u001f", "\u007f", "}", "]", ",", ":", "{"];
const BROKEN = [[0xff], [0xfe], [0xe2, 0x82], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0x80], [0xc3]];
const SPACE = ["", "", "", " ", "  ", "\t", "\r", " \t "];

/** The UTF-8 bytes of `value` written as a line writes it, each choice of form drawn from `r`. */
function write(value, r, out = [], key = false) {
  const space = () => out.push(Buffer.from(r.pick(SPACE)));
  if (value === null || value === true || value === false) out.push(Buffer.from(String(value)));
  else if (typeof value === "number") out.push(Buffer.from(JSON.stringify(value)));
  else if (typeof value === "string") write(str(value), r, out);
  else if (Array.isArray(value)) {
    out.push(Buffer.from("["));
    value.forEach((v, k) => {
      if (k) out.push(Buffer.from(","));
      space();
      write(v, r, out);
      space();
    });
    out.push(Buffer.from("]"));
  } else if ("num" in value) out.push(Buffer.from(value.num));
  else if ("pieces" in value) {
    out.push(Buffer.from('"'));
    for (const piece of value.pieces) {
      if (typeof piece === "object") {
        out.push(piece.raw);
        continue;
      }
      for (const ch of piece) {
        const code = ch.codePointAt(0);
        const escaped = JSON.stringify(ch).slice(1, -1);
        // A key keeps its characters as they are where JSON lets it: scan leaves a key with an escape to JSON.parse.
        if (escaped !== ch || (!key && r.chance(0.08))) {
          // The escapes JSON has for it, drawn at random: its \u form (either case of hex), its short form, or \/ for /.
          const forms = [escaped];
          if (code < 0x10000) forms.push(`\\u${code.toString(16).padStart(4, "0")}`, `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`);
          else {
            const hi = 0xd800 + ((code - 0x10000) >> 10);
            const lo = 0xdc00 + ((code - 0x10000) & 0x3ff);
            forms.push(`\\u${hi.toString(16)}\\u${lo.toString(16)}`);
          }
          if (ch === "/") forms.push("\\/");
          const form = r.pick(forms);
          out.push(Buffer.from(form === ch && escaped !== ch ? escaped : form));
        } else out.push(Buffer.from(ch));
      }
    }
    out.push(Buffer.from('"'));
  } else if ("members" in value) {
    out.push(Buffer.from("{"));
    value.members.forEach(([key, v], k) => {
      if (k) out.push(Buffer.from(","));
      space();
      write(typeof key === "string" ? str(key) : key, r, out, true);
      space();
      out.push(Buffer.from(":"));
      space();
      write(v, r, out);
      space();
    });
    space();
    out.push(Buffer.from("}"));
  } else write(obj(...Object.entries(value)), r, out);
  return out;
}

/** A string drawn from `r`: pieces of every kind, sometimes long (past a 16-byte step), sometimes with broken UTF-8. */
function aString(r, broken = true) {
  const pieces = [];
  const n = r.pick([0, 1, 2, 3, 5, 14, 15, 16, 17, 31, 33, 200]);
  for (let k = 0; k < n; k += 1) pieces.push(broken && r.chance(0.03) ? raw(...r.pick(BROKEN)) : r.pick(PIECES));
  if (r.chance(0.02)) pieces.push("x".repeat(r.int(5000)));
  return str(...pieces);
}

/** A value drawn from `r`, at most `depth` deep. */
function aValue(r, depth) {
  const kind = r.int(depth > 0 ? 8 : 5);
  if (kind === 0) return r.pick([null, true, false]);
  if (kind === 1) return num(r.pick(NUMBERS));
  if (kind <= 3) return aString(r);
  if (kind === 4) return r.int(1000);
  if (kind === 5) return Array.from({ length: r.int(4) }, () => aValue(r, depth - 1));
  return obj(...Array.from({ length: r.int(4) }, () => [r.pick(["k", "type", "text", "id", "usage", "content", "x y", "é"]), aValue(r, depth - 1)]));
}

/** `value` nested `n` arrays deep. */
const deep = (n, value = 1) => {
  let v = value;
  for (let k = 0; k < n; k += 1) v = [v];
  return v;
};

/** The members of `record` with noise drawn from `r`: other kinds where a Shape reads one kind, keys twice, keys a line
 *  may only escape (scan leaves those to JSON.parse, and says so by `leaves`), keys no reader reads. */
function noisy(record, shape, r, leaves) {
  const members = [];
  for (const [key, value] of Object.entries(record)) {
    const rule = shape?.[key];
    let v = value;
    if (value !== null && typeof value === "object" && !Array.isArray(value) && !("num" in value || "pieces" in value || "members" in value)) v = noisy(value, rule === true ? undefined : rule, r, leaves);
    else if (Array.isArray(value) && Array.isArray(rule)) v = value.map((e) => (e !== null && typeof e === "object" && !Array.isArray(e) ? noisy(e, rule[0], r, leaves) : e));
    if (r.chance(0.04)) v = aValue(r, 2);
    if (r.chance(0.03)) members.push([key, aValue(r, 2)]);
    if (r.chance(0.01)) {
      members.push([str(raw(...Buffer.from(`\\u${key.charCodeAt(0).toString(16).padStart(4, "0")}`)), key.slice(1)), aValue(r, 1)]);
      leaves.escaped = true;
    }
    members.push([key, v]);
    if (r.chance(0.02)) members.push([key, aValue(r, 2)]);
    if (r.chance(0.15)) members.push([r.pick(["pad", "toolUseResult", "__proto__", "constructor", "input", "thinking", "é", ""]), aValue(r, 3)]);
  }
  if (r.chance(0.005)) {
    members.push(["nest", deep(1100)]);
    leaves.deep = true;
  }
  return obj(...members);
}

/** A line broken at one byte, drawn from `r`: a byte dropped, put in, changed, the line cut, garbage after it. */
function broken(line, r) {
  const at = r.int(line.length + 1);
  const b = Buffer.from([r.pick([0x22, 0x5c, 0x7b, 0x7d, 0x5b, 0x5d, 0x2c, 0x3a, 0x00, 0x09, 0x1f, 0x20, 0x75, 0x30, 0x2d, 0x2e, 0x65, 0x80, 0xff, 0x74, 0x6e])]);
  switch (r.int(6)) {
    case 0:
      return Buffer.concat([line.subarray(0, at), line.subarray(at + 1)]);
    case 1:
      return Buffer.concat([line.subarray(0, at), b, line.subarray(at)]);
    case 2:
      return Buffer.concat([line.subarray(0, at), b, line.subarray(at + 1)]);
    case 3:
      return line.subarray(0, at);
    case 4:
      return Buffer.concat([line, Buffer.from(r.pick([",", " x", "}", "]", "{}", "\u0000", "﻿"]))]);
    default:
      return Buffer.concat([Buffer.from(r.pick(["﻿", "[", " ", ","])), line]);
  }
}

/** Records as a source writes them, each drawn from `r`. */
const claudeRecords = (r) => {
  const usage = anthropicUsage(r.int(500), r.int(50), r.int(9000), r.int(900), r.chance(0.5) ? r.int(100) : undefined);
  const i = r.int(100);
  return r.pick([
    () => claudeUser({ uuid: `u${r.int(40)}`, text: aString(r), i }),
    () => claudeUser({ uuid: `u${r.int(40)}`, text: [{ type: "tool_result", tool_use_id: `toolu_${r.int(9)}`, content: aString(r), is_error: r.pick([true, false, aValue(r, 1)]) }], i }),
    () => claudeUser({ uuid: `u${r.int(40)}`, text: [{ type: "text", text: r.pick([aString(r), "[Request interrupted by user]"]) }], i }),
    () => claudeAnswer({ uuid: `a${r.int(40)}`, msg: `msg_${r.int(9)}`, req: `req_${r.int(9)}`, usage, i, block: { type: "text", text: aString(r) } }),
    () => claudeAnswer({ uuid: `a${r.int(40)}`, msg: `msg_${r.int(9)}`, req: r.chance(0.8) ? `req_${r.int(9)}` : undefined, usage, i, block: { type: "tool_use", id: `toolu_${r.int(9)}`, name: r.pick(["Bash", "Read", "Task"]), input: aValue(r, 3) } }),
    () => claudeAnswer({ uuid: `a${r.int(40)}`, msg: `msg_${r.int(9)}`, req: `req_${r.int(9)}`, usage, i, block: { type: "thinking", thinking: aString(r) }, model: r.pick(["claude-fixture-1", "<synthetic>"]) }),
    () => ({ ...claudeAnswer({ uuid: `a${r.int(40)}`, msg: `msg_${r.int(9)}`, req: `req_${r.int(9)}`, usage, i }), isApiErrorMessage: r.pick([true, false]), isSidechain: r.pick([true, false]) }),
    () => ({ type: "summary", summary: aString(r), leafUuid: `a${r.int(40)}` }),
    () => ({ type: "system", uuid: `s${r.int(40)}`, timestamp: at(i), isMeta: true, isCompactSummary: r.pick([true, false]), totalCostUSD: num(r.pick(NUMBERS)) }),
  ])();
};
const codexRecords = (r) => {
  const i = r.int(100);
  return r.pick([
    () => codexMeta(`thread-${r.int(3)}`, r.chance(0.2) ? "thread-0" : undefined),
    () => codexContext(i),
    () => codexUser(aString(r), i),
    () => codexAnswer(aString(r), i),
    () => ({ type: "response_item", timestamp: at(i), payload: { type: "function_call", call_id: `call_${r.int(9)}`, name: "shell", arguments: aString(r) } }),
    () => ({ type: "response_item", timestamp: at(i), payload: { type: "function_call_output", call_id: `call_${r.int(9)}`, output: aString(r) } }),
    () => ({ type: "response_item", timestamp: at(i), payload: { type: "reasoning", encrypted_content: aString(r), summary: [] } }),
    () => codexTokens(openaiUsage(r.int(900), r.int(400), r.int(90), r.int(9)), openaiUsage(r.int(9000), r.int(4000), r.int(900), r.int(90)), i),
    () => ({ type: "token_usage_record", timestamp: at(i), payload: { response_id: `resp_${r.int(9)}`, model: "gpt-fixture", usage: openaiUsage(r.int(900), r.int(400), r.int(90)) } }),
    () => ({ type: "event_msg", timestamp: at(i), payload: { type: "user_message", message: aString(r) } }),
  ])();
};

/** `count` lines of `source`'s records, as the source writes them or broken, each with what scan may leave. */
function lines(seed, count, records, shape, newlines) {
  const r = random(seed);
  const out = [];
  for (let k = 0; k < count; k += 1) {
    const leaves = {};
    let line = Buffer.concat(write(noisy(records(r), shape, r, leaves), r));
    if (r.chance(0.35)) {
      line = broken(line, r);
      leaves.broken = true;
    }
    if (r.chance(0.01)) line = Buffer.from(r.pick(["", " ", "[]", '"x"', "1", "null", "{}", "{ }"]));
    // A line in a file ends at its line feed: none inside one there.
    if (!newlines && line.includes(10)) line = Buffer.from(line.toString("latin1").replaceAll("\n", " "), "latin1");
    out.push({ line, leaves });
  }
  return out;
}

const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** What a reader reads of JSON.parse's object: `shape`'s fields alone, as scan gives them. */
function project(v, shape) {
  const out = {};
  for (const [key, rule] of Object.entries(shape)) {
    if (!Object.hasOwn(v, key)) continue;
    const x = v[key];
    if (rule === true) out[key] = x;
    else if (Array.isArray(rule)) out[key] = Array.isArray(x) ? x.map((e) => (plain(e) ? project(e, rule[0]) : e)) : x;
    else out[key] = plain(x) ? project(x, rule) : x;
  }
  return out;
}

for (const [name, spec, records] of [["Claude Code", claudeCodeLines, claudeRecords], ["Codex", codexLines, codexRecords]]) {
  test(`scan gives JSON.parse's fields of every line it reads, and none of a line JSON.parse rejects: ${name}`, () => {
    const shape = { ...spec.fields, timestamp: true };
    const fields = fieldsOf(shape);
    const tally = { read: 0, rejected: 0, left: 0 };
    for (const [n, { line, leaves }] of lines(name.length, 6000, records, shape, true).entries()) {
      let want;
      try {
        want = JSON.parse(line.toString("utf8"));
      } catch {
        want = undefined;
      }
      // The line inside a larger buffer, between bytes that would end it otherwise, half the time.
      const before = n % 2 ? Buffer.from('"}]\\') : Buffer.alloc(0);
      const b = Buffer.concat([before, line, Buffer.from(n % 2 ? '\\"0' : "")]);
      const got = scan(b, before.length, before.length + line.length, fields);
      const label = `line ${n}: ${line.toString("latin1").slice(0, 300)}`;
      if (!plain(want)) {
        assert.equal(got, undefined, label);
        tally.rejected += 1;
      } else if (got === undefined) {
        assert.ok(leaves.escaped || leaves.deep || leaves.broken, `left to JSON.parse with no escaped key or deep nesting: ${label}`);
        tally.left += 1;
      } else {
        assert.deepStrictEqual(got, project(want, shape), label);
        tally.read += 1;
      }
    }
    assert.ok(tally.read > 3000 && tally.rejected > 1000, JSON.stringify(tally));
  });

  test(`a totals read with the scan gives what one parsing every line gives: ${name}`, async (t) => {
    const home = await tempHome(t);
    const scanned = lineReader(spec);
    const parsed = lineReader({ ...spec, fields: undefined });
    for (let f = 0; f < 6; f += 1) {
      const file = name === "Codex" ? codexFile(home, `rollout-2026-01-01T00-00-0${f}-fixture.jsonl`) : claudeFile(home, `00000000-0000-4000-8000-00000000000${f}`);
      const body = lines(100 + f, 800, records, spec.fields, false).map(({ line }) => line);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, Buffer.concat(body.flatMap((line, k) => [line, Buffer.from(k % 7 === 3 ? "\r\n" : "\n")])));
      const options = { turns: false, totals: true };
      assert.deepStrictEqual(await scanned.read({ file }, undefined, { ...options }), await parsed.read({ file }, undefined, { ...options }), `file ${f}`);
    }
  });
}

test("a line too deep for the walk, or with an escaped key, is left to JSON.parse", () => {
  const fields = fieldsOf({ type: true, message: { id: true } });
  const left = ['{"type":"user","x":' + "[".repeat(1100) + "]".repeat(1100) + "}", '{"\\u0074ype":"user"}', '{"message":{"\\u0069d":"m"}}'];
  for (const text of left) assert.equal(scan(Buffer.from(text), 0, Buffer.byteLength(text), fields), undefined, text.slice(0, 40));
  // Nesting the walk takes, and an escaped key inside a value it skips (checked, never matched to a field).
  const read = '{"type":"user","x":' + "[".repeat(1000) + "]".repeat(1000) + ',"message":{"id":"m","x":{"\\u0069d":1}}}';
  assert.deepStrictEqual(scan(Buffer.from(read), 0, read.length, fields), { type: "user", message: { id: "m" } });
});
