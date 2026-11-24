/**
 * A shell command line read as the shell reads it: words (their quoted, escaped and expanded parts), control
 * operators, redirections, and the bodies of command substitutions. It knows no secret rule; secret-rules.ts reads
 * argv from it (redis-cli, a registry login, mysql, npm set, curl).
 *
 * A transcript is not a script, so three readings differ from the shell's:
 * - Reading starts where the caller says (a command's name), never at the text's start: a prose apostrophe before it
 *   opens nothing.
 * - A construct that does not close on its line, before `limit`, or within NEST_MAX levels (a quote, `$(`, a backtick,
 *   `${`, `$((`, `<(`) is a character, and reading goes on after it: unknown never ends a command early.
 * - `#` is a character: a comment is still text that can hold a secret.
 *
 * Linear by count: `lexCount.read` counts each character a search reads. A search for a construct's closer that fails
 * is remembered (Misses), so a later opener of that kind inside the span it read fails at once, without reading it
 * again (it would read the same characters, paired the same; failing reads on, so it never ends a command earlier).
 * A flat search (a single quote, `$'`, a backtick, `$((`) reads its whole span alike, so that always holds. A nested
 * one (a double quote, `${`, a group) pairs quotes inside its span, so it holds only for an opener the read saw as one
 * and that did not close. One that closed (`$(b)` in `$(a $(b) c`), or that the failed read took as quoted text
 * (`$(c)` in `$(a 'b $(c) d'`, read again from a command named inside the quotes), is searched again.
 * Callers read a command to commandLimit, which the commands named in one stretch share, so a search that failed at
 * the limit is not read again by the next command (`curl $(a; curl $(a; …`).
 */

export type PartKind = "lit" | "sq" | "dq" | "ansi" | "sub" | "tick" | "var" | "brace" | "arith" | "proc";
/** A span of a word as written. A double-quoted part lists the expansions inside it. */
export type Part = { readonly kind: PartKind; readonly start: number; readonly end: number; readonly inner?: readonly Part[] };
export type Word = { readonly start: number; readonly end: number; readonly parts: readonly Part[] };
/** A control operator (`;`, `&`, `&&`, `|`, `||`, `|&`, a line break, `(`, `)`) or a redirection ("redir"). */
export type Op = { readonly op: string; readonly start: number; readonly end: number };
export type Token = Word | Op;
export const isWord = (token: Token): token is Word => "parts" in token;

/** The limit of a command named at `named`: `max` characters past the end of its stretch of `2 * max`, never past `to`.
 *  Every command named in one stretch shares it, and each reads at least `max` characters on and at most three times
 *  that. */
export function commandLimit(named: number, max: number, to: number): number {
  const stretch = 2 * max;
  return Math.min(to, (Math.floor(named / stretch) + 1) * stretch + max);
}

/** What lex read: its tokens to the first operator `ends` accepts (not included), where it stopped, and the body spans
 *  of the command substitutions (`$(…)`, backticks, `<(…)`, `>(…)`) in its words, nested ones not listed. */
export type Lexed = { readonly tokens: readonly Token[]; readonly end: number; readonly subs: readonly (readonly [number, number])[] };

/** Characters read by lex and its closer searches: the counted guard's measure (shell-lex.test.mjs). */
export const lexCount = { read: 0 };

/** How deep constructs nest before the next one is read as a character. */
export const NEST_MAX = 4;

type Miss = { readonly from: number; readonly to: number; readonly limit: number };
/** A failed closer search per construct kind: an opener of that kind in [from, to) fails without a search, unless
 *  the search that failed stopped at a limit nearer than this one's. Shared by every lex over one text. */
export type Misses = Map<string, Miss>;
/** The kinds whose closer search reads its span flat, pairing nothing inside it. */
const FLAT = new Set(["sq", "ansi", "tick", "arith"]);
/** The openers each Misses' reads saw as openers, true once one closed: only one seen and not closed fails from a span
 *  (a quote that hid it from the failed read, or a group around it that failed where it closed, says nothing of it). */
const seenOf = new WeakMap<Misses, Map<number, boolean>>();

/** Character codes the reader looks at; END is past the limit. */
const END = -1;
const TAB = 9, NL = 10, CR = 13, SP = 32, DQ = 34, DOLLAR = 36, AMP = 38, SQ = 39, LP = 40, RP = 41, SEMI = 59;
const LT = 60, GT = 62, BS = 92, BT = 96, LB = 123, PIPE = 124, RB = 125, MINUS = 45;

