// A held value written in an encoding a writer emits, or split across strings with one: the whole-text check
// (redact/match.ts holds, through key-refusal.ts withheldWhole) withholds each, and the control written plainly elsewhere
// stays shown.
import assert from "node:assert/strict";
import { test } from "node:test";
import { redacted, withheldWhole } from "../dist/key-refusal.js";

test("a \"+\" after a held value's head, with a character reference or JSON written in a string, split across two strings, is withheld", () => {
  const held = ["abcdefgh"];
  for (const text of [
    '{"x":"abc&#100;+","y":"efgh"}',
    '{"body":"{\\"a\\":\\"abcd+\\",\\"b\\":\\"efgh\\"}"}',
  ]) assert.equal(withheldWhole(text, held), true, text);
  // Control: a visible separator between the halves is no spelling of the value.
  assert.equal(withheldWhole('{"x":"abc&#100;.","y":"efgh"}', held), false);
});

test("a numeric character reference with leading zeros, or with no closing \";\" (both read as the character by a browser), is read as its character", () => {
  const held = ["Azqwrtyp"];
  for (const spelled of ["&#00000000065;zqwrtyp", "&#x0000041;zqwrtyp", "&#65zqwrtyp", "&#x41zqwrtyp", "&#0065zqwrtyp"]) {
    assert.equal(withheldWhole(spelled, held), true, spelled);
    assert.equal(redacted(`see ${spelled} here`, held).includes("zqwrtyp"), false, spelled);
  }
  // Control: a reference past U+10FFFF stands for no character, so what follows it is no spelling of the value.
  assert.equal(withheldWhole("&#1114112zqwrtyp", held), false);
});

test("a held value an HTML escape wrote (&amp;, &lt;, &gt;, &quot;, &apos;) is read as written", () => {
  for (const [value, spelled] of [
    ["p&ss1234word", "p&amp;ss1234word"],
    ["a<b>c\"d'e1234", "a&lt;b&gt;c&quot;d&apos;e1234"],
    ["a<b>c\"d'e1234", "a&lt;b&gt;c&quot;d&#39;e1234"],
  ]) {
    assert.equal(withheldWhole(`see ${spelled} here`, [value]), true, spelled);
    assert.equal(redacted(`see ${spelled} here`, [value]).includes(spelled.slice(-6)), false, spelled);
  }
  // Control: an "&" before a word no escape writes (a URL's query) stays as it is.
  assert.equal(withheldWhole("see p&ampss1234word here", ["p&ss1234word"]), false);
});

test("a single-quoted dict (Python's repr) gets the join view: a held login reads across its name and value, a held value across two of its strings", () => {
  for (const [text, value] of [
    ["{'alice': 'secretpw'}", "alice:secretpw"],
    ["{'title': 'see abcd', 'snippet': 'efgh more'}", "abcdefgh"],
    [`{'a': 'say "hi" abcd', 'b': 'efgh'}`, "abcdefgh"],
  ]) {
    assert.equal(withheldWhole(text, [value]), true, text);
    assert.equal(redacted(text, [value]), "[redacted]", text);
  }
  // JSON's rules hold as they did: an apostrophe inside a "..." string is text, and one outside any string still reads
  // as part of the value beside it.
  assert.equal(withheldWhole(`{"a":"don't abcd","b":"efgh"}`, ["abcdefgh"]), true);
  assert.equal(withheldWhole(`"abcd" e'fgh`, ["abcde'fgh"]), true);
  // Control: another value under the held login's name is no spelling of it.
  assert.equal(withheldWhole("{'alice': 'other'}", ["alice:secretpw"]), false);
});

test("a single-quoted dict's strings read through Python's escapes: a held value with both quotes, its \\' escaped, split across two of them, is withheld", () => {
  for (const [text, value] of [
    [String.raw`{'a': 'ab\'cd"', 'b': 'efgh'}`, `ab'cd"efgh`],
    [String.raw`{'a': 'see ab\x27cd', 'b': 'efgh more'}`, "ab'cdefgh"],
    [String.raw`{'a': 'see a\\b\'cd', 'b': 'efgh'}`, String.raw`a\b'cdefgh`],
  ]) {
    assert.equal(withheldWhole(text, [value]), true, text);
    assert.equal(redacted(text, [value]), "[redacted]", text);
  }
  // Control: a single-quoted dict with an escaped apostrophe that holds no spelling of the value stays shown.
  assert.equal(withheldWhole(String.raw`{'a': 'it\'s ab', 'b': 'cd"efgh'}`, [`ab'cd"efgh`]), false);
});

test("a single-quoted dict written in a call's arguments (a JSON string's text) gets the quoted joins too, Python's escapes one level down", () => {
  // A call's arguments are read as JSON.stringify writes them, so a dict a model wrote in an argument is a JSON string's
  // text: its apostrophes as they are, its backslashes doubled.
  const [HEAD, REST] = [["Zq8V", "bN3x", "LmT6", "pR2w"].join(""), ["Yk9H", "sD4f", "Gj7A", "c5Ue"].join("")];
  for (const [args, value] of [
    [{ note: "{'alice': 'secretpw'}" }, "alice:secretpw"],
    [{ code: `d = {'a': 'see ${HEAD}', 'b': '${REST} more'}` }, `${HEAD}${REST}`],
    [{ code: String.raw`d = {'a': 'ab\'cd"', 'b': 'efgh'}` }, `ab'cd"efgh`],
    [{ code: String.raw`d = {'a': 'see ab\x41cd', 'b': 'efgh more'}` }, "abAcdefgh"],
  ]) assert.equal(withheldWhole(JSON.stringify(args), [value]), true, JSON.stringify(args));
  // Control: another value under the held login's name, in an argument, is no spelling of it.
  assert.equal(withheldWhole(JSON.stringify({ note: "{'alice': 'other'}" }), ["alice:secretpw"]), false);
});

