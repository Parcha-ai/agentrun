// o200k_base, the tokenizer OpenAI publishes for its models from gpt-4o on, for counting only. Written for AgentRun, from
// two MIT-licensed sources whose notices are in vendor/o200k/LICENSE:
//  - the vocabulary is OpenAI's own file, byte for byte (vendor/o200k/o200k_base.tiktoken, `O200K_SHA256`), the one
//    tiktoken loads and pins by that hash (o200k_base in
//    https://github.com/openai/tiktoken/blob/79dc2c0533685b893616c78160b5d9e40876e724/tiktoken_ext/openai_public.py),
//    Copyright (c) 2022 OpenAI, Shantanu Jain;
//  - the split is tiktoken's o200k_base pattern as gpt-tokenizer spells it for JavaScript's regular expressions
//    (O200K_TOKEN_SPLIT_REGEX's native form in
//    https://github.com/niieani/gpt-tokenizer/blob/785c2695acbda31ae31ef8ab6343bcd7f1dde72f/src/encodingParams/constants.ts),
//    Copyright (c) 2023-2024 Bazyli Brzoska: `(?i:'s|...)` as a character class per letter, `ſ` among them, and `\s` as
//    Unicode's White_Space, which tiktoken's regex reads and JavaScript's `\s` does not (U+0085, U+FEFF).
// Each piece the split finds is one token when the vocabulary holds its bytes, else its bytes are merged by tiktoken's
// byte-pair rule: the adjacent pair of lowest rank first, the leftmost on a tie, until no pair is in the vocabulary
// (taken off a min-heap, as gpt-tokenizer does, so a long piece is never rescanned after each merge). The count is the
// pieces' tokens. It counts what gpt-tokenizer 4.1.2's o200k_base `countTokens` counted with no special token allowed,
// which this replaces: that package is 31 MB of encodings, chat formats and price tables, and only this was used.
// tiktoken's letter and number classes are Unicode 16's. Node 24 knows Unicode 17, which made letters and numbers of some
// characters that were neither: on a text that holds one, the split takes them out of the engine's classes again, as
// gpt-tokenizer does (its UNICODE_17_TO_16 ranges), so the count is Unicode 16's; any other text takes the plain classes,
// which are faster. An engine of another Unicode takes its own classes: a character it classes otherwise moves a split
// around it, by a token or so, which the local count's margin covers.
import { readFile } from "node:fs/promises";

/** OpenAI's o200k_base vocabulary, as tiktoken loads it: each token's bytes in base64 and its rank, a line each. */
export const O200K_VOCABULARY = new URL("../../vendor/o200k/o200k_base.tiktoken", import.meta.url);
/** The vocabulary file's sha256, as tiktoken pins it (`expected_hash`). */
export const O200K_SHA256 = "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d";

/** Model ids, as a session or a gateway names them (`openai/gpt-6.1-sol`), whose tokenizer is o200k_base: gpt-4o, gpt-4.1,
 *  gpt-4.5, gpt-5 and later, chatgpt-4o, the o-series, codex- and gpt-oss models. gpt-3.5 and gpt-4 (cl100k_base) are
 *  not, nor any other vendor's model: o200k_base can undercount them. */
const O200K_MODEL = /^(?:openai\/)?(?:gpt-(?:4o|4\.1|4\.5|[5-9]|[1-9]\d)|chatgpt-4o|o[1-9](?:-|$)|codex-|gpt-oss-)/i;

/** Whether `model` (a body's `model`) is one o200k_base counts (`O200K_MODEL`). */
export function o200kModel(model: unknown): boolean {
  return typeof model === "string" && O200K_MODEL.test(model);
}

const CONTRACTION = String.raw`(?:'(?:[sSſ]|[dD]|[mM]|[tT]|[lL][lL]|[vV][eE]|[rR][eE]))?`;
/** tiktoken's o200k_base split, in JavaScript's spelling, over the classes given (each the inside of a character class). */
const splitOf = (letter: string, number: string, upper: string, lower: string, flags: string): RegExp => new RegExp([
  String.raw`[^\r\n${letter}${number}]?[${upper}]*[${lower}]+${CONTRACTION}`,
  String.raw`[^\r\n${letter}${number}]?[${upper}]+[${lower}]*${CONTRACTION}`,
  String.raw`[${number}]{1,3}`,
  String.raw` ?[^\p{White_Space}${letter}${number}]+[\r\n\/]*`,
  String.raw`\p{White_Space}*[\r\n]+`,
  String.raw`\p{White_Space}+(?!\P{White_Space})`,
  String.raw`\p{White_Space}+`,
].join("|"), flags);