/** ASCII classes, one bit each (a table, not a regex per character: the reader is the scrubber's hot loop). */
const BLANK = 1, OPERATOR = 2, NAME_START = 4, NAME_CHAR = 8, SPECIAL_VAR = 16, RUN_STOP = 32, DIGIT = 64;
const CLASS = new Uint8Array(128);
const mark = (chars: string, bit: number): void => {
  for (let k = 0; k < chars.length; k++) CLASS[chars.charCodeAt(k)]! |= bit;
};
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
mark(" \t", BLANK);
mark(";&|()<>\n", OPERATOR);
mark(`${LETTERS}_`, NAME_START);
mark(`${LETTERS}_0123456789`, NAME_CHAR);
mark("0123456789?$!#@*-", SPECIAL_VAR);
/** Where a bare run a limit cut reads on to: a blank, an operator or a quote. */
mark(" \t\n\r\v\f;&|()<>'\"\x60", RUN_STOP);
mark("0123456789", DIGIT);
const is = (c: number, bit: number): boolean => c >= 0 && c < 128 && (CLASS[c]! & bit) !== 0;
/** A non-ASCII blank also ends a cut run (as `\s` reads it). */
const WIDE_SPACE = /\s/;
const HEX_ESCAPE = /^[0-9A-Fa-f]{1,2}/;
const OCTAL_ESCAPE = /^[0-7]{1,3}/;
const OCTAL_DIGIT = /[0-7]/;

class Reader {
  constructor(
    readonly text: string,
    readonly limit: number,
    readonly misses: Misses,
  ) {
    let seen = seenOf.get(misses);
    if (!seen) seenOf.set(misses, (seen = new Map()));
    this.seen = seen;
  }

  private readonly seen: Map<number, boolean>;

  /** Where the last group (`$(`, `<(`, `>(`) that failed stopped, until a token stream outside any group reads past
   *  it: a group whose own tokens hold a group that failed fails there too (it reads the same characters from the
   *  same place, the failed one's `(` one level deeper), so its search ends at once instead of reading them again. */
  groupFail = -1;

  private at(i: number): number {
    return i < this.limit ? this.text.charCodeAt(i) : END;
  }

  /** Whether the opener at `open` fails without a search. A flat search (a single quote, `$'`, a backtick, `$((`)
   *  reads every character of its span alike, so the span decides. A nested one (`"`, `${`, a group) can hold an
   *  opener in its quotes that it never read as one: that opener is searched until a read has seen it. */
  private missed(kind: string, open: number): boolean {
    const miss = this.misses.get(kind);
    const inSpan = miss !== undefined && miss.from <= open && open < miss.to && miss.limit >= Math.min(this.limit, miss.to + 1);
    const seen = this.seen.get(open);
    if (FLAT.has(kind)) return inSpan && seen !== true;
    if (seen === undefined) {
      this.seen.set(open, false);
      return false;
    }
    return !seen && inSpan;
  }

  /** `end`, the index past the closer of the construct at `open`, remembered as closed. */
  private closes(open: number, end: number): number {
    this.seen.set(open, true);
    return end;
  }

  private fail(kind: string, open: number, to: number): -1 {
    // It closed at another depth, if ever: from here on the span decides.
    this.seen.set(open, false);
    const miss = this.misses.get(kind);
    // Keep the wider span: a nested search fails first, inside the one around it.
    if (!(miss && miss.from <= open && miss.to >= to && miss.limit >= this.limit)) this.misses.set(kind, { from: open, to, limit: this.limit });
    return -1;
  }

  /** Where the single quote at `open` closes (the index past it), or -1. */
  single(open: number): number {
    if (this.missed("sq", open)) return -1;
    for (let i = open + 1; ; i++) {
      lexCount.read++;
      const c = this.at(i);
      if (c === SQ) return i + 1;
      if (c === END || c === NL) return this.fail("sq", open, i);
    }
  }

  /** `$'…'` from its `$`: a backslash escapes the next character. */
  ansi(open: number): number {
    if (this.missed("ansi", open)) return -1;
    for (let i = open + 2; ; i++) {
      lexCount.read++;
      const c = this.at(i);
      if (c === SQ) return i + 1;
      if (c === END || c === NL) return this.fail("ansi", open, i);
      if (c === BS) i++;
    }
  }