test("a JSON string's text read again for a dict written in it is closed off from the text's own parts: no held value reads across the seam", () => {
  // Greptile's case: the values read again come after the values as they are, "abcd efgh" then "abcd efgh", and
  // "efgh abcd" is no spelling the text holds. And one string read again whose own end and first part read again
  // would join as "abcd efgh", where the text holds efgh before abcd.
  for (const text of ['{"don\'t":"abcd","x":"efgh"}', `{"x":"{'a': 'efgh'} abcd"}`]) {
    assert.equal(withheldWhole(text, [text.startsWith('{"don') ? "efghabcd" : "abcdefgh"]), false, text);
  }
});

test("the joins' separators still separate where the views drop control characters: a control at a part's edge, raw or escaped, reads no held value across a pass or across the two quoted joins", () => {
  // The same seams as above, each part's edge holding a control the views drop (raw, or JSON's \u escape): the
  // controls go, and each pass, and the quoted join and the again join, stay apart.
  for (const [nul, unit] of [["\u0000", "\u0001"], ["\\u0000", "\\u0001"]]) {
    for (const [text, value] of [
      [`{"don't":"${nul}abcd${unit}","x":"${unit}efgh${nul}"}`, "efghabcd"],
      [`{"x":"{'a': '${unit}efgh${nul}'} ${nul}abcd${unit}"}`, "abcdefgh"],
      // The values pass then the names pass: a value's end and the first name's start.
      [`{"abcd":"x","y":"z ${unit}efgh${nul}"}`, "efghabcd"],
    ]) assert.equal(withheldWhole(text, [value]), false, text);
  }
  // Control: the controls themselves are nothing inside one part, so a held value split by one there is withheld.
  assert.equal(withheldWhole(`{"x":"abcd\\u0000efgh"}`, ["abcdefgh"]), true);
  assert.equal(withheldWhole(`{'a': 'abcd\\x00efgh'}`, ["abcdefgh"]), true);
});

test("only a join's own separator separates: U+FFFF in a part's text, as it stands or escaped, is nothing, and the passes and the two quoted joins stay apart", () => {
  for (const sep of ["\uffff", "\\uffff"]) {
    // Inside one part, U+FFFF hides no held value.
    for (const text of [`{"x":"abcd${sep}efgh"}`, `{"x":"{'a': 'abcd${sep}efgh'}"}`, `abcd${sep}efgh`]) assert.equal(withheldWhole(text, ["abcdefgh"]), true, text);
    // At a part's edge it joins nothing across a seam: each pass, and the quoted and the again joins, stay apart.
    for (const [text, value] of [
      [`{"don't":"${sep}abcd${sep}","x":"${sep}efgh${sep}"}`, "efghabcd"],
      [`{"x":"{'a': '${sep}efgh${sep}'} ${sep}abcd${sep}"}`, "abcdefgh"],
      [`{"abcd":"x","y":"z ${sep}efgh${sep}"}`, "efghabcd"],
    ]) assert.equal(withheldWhole(text, [value]), false, text);
  }
});

test("a dict in a call's arguments with no Python escape is read through both levels of JSON's: \\\\t between a held value's halves", () => {
  // The source of a dict with a tab written "\t", in a JSON string: "\\t" on the wire, a tab two levels down. withheldWhole
  // reads the text as JSON only, never each argument string by itself.
  const code = (rest) => JSON.stringify({ code: String.raw`d = {'a': 'see HEAD', 'b': '${rest} more'}` });
  assert.equal(withheldWhole(code(String.raw`RE\tST`), ["HEADREST"]), true);
  assert.equal(withheldWhole(code(String.raw`RE\tSX`), ["HEADREST"]), false);
});

test("a dict in a call's arguments is read one level down through one level of escapes and through two: a backslash of its own, a quote next to \\\\'", () => {
  // A backslash the dict's writer left as it is ("C:\new" in a note): one level of escapes reads it, two would read a
  // newline. A quote in a Python string, written "\"" by JSON beside the "\\'" Python's escape gives.
  const note = JSON.stringify({ note: String.raw`{'p': 'see C:\new', 'q': 'rest more'}` });
  assert.equal(withheldWhole(note, [String.raw`C:\newrest`]), true);
  assert.equal(withheldWhole(note, [String.raw`C:\newrust`]), false);
  const code = JSON.stringify({ code: String.raw`d = {'a': 'see H"E\'AD', 'b': 'REST more'}` });
  assert.equal(withheldWhole(code, [`H"E'ADREST`]), true);
  assert.equal(withheldWhole(code, [`H"E'ADRUST`]), false);
});
