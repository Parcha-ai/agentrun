// shell-lex.ts on its own: a command line read as words (their quoted, escaped and expanded parts), control operators
// and substitution bodies, with the three transcript readings (start at the caller's place, an unclosed construct is a
// character, `#` is a character) and a read count linear in the text. Word values are checked against bash through a
// fixture generated once (fixtures/shell-lex-words/generate.mjs), so this file runs no shell. Every input is synthetic.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isWord, lex, lexCount, NEST_MAX, wordChars, wordFrom, wordText } from "../dist/shell-lex.js";

const shellEnds = (op) => op === ";" || op === "&" || op === "&&" || op === "||" || op === "|" || op === "|&";
const curlEnds = (op) => op !== "&" && shellEnds(op);
const never = () => false;
const read = (text, { ends = shellEnds, from = 0, limit = text.length } = {}) => lex(text, from, limit, ends);
/** Each token as written, an operator as `<op>`. */
const shown = (text, lexed) => lexed.tokens.map((token) => (isWord(token) ? text.slice(token.start, token.end) : `<${token.op}>`));
const values = (text, lexed) => lexed.tokens.filter(isWord).map((word) => wordText(text, word));
const kinds = (word) => word.parts.map((part) => part.kind).join("+");
const subs = (text, lexed) => lexed.subs.map(([start, end]) => text.slice(start, end));

test("a command's words run to the first operator its caller ends on, or a line break", () => {
  const rows = [
    ["curl -u a:b; ls", shellEnds, ["curl", "-u", "a:b"], 11],
    ["a && b", shellEnds, ["a"], 2],
    ["a || b", shellEnds, ["a"], 2],
    ["a | b", shellEnds, ["a"], 2],
    ["a |& b", shellEnds, ["a"], 2],
    ["a & b", shellEnds, ["a"], 2],
    ["a b\nc", shellEnds, ["a", "b"], 3],
    // curl's caller reads on past a lone `&` (a URL's query), so it is a token, not an end.
    ["x?a=1&b=2 -u a:b", curlEnds, ["x?a=1", "<&>", "b=2", "-u", "a:b"], 16],
    ["x?a=1&b=2 -u a:b", shellEnds, ["x?a=1"], 5],
    ["a (b) c", shellEnds, ["a", "<(>", "b", "<)>", "c"], 7],
    // A redirection is a token of its own and its target the next word: neither ends the command.
    ["a >out 2>&1 <in b", shellEnds, ["a", "<redir>", "out", "2", "<redir>", "<redir>", "in", "b"], 17],
    ["a &>log b", shellEnds, ["a", "<redir>", "log", "b"], 9],
    ["", shellEnds, [], 0],
  ];
  for (const [text, ends, want, end] of rows) {
    const lexed = read(text, { ends });
    assert.deepEqual(shown(text, lexed), want, JSON.stringify(text));
    assert.equal(lexed.end, end, JSON.stringify(text));
  }
});

test("word values match bash's on the generated fixture: quotes, escapes, ANSI-C quoting, continuations", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/shell-lex-words/words.json", import.meta.url), "utf8"));
  assert.ok(fixture.lines.length >= 30);
  for (const { line, words } of fixture.lines) {
    const lexed = read(line, { ends: never });
    assert.ok(lexed.tokens.every(isWord), JSON.stringify(line));
    assert.deepEqual(values(line, lexed), words, JSON.stringify(line));
    // wordText's and wordFrom's plain-run paths give what wordChars gives.
    for (const word of lexed.tokens) {
      const chars = wordChars(line, word);
      assert.equal(wordText(line, word), chars.value);
      for (let skip = 0; skip <= chars.value.length; skip++) {
        const from = wordFrom(line, word, skip);
        if (skip === chars.value.length) assert.equal(from, undefined);
        else assert.deepEqual(from, { start: chars.start[skip], end: chars.end[chars.end.length - 1], kind: chars.kind[skip], length: chars.value.length });
      }
    }
  }
});