  /** A double-quoted part from its first quote (`"` at `quote`, `open` its start: `$"` starts one before): the index
   *  past its closer, or -1; `inner` gets its expansions. */
  double(open: number, quote: number, nest: number, inner: Part[]): number {
    if (this.missed("dq", open)) return -1;
    for (let i = quote + 1; ; ) {
      lexCount.read++;
      const c = this.at(i);
      if (c === DQ) return this.closes(open, i + 1);
      if (c === END || c === NL) return this.fail("dq", open, i);
      if (c === BS) {
        i += this.at(i + 1) === END ? 1 : 2;
        continue;
      }
      if (c === DOLLAR || c === BT) {
        const part = this.expansion(i, nest, false);
        this.groupFail = -1;
        if (part) {
          inner.push(part);
          i = part.end;
          continue;
        }
      }
      i++;
    }
  }

  /** The expansion opening at `i` (`$…` or a backtick), or undefined when there is none or it does not close.
   *  `quotes`: `$'` and `$"` open quotes here (not inside double quotes). */
  expansion(i: number, nest: number, quotes: boolean, subs?: [number, number][]): Part | undefined {
    const c = this.at(i);
    if (c === BT) {
      const end = this.tick(i);
      if (end < 0) return undefined;
      subs?.push([i + 1, end - 1]);
      return { kind: "tick", start: i, end };
    }
    if (c !== DOLLAR) return undefined;
    const d = this.at(i + 1);
    if (d === LP) {
      if (this.at(i + 2) === LP) {
        const end = this.arith(i);
        if (end >= 0) return { kind: "arith", start: i, end };
      }
      const end = this.group(i, i + 1, nest, "sub");
      if (end < 0) return undefined;
      subs?.push([i + 2, end - 1]);
      return { kind: "sub", start: i, end };
    }
    if (d === LB) {
      const end = this.brace(i, nest);
      return end < 0 ? undefined : { kind: "brace", start: i, end };
    }
    if (quotes && d === SQ) {
      const end = this.ansi(i);
      return end < 0 ? undefined : { kind: "ansi", start: i, end };
    }
    if (quotes && d === DQ) {
      const inner: Part[] = [];
      const end = this.double(i, i + 1, nest, inner);
      return end < 0 ? undefined : { kind: "dq", start: i, end, inner };
    }
    if (is(d, NAME_START)) {
      let end = i + 2;
      while (is(this.at(end), NAME_CHAR)) {
        lexCount.read++;
        end++;
      }
      return { kind: "var", start: i, end };
    }
    if (is(d, SPECIAL_VAR)) return { kind: "var", start: i, end: i + 2 };
    return undefined;
  }

  /** A backtick substitution from its opener: the index past its closer, or -1. */
  tick(open: number): number {
    if (this.missed("tick", open)) return -1;
    for (let i = open + 1; ; i++) {
      lexCount.read++;
      const c = this.at(i);
      if (c === BT) return i + 1;
      if (c === END || c === NL) return this.fail("tick", open, i);
      if (c === BS) i++;
    }
  }

  /** `${…}` from its `$`: to the `}` that closes it, quotes and nested expansions read whole. */
  brace(open: number, nest: number): number {
    if (this.missed("brace", open) || nest >= NEST_MAX) return -1;
    for (let i = open + 2; ; ) {
      lexCount.read++;
      const c = this.at(i);
      if (c === RB) return this.closes(open, i + 1);
      if (c === END || c === NL) return this.fail("brace", open, i);
      const end = this.quoted(i, nest + 1);
      if (end > 0) {
        i = end;
        continue;
      }
      i += c === BS ? 2 : 1;
    }
  }

  /** `$((…))` from its `$`: to the `))` that brings its parentheses back to none. Only parentheses are counted:
   *  arithmetic holds no quote or substitution worth pairing, and a search that reads nothing nested fails once. */
  arith(open: number): number {
    if (this.missed("arith", open)) return -1;
    let depth = 0;
    for (let i = open + 1; ; i++) {
      lexCount.read++;
      const c = this.at(i);
      if (c === END || c === NL) return this.fail("arith", open, i);
      if (c === LP) depth++;
      else if (c === RP && --depth === 0) return this.at(i - 1) === RP ? i + 1 : this.fail("arith", open, i);
    }
  }