const NATIVE = { letter: String.raw`\p{L}`, number: String.raw`\p{N}`, upper: String.raw`\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}`, lower: String.raw`\p{Ll}\p{Lm}\p{Lo}\p{M}` };
/** The split on the engine's own classes. */
export const O200K_SPLIT = splitOf(NATIVE.letter, NATIVE.number, NATIVE.upper, NATIVE.lower, "gu");

/** What Unicode 17 added to each class that Unicode 16 did not have in it (gpt-tokenizer's UNICODE_17_TO_16_*_EXCLUDE
 *  ranges; nothing left them), and the UTF-16 units that start any of those characters. */
const ADDED_IN_17 = {
  letter: String.raw`࢏౜೜꟎-꟏꟒꟔꟱\u{10940}-\u{10959}\u{10EC5}-\u{10EC7}\u{11DB0}-\u{11DDB}\u{16EA0}-\u{16EB8}\u{16EBB}-\u{16ED3}\u{16FF2}-\u{16FF3}\u{187F8}-\u{187FF}\u{18D09}-\u{18D1E}\u{18D80}-\u{18DF2}\u{1E6C0}-\u{1E6DE}\u{1E6E0}-\u{1E6E2}\u{1E6E4}-\u{1E6E5}\u{1E6E7}-\u{1E6ED}\u{1E6F0}-\u{1E6F4}\u{1E6FE}-\u{1E6FF}\u{2B73A}-\u{2B73F}\u{2CEA2}-\u{2CEAD}\u{323B0}-\u{33479}`,
  number: String.raw`\u{11DE0}-\u{11DE9}\u{16FF4}-\u{16FF6}`,
  upper: String.raw`ʕ࢏౜೜᫏-᫝᫠-᫫꟎꟒꟔꟱\u{10940}-\u{10959}\u{10EC5}-\u{10EC7}\u{10EFA}-\u{10EFB}\u{11B60}-\u{11B67}\u{11DB0}-\u{11DDB}\u{16EA0}-\u{16EB8}\u{16FF2}-\u{16FF3}\u{187F8}-\u{187FF}\u{18D09}-\u{18D1E}\u{18D80}-\u{18DF2}\u{1E6C0}-\u{1E6DE}\u{1E6E0}-\u{1E6F5}\u{1E6FE}-\u{1E6FF}\u{2B73A}-\u{2B73F}\u{2CEA2}-\u{2CEAD}\u{323B0}-\u{33479}`,
  lower: String.raw`࢏౜೜᫏-᫝᫠-᫫꟏꟱\u{10940}-\u{10959}\u{10EC5}-\u{10EC7}\u{10EFA}-\u{10EFB}\u{11B60}-\u{11B67}\u{11DB0}-\u{11DDB}\u{16EBB}-\u{16ED3}\u{16FF2}-\u{16FF3}\u{187F8}-\u{187FF}\u{18D09}-\u{18D1E}\u{18D80}-\u{18DF2}\u{1E6C0}-\u{1E6DE}\u{1E6E0}-\u{1E6F5}\u{1E6FE}-\u{1E6FF}\u{2B73A}-\u{2B73F}\u{2CEA2}-\u{2CEAD}\u{323B0}-\u{33479}`,
  units: String.raw`ʕ࢏౜೜᫏-᫝᫠-᫫꟎-꟏꟒꟔꟱\uD802-\uD803\uD806-\uD807\uD81B\uD821\uD823\uD839\uD86D\uD873\uD888-\uD88D`,
};
/** On a Unicode 17 engine: the split on Unicode 16's classes, and the test for a text that needs it (one holding a unit
 *  that may start a character Unicode 17 added to a class; a false alarm only costs the slower pattern). */
const UNICODE_16 = process.versions.unicode === "17.0" ? {
  split: splitOf(...(["letter", "number", "upper", "lower"] as const).map((k) => `[[${NATIVE[k]}]--[${ADDED_IN_17[k]}]]`) as [string, string, string, string], "gv"),
  needed: new RegExp(`[${ADDED_IN_17.units}]`),
} : undefined;

/** Each token's bytes (one char a byte, latin1) to its rank. */
type Ranks = Map<string, number>;
let loaded: Promise<Ranks> | undefined;
/** The vocabulary, read the first time a text is counted (a session that never counts never reads it). */
const ranks = (): Promise<Ranks> => (loaded ??= readFile(O200K_VOCABULARY, "latin1").then((text) => {
  const out: Ranks = new Map();
  for (const line of text.split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) out.set(Buffer.from(line.slice(0, space), "base64").toString("latin1"), Number(line.slice(space + 1)));
  }
  return out;
}));