test("an operator inside quotes, a substitution, arithmetic or a parameter ends nothing", () => {
  const rows = [
    ["x 'a;b' \"c|d\" e\\;f", ["x", "'a;b'", '"c|d"', "e\\;f"], ["lit", "sq", "dq", "lit"], []],
    ["x $(a; b | c && d) y", ["x", "$(a; b | c && d)", "y"], ["lit", "sub", "lit"], ["a; b | c && d"]],
    ["x `a;b` y", ["x", "`a;b`", "y"], ["lit", "tick", "lit"], ["a;b"]],
    ["x <(a;b) >(c|d) y", ["x", "<(a;b)", ">(c|d)", "y"], ["lit", "proc", "proc", "lit"], ["a;b", "c|d"]],
    ["x $((1+(2)*3)) y", ["x", "$((1+(2)*3))", "y"], ["lit", "arith", "lit"], []],
    ['x ${a:-"b;c"} y', ["x", '${a:-"b;c"}', "y"], ["lit", "brace", "lit"], []],
    ['x $"a;b" y', ["x", '$"a;b"', "y"], ["lit", "dq", "lit"], []],
    // A nested substitution is read whole; only the outermost body is listed.
    ['x "$(a "$(b;c)" d)" y', ["x", '"$(a "$(b;c)" d)"', "y"], ["lit", "dq", "lit"], ['a "$(b;c)" d']],
    ["x pre$(a)post y", ["x", "pre$(a)post", "y"], ["lit", "lit+sub+lit", "lit"], ["a"]],
  ];
  for (const [text, want, wantKinds, wantSubs] of rows) {
    const lexed = read(text);
    assert.deepEqual(shown(text, lexed), want, text);
    assert.deepEqual(lexed.tokens.map(kinds), wantKinds, text);
    assert.deepEqual(subs(text, lexed), wantSubs, text);
  }
  const text = 'x "a ${b} $c `d` $(e)" y';
  const [, word] = read(text).tokens;
  assert.deepEqual(word.parts[0].inner.map((part) => part.kind), ["brace", "var", "tick", "sub"]);
  assert.equal(wordText(text, word), "a ${b} $c `d` $(e)");
  assert.equal(wordFrom(text, word, 2).kind, "brace");
});

test("a construct that does not close on its line or before the limit is a character, and reading goes on", () => {
  const rows = [
    ['x "a b', ["x", '"a', "b"]],
    ["x 'a b", ["x", "'a", "b"]],
    ["x $(a b", ["x", "$(a", "b"]],
    ["x `a b", ["x", "`a", "b"]],
    ["x $'a b", ["x", "$'a", "b"]],
    ["x ${a b", ["x", "${a", "b"]],
    ["x <(a b", ["x", "<(a", "b"]],
    // The line break that leaves it open ends the command.
    ['x "a\nb" c', ["x", '"a']],
    ["x $(a\nb) c", ["x", "$(a"]],
    // Read as a character, it quotes nothing: the operator after it is the shell's.
    ['x "a; b', ["x", '"a']],
    // An unclosed `$(` hides no `-u` after it (it used to end curl there).
    ['curl -H "X: $(date https://x.io -u a:b', ["curl", "-H", '"X:', "$(date", "https://x.io", "-u", "a:b"]],
  ];
  for (const [text, want] of rows) assert.deepEqual(shown(text, read(text)), want, JSON.stringify(text));
  // NEST_MAX deep is read; one deeper, the innermost opener is characters, so its `)` is left over (and ends nothing).
  const deep = (depth) => `x ${"$(".repeat(depth)}a${")".repeat(depth)} y`;
  const fits = read(deep(NEST_MAX));
  assert.deepEqual(shown(deep(NEST_MAX), fits), ["x", deep(NEST_MAX).slice(2, -2), "y"]);
  assert.equal(fits.tokens[1].parts[0].kind, "sub");
  const over = read(deep(NEST_MAX + 1));
  assert.deepEqual(shown(deep(NEST_MAX + 1), over), ["x", deep(NEST_MAX + 1).slice(2, -3), "<)>", "y"]);
  // `$((` that does not close as arithmetic is read as a substitution holding a subshell.
  const sub = read("x $((a) ) y");
  assert.equal(sub.tokens[1].parts[0].kind, "sub");
});

test("`#` is a character, a backslash-newline joins lines, and reading starts where the caller says", () => {
  assert.deepEqual(shown("x # -u a:b", read("x # -u a:b")), ["x", "#", "-u", "a:b"]);
  for (const text of ["-a \\\n  pw", "-a \\\r\n pw", "-a\\\n pw"]) assert.deepEqual(values(text, read(text)), ["-a", "pw"], JSON.stringify(text));
  assert.deepEqual(values("a\\\nb", read("a\\\nb")), ["ab"]);
  // A prose apostrophe before the command opens nothing: reading starts after its name.
  const text = "it's curl -u a:b";
  assert.deepEqual(shown(text, read(text, { from: 9 })), ["-u", "a:b"]);
});