  private groupFailed(result: -1, at: number): -1 {
    this.groupFail = at;
    return result;
  }

  /** A quote or expansion at `i` read whole: the index past it, or 0 when there is none there. */
  private quoted(i: number, nest: number): number {
    const c = this.at(i);
    if (c === SQ) return Math.max(this.single(i), 0);
    if (c === DQ) return Math.max(this.double(i, i, nest, []), 0);
    if (c === DOLLAR || c === BT) {
      const end = this.expansion(i, nest, true)?.end ?? 0;
      this.groupFail = -1;
      return end;
    }
    return 0;
  }

  /** A command list in parentheses (`$(`, `<(`, `>(`: `paren` is the `(`), read as tokens to the `)` that closes it:
   *  the index past it, or -1. */
  group(open: number, paren: number, nest: number, kind: string): number {
    if (this.missed(kind, open) || nest >= NEST_MAX) return -1;
    let depth = 0;
    let i = paren + 1;
    while (true) {
      const token = this.token(i, nest + 1);
      if (this.groupFail >= 0) return this.fail(kind, open, this.groupFail);
      if (!token) return this.groupFailed(this.fail(kind, open, Math.min(i, this.limit)), Math.min(i, this.limit));
      if ("op" in token) {
        if (token.op === "\n") return this.groupFailed(this.fail(kind, open, token.start), token.start);
        if (token.op === "(") depth++;
        else if (token.op === ")") {
          if (depth === 0) return this.closes(open, token.end);
          depth--;
        }
      }
      i = token.end;
    }
  }

  /** The token at or after `i` (blanks skipped), or undefined at the limit. `subs` gets the substitutions of a word. */
  token(i: number, nest: number, subs?: [number, number][]): Token | undefined {
    let c = this.at(i);
    // Blanks, and a backslash-newline between words (a continuation joins the lines and leaves no word).
    while (true) {
      if (c === SP || c === TAB) i++;
      else if (c === BS && this.at(i + 1) === NL) i += 2;
      else if (c === BS && this.at(i + 1) === CR && this.at(i + 2) === NL) i += 3;
      else break;
      lexCount.read++;
      c = this.at(i);
    }
    if (c === END) return undefined;
    lexCount.read++;
    const d = this.at(i + 1);
    if (c === NL) return { op: "\n", start: i, end: i + 1 };
    if (c === SEMI) return { op: ";", start: i, end: i + 1 };
    if (c === LP) return { op: "(", start: i, end: i + 1 };
    if (c === RP) return { op: ")", start: i, end: i + 1 };
    if (c === AMP) {
      if (d === AMP) return { op: "&&", start: i, end: i + 2 };
      if (d === GT) return this.redirection(i, i + 1);
      return { op: "&", start: i, end: i + 1 };
    }
    if (c === PIPE) {
      if (d === PIPE) return { op: "||", start: i, end: i + 2 };
      if (d === AMP) return { op: "|&", start: i, end: i + 2 };
      return { op: "|", start: i, end: i + 1 };
    }
    if ((c === LT || c === GT) && d !== LP) return this.redirection(i, i);
    return this.word(i, nest, subs);
  }

  /** A redirection from `start` (its `<`/`>` run at `from`): `>`, `>>`, `<<`, `<<<`, `<>`, `>|`, `&>`, `&>>`, with a
   *  `&` and a descriptor or `-` after (`2>&1`, `<&-`). Its target is the next word. */
  private redirection(start: number, from: number): Op {
    let i = from;
    while ((this.at(i) === LT || this.at(i) === GT) && i - from < 3) i++;
    if (this.at(i) === PIPE) i++;
    else if (this.at(i) === AMP && (this.at(i + 1) === MINUS || is(this.at(i + 1), DIGIT))) {
      i += 2;
      while (is(this.at(i), DIGIT)) i++;
    }
    lexCount.read += i - start;
    return { op: "redir", start, end: i };
  }