/** The tokens of each piece counted, by its text: bounded, and emptied when full. */
const counted = new Map<string, number>();
const COUNTED_MAX = 100_000;

/** The o200k_base tokens of `text`, every special token's spelling counted as the plain text it is (the provider encodes
 *  a request's text so: `<|endoftext|>` in a message is text, never a special token). */
export async function o200kTokens(text: string): Promise<number> {
  const vocabulary = await ranks();
  let tokens = 0;
  const split = UNICODE_16 && UNICODE_16.needed.test(text) ? UNICODE_16.split : O200K_SPLIT;
  for (const [piece] of text.matchAll(split)) {
    let n = counted.get(piece);
    if (n === undefined) {
      n = pieceTokens(vocabulary, Buffer.from(piece, "utf8").toString("latin1"));
      if (counted.size >= COUNTED_MAX) counted.clear();
      counted.set(piece, n);
    }
    tokens += n;
  }
  return tokens;
}

/** The tokens one piece's bytes (`bytes`, a char a byte) merge to: one when the vocabulary holds them, else the parts
 *  the byte-pair rule leaves. Every single byte is a token of o200k_base. */
function pieceTokens(vocabulary: Ranks, bytes: string): number {
  const length = bytes.length;
  if (length === 0) return 0;
  if (length === 1 || vocabulary.has(bytes)) return 1;
  // The parts are a linked list over byte offsets: a live part at `i` spans [i, next[i]). `rank[i]` is the rank of the part
  // at `i` merged with the one after it (Infinity when that is no token).
  const next = new Int32Array(length + 1);
  const previous = new Int32Array(length + 1);
  const rank = new Float64Array(length + 1);
  const live = new Uint8Array(length + 1);
  const pairRank = (i: number): number => {
    const middle = next[i]!;
    return middle >= length ? Infinity : (vocabulary.get(bytes.slice(i, next[middle]!)) ?? Infinity);
  };
  // A min-heap of [rank, offset] pairs, packed flat, ordered by rank and then offset: the leftmost of the lowest first.
  const heap: number[] = [];
  const lower = (a: number, b: number) => heap[a]! < heap[b]! || (heap[a] === heap[b] && heap[a + 1]! < heap[b + 1]!);
  const swap = (a: number, b: number) => {
    const r = heap[a]!, at = heap[a + 1]!;
    heap[a] = heap[b]!; heap[a + 1] = heap[b + 1]!;
    heap[b] = r; heap[b + 1] = at;
  };
  const push = (r: number, at: number) => {
    heap.push(r, at);
    for (let i = heap.length - 2; i > 0; ) {
      const parent = (((i >> 1) - 1) >> 1) << 1;
      if (!lower(i, parent)) break;
      swap(i, parent);
      i = parent;
    }
  };
  const pop = (): [number, number] => {
    const last = heap.length - 2;
    swap(0, last);
    const top: [number, number] = [heap[last]!, heap[last + 1]!];
    heap.length = last;
    for (let i = 0; ; ) {
      const left = i * 2 + 2, right = left + 2;
      let least = i;
      if (left < heap.length && lower(left, least)) least = left;
      if (right < heap.length && lower(right, least)) least = right;
      if (least === i) break;
      swap(i, least);
      i = least;
    }
    return top;
  };
  for (let i = 0; i <= length; i++) {
    next[i] = i + 1;
    previous[i] = i - 1;
    live[i] = 1;
  }
  for (let i = 0; i < length - 1; i++) {
    rank[i] = pairRank(i);
    if (rank[i] !== Infinity) push(rank[i]!, i);
  }
  let parts = length;
  while (heap.length > 0) {
    const [r, at] = pop();
    // An entry an earlier merge made stale: its part is gone, or its pair is another now.
    if (!live[at] || rank[at] !== r) continue;
    const merged = next[at]!;
    live[merged] = 0;
    next[at] = next[merged]!;
    previous[next[merged]!] = at;
    parts--;
    rank[at] = pairRank(at);
    if (rank[at] !== Infinity) push(rank[at]!, at);
    const before = previous[at]!;
    if (before >= 0) {
      rank[before] = pairRank(before);
      if (rank[before] !== Infinity) push(rank[before]!, before);
    }
  }
  return parts;
}