test("a bare run the limit cuts is read on to its end; a quote the limit cuts is a character", () => {
  const run = read("x abcdefgh y", { limit: 5 });
  assert.deepEqual(shown("x abcdefgh y", run), ["x", "abcdefgh"]);
  assert.equal(run.end, 10);
  const quoted = read('x "abc def"', { limit: 6 });
  assert.deepEqual(shown('x "abc def"', quoted), ["x", '"abc']);
});

test("a word's value keeps where each character is written, and an expansion stands as written", () => {
  const text = "-u'a:b'\"c\"";
  const [word] = read(text).tokens;
  const chars = wordChars(text, word);
  assert.equal(chars.value, "-ua:bc");
  assert.deepEqual(chars.start, [0, 1, 3, 4, 5, 8]);
  assert.deepEqual(chars.kind, ["lit", "lit", "sq", "sq", "sq", "dq"]);
  assert.deepEqual(wordFrom(text, word, 4), { start: 5, end: 9, kind: "sq", length: 6 });
  const ansi = "$'\\x41b'";
  assert.deepEqual(wordFrom(ansi, read(ansi).tokens[0], 0), { start: 2, end: 7, kind: "ansi", length: 2 });
  const sub = '"a$(b)c"';
  const subWord = read(sub).tokens[0];
  assert.equal(wordText(sub, subWord), "a$(b)c");
  assert.equal(wordFrom(sub, subWord, 1).kind, "sub");
});

/** Each command named by `name` in `text` read as the scrubber reads it (secret-rules.ts commandsOf): from its name,
 *  at most `max` on, one Misses for the text, the next search after where the read stopped. The read count per
 *  character of the text, the reading stopped once it passes `bound` (so a super-linear reader fails fast). */
function readsPerChar(text, name, bound, max = 4096, ends = curlEnds) {
  const misses = new Map();
  const re = new RegExp(name, "g");
  lexCount.read = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const named = m.index + m[0].length;
    const lexed = lex(text, named, Math.min(text.length, named + max), ends, misses);
    for (const [start, end] of lexed.subs) lex(text, start, end, never, misses);
    re.lastIndex = Math.max(lexed.end, m.index + 1);
    if (lexCount.read > bound * text.length) break;
  }
  return lexCount.read / text.length;
}

test("reading is linear by count: 1 MB of nested, unclosed and repeated constructs reads each character at most 8 times", () => {
  const units = [
    // XCV's and XCII's adversarial commands.
    'curl -H "$(curl $(curl $(date)))" -u a:b ',
    'curl "$(',
    "curl $(((((( -u a:b ",
    "curl \x60 -u a:b ",
    'curl "\x60$(" -u a:b ',
    `mysql -u r -p'${"a&".repeat(300)}' db `,
    `redis-cli -a "${'\\"'.repeat(400)} `,
    `curl -u "u:${"p;".repeat(300)}" -H 'a`,
    "redis-cli '\"".repeat(40),
    `docker login -p "${"\\".repeat(500)}`,
    // A run of each opener left open.
    'curl "',
    "curl '",
    "curl $(",
    "curl \x60",
    "curl $'",
    "curl ${",
    "curl <(",
    "curl $((",
    "curl $( $( ",
    'curl "$(\x60',
  ];
  for (const unit of units) {
    const text = unit.repeat(Math.ceil(1_000_000 / unit.length));
    const perChar = readsPerChar(text, String.raw`\b(?:curl|redis-cli|mysql|login)\b`, 8);
    assert.ok(perChar <= 8, `${JSON.stringify(unit.slice(0, 24))}: ${perChar.toFixed(2)} reads a character`);
  }
  // A group that fails inside a group fails the groups around it at once (groupFail), instead of each reading on again.
  for (const unit of ["curl $( $( ", "curl <(", "curl $( -u a:b ", "curl >( $("]) {
    const perChar = readsPerChar(unit.repeat(Math.ceil(1_000_000 / unit.length)), String.raw`\bcurl\b`, 3);
    assert.ok(perChar <= 3, `${JSON.stringify(unit)}: ${perChar.toFixed(2)} reads a character`);
  }
});