  /** The word at `start`: to a blank, an operator, a line break or the limit. */
  private word(start: number, nest: number, subs?: [number, number][]): Word {
    const parts: Part[] = [];
    let lit = -1;
    let i = start;
    while (i < this.limit) {
      const c = this.text.charCodeAt(i);
      if (c < 128 && (CLASS[c]! & (BLANK | OPERATOR)) !== 0 && !((c === LT || c === GT) && this.at(i + 1) === LP)) break;
      lexCount.read++;
      let part: Part | undefined;
      if (c === BS) {
        // A backslash escapes the next character; before a line break it joins the lines.
        if (lit < 0) lit = i;
        const e = this.at(i + 1);
        i += e === END ? 1 : e === CR && this.at(i + 2) === NL ? 3 : 2;
        continue;
      }
      if (c === SQ) {
        const end = this.single(i);
        if (end > 0) part = { kind: "sq", start: i, end };
      } else if (c === DQ) {
        const inner: Part[] = [];
        const end = this.double(i, i, nest, inner);
        if (end > 0) part = { kind: "dq", start: i, end, inner };
        if (part && subs) for (const p of inner) if (p.kind === "sub" || p.kind === "tick") subs.push(p.kind === "sub" ? [p.start + 2, p.end - 1] : [p.start + 1, p.end - 1]);
      } else if (c === DOLLAR || c === BT) {
        part = this.expansion(i, nest, true, subs);
      } else if (c === LT || c === GT) {
        const end = this.group(i, i + 1, nest, "proc");
        if (end > 0) {
          part = { kind: "proc", start: i, end };
          subs?.push([i + 2, end - 1]);
        }
      }
      if (part) {
        if (lit >= 0) parts.push({ kind: "lit", start: lit, end: i });
        lit = -1;
        parts.push(part);
        i = part.end;
      } else {
        // A construct that did not close is a character, its whole opener (`$(`, `$((`, `<(`) one run with it.
        if (lit < 0) lit = i;
        i += this.at(i + 1) !== LP || (c !== DOLLAR && c !== LT && c !== GT) ? 1 : this.at(i + 2) === LP && c === DOLLAR ? 3 : 2;
      }
    }
    if (lit >= 0 && i > lit) parts.push({ kind: "lit", start: lit, end: i });
    return { start, end: i, parts };
  }
}

/** The tokens of the command reading from `from`, to the first operator `ends` accepts, a line break, or `limit`.
 *  A bare run the limit cuts is read on to its end, so a long value is whole. */
export function lex(text: string, from: number, limit: number, ends: (op: string) => boolean, misses: Misses = new Map()): Lexed {
  const reader = new Reader(text, Math.min(limit, text.length), misses);
  const tokens: Token[] = [];
  const subs: [number, number][] = [];
  let at = from;
  while (true) {
    const token = reader.token(at, 0, subs);
    reader.groupFail = -1;
    if (!token) break;
    if ("op" in token && (token.op === "\n" || ends(token.op))) return { tokens, end: token.start, subs };
    tokens.push(token);
    at = token.end;
  }
  const last = tokens[tokens.length - 1];
  if (last && "parts" in last && last.end === reader.limit && reader.limit < text.length) {
    let end = last.end;
    for (; end < text.length; end++) {
      const c = text.charCodeAt(end);
      if (c < 128 ? (CLASS[c]! & RUN_STOP) !== 0 : WIDE_SPACE.test(text.charAt(end))) break;
      lexCount.read++;
    }
    if (end > last.end) {
      tokens[tokens.length - 1] = { start: last.start, end, parts: [...last.parts, { kind: "lit", start: last.end, end }] };
      return { tokens, end, subs };
    }
  }
  return { tokens, end: Math.max(at, Math.min(reader.limit, text.length)), subs };
}

/** A word written as one plain run with no backslash: its text is its value. */
function plain(text: string, word: Word): string | undefined {
  const only = word.parts.length === 1 ? word.parts[0]! : undefined;
  if (only?.kind !== "lit") return undefined;
  const raw = text.slice(only.start, only.end);
  return raw.includes("\\") ? undefined : raw;
}

/** A word's value (wordChars' `value`) without the places: a single-quoted part or an expansion is its text, a part
 *  with escapes is read by wordChars. */
export function wordText(text: string, word: Word): string {
  let value = "";
  for (const part of word.parts) {
    if (part.kind === "sq") value += text.slice(part.start + 1, part.end - 1);
    else if (part.kind === "dq" || part.kind === "ansi") return wordChars(text, word).value;
    else {
      const raw = text.slice(part.start, part.end);
      if (part.kind === "lit" && raw.includes("\\")) return wordChars(text, word).value;
      value += raw;
    }
  }
  return value;
}

/** Where a word's value from its `skip`th character on is written (the first one's start and kind, the last one's
 *  end) and how long the whole value is, or undefined when it has no character there. */
export function wordFrom(text: string, word: Word, skip: number): { start: number; end: number; kind: PartKind; length: number } | undefined {
  const raw = plain(text, word);
  if (raw !== undefined) return skip < raw.length ? { start: word.start + skip, end: word.end, kind: "lit", length: raw.length } : undefined;
  const chars = wordChars(text, word);
  return skip < chars.value.length ? { start: chars.start[skip]!, end: chars.end[chars.end.length - 1]!, kind: chars.kind[skip]!, length: chars.value.length } : undefined;
}

const ANSI: Readonly<Record<string, string>> = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };

/** A word's characters as the shell gives them to its command, each with its place as written. An expansion's
 *  characters stand as written, with its kind. */
export type WordChars = { readonly value: string; readonly start: readonly number[]; readonly end: readonly number[]; readonly kind: readonly PartKind[] };

export function wordChars(text: string, word: Word): WordChars {
  let value = "";
  const start: number[] = [];
  const end: number[] = [];
  const kind: PartKind[] = [];
  const put = (ch: string, from: number, to: number, k: PartKind) => {
    value += ch;
    start.push(from);
    end.push(to);
    kind.push(k);
  };
  const raw = (from: number, to: number, k: PartKind) => {
    for (let i = from; i < to; i++) put(text.charAt(i), i, i + 1, k);
  };
  for (const part of word.parts) {
    const { start: s, end: e } = part;
    if (part.kind === "lit") {
      for (let i = s; i < e; i++) {
        const c = text.charAt(i);
        if (c !== "\\" || i + 1 >= e) {
          put(c, i, i + 1, "lit");
          continue;
        }
        const d = text.charAt(i + 1);
        if (d === "\n") i++;
        else if (d === "\r" && text.charAt(i + 2) === "\n") i += 2;
        else {
          put(d, i, i + 2, "lit");
          i++;
        }
      }
    } else if (part.kind === "sq") raw(s + 1, e - 1, "sq");
    else if (part.kind === "dq") {
      const open = text.charAt(s) === "$" ? s + 2 : s + 1;
      const inner = part.inner ?? [];
      let next = 0;
      for (let i = open; i < e - 1; i++) {
        const sub = inner[next];
        if (sub && sub.start === i) {
          raw(sub.start, sub.end, sub.kind);
          i = sub.end - 1;
          next++;
          continue;
        }
        const c = text.charAt(i);
        const d = text.charAt(i + 1);
        if (c === "\\" && (d === "$" || d === "\x60" || d === '"' || d === "\\")) {
          put(d, i, i + 2, "dq");
          i++;
        } else if (c === "\\" && d === "\n") i++;
        else put(c, i, i + 1, "dq");
      }
    } else if (part.kind === "ansi") {
      for (let i = s + 2; i < e - 1; i++) {
        const c = text.charAt(i);
        if (c !== "\\") {
          put(c, i, i + 1, "ansi");
          continue;
        }
        const d = text.charAt(i + 1);
        const hex = d === "x" ? HEX_ESCAPE.exec(text.slice(i + 2, Math.min(i + 4, e - 1))) : null;
        const octal = OCTAL_DIGIT.test(d) ? OCTAL_ESCAPE.exec(text.slice(i + 1, Math.min(i + 4, e - 1))) : null;
        if (hex) {
          put(String.fromCharCode(parseInt(hex[0], 16)), i, i + 2 + hex[0].length, "ansi");
          i += 1 + hex[0].length;
        } else if (octal) {
          put(String.fromCharCode(parseInt(octal[0], 8) & 0xff), i, i + 1 + octal[0].length, "ansi");
          i += octal[0].length;
        } else if (d in ANSI) {
          put(ANSI[d]!, i, i + 2, "ansi");
          i++;
        } else {
          put(c, i, i + 1, "ansi");
        }
      }
    } else raw(s, e, part.kind);
  }
  return { value, start, end, kind };
}
