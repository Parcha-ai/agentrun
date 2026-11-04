// HTML character references decoded on the event loop without loading a DOM parser: node-html-parser's decoder (he)
// brings css-select, domutils and entities with it, and their first load holds the loop for tens of milliseconds in one
// turn. The numeric references, and the named ones HTML 4 defines (Latin-1, the symbols and Greek letters, and the
// special characters), cover what pages write; another name is left as written. The worker, which loads
// node-html-parser anyway, decodes with it.

/** The Latin-1 names, for U+00A0 to U+00FF in order. */
const LATIN1 = "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml";
/** The Greek letters from U+0391 and from U+03B1 in order ("" where none is named). */
const GREEK_UPPER = "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho  Sigma Tau Upsilon Phi Chi Psi Omega";
const GREEK_LOWER = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon phi chi psi omega";
/** The rest, by code point. */
const OTHERS: Record<string, number> = {
  quot: 34, amp: 38, apos: 39, lt: 60, gt: 62, OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402, circ: 710, tilde: 732,
  thetasym: 977, upsih: 978, piv: 982, ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207, ndash: 8211, mdash: 8212,
  lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221, bdquo: 8222, dagger: 8224, Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240,
  prime: 8242, Prime: 8243, lsaquo: 8249, rsaquo: 8250, oline: 8254, frasl: 8260, euro: 8364, image: 8465, weierp: 8472, real: 8476, trade: 8482,
  alefsym: 8501, larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596, crarr: 8629, lArr: 8656, uArr: 8657, rArr: 8658, dArr: 8659, hArr: 8660,
  forall: 8704, part: 8706, exist: 8707, empty: 8709, nabla: 8711, isin: 8712, notin: 8713, ni: 8715, prod: 8719, sum: 8721, minus: 8722, lowast: 8727,
  radic: 8730, prop: 8733, infin: 8734, ang: 8736, and: 8743, or: 8744, cap: 8745, cup: 8746, int: 8747, there4: 8756, sim: 8764, cong: 8773, asymp: 8776,
  ne: 8800, equiv: 8801, le: 8804, ge: 8805, sub: 8834, sup: 8835, nsub: 8836, sube: 8838, supe: 8839, oplus: 8853, otimes: 8855, perp: 8869, sdot: 8901,
  lceil: 8968, rceil: 8969, lfloor: 8970, rfloor: 8971, lang: 9001, rang: 9002, loz: 9674, spades: 9824, clubs: 9827, hearts: 9829, diams: 9830,
};
const NAMED = new Map<string, string>([
  ...LATIN1.split(" ").map((name, i) => [name, String.fromCharCode(0xa0 + i)] as [string, string]),
  ...GREEK_UPPER.split(" ").map((name, i) => [name, String.fromCharCode(0x391 + i)] as [string, string]),
  ...GREEK_LOWER.split(" ").map((name, i) => [name, String.fromCharCode(0x3b1 + i)] as [string, string]),
  ...Object.entries(OTHERS).map(([name, code]) => [name, String.fromCharCode(code)] as [string, string]),
].filter(([name]) => name));
/** The names a page may write without their ";" (HTML's legacy references), when no letter, digit or "=" follows. */
const BARE = new Set(["amp", "lt", "gt", "quot", "nbsp", "copy", "reg"]);
/** A numeric reference takes its whole run of digits, leading zeroes and all (`&#000000065;` is "A"), as a browser
 *  reads it: a run cut at a fixed width would read the rest of it as text. */
const REFERENCE = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]{1,31}))(;?)/g;
/** What a numeric reference to U+0080 to U+009F stands for, as a browser reads it (windows-1252's character; 0 where
 *  it stands for itself). node-html-parser's decoder, in the worker, reads them the same. */
const C1 = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017d, 0,
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178,
];

/** A numeric reference's character, as a browser reads it: U+FFFD for 0, a surrogate or a code point past U+10FFFF (a
 *  run of digits too long for a number among them), windows-1252's for U+0080 to U+009F. */
function character(code: number): string {
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\uFFFD";
  if (code >= 0x80 && code <= 0x9f) return String.fromCharCode(C1[code - 0x80] || code);
  return String.fromCodePoint(code);
}

/** `text` with its character references decoded; one this does not know is left as written. Linear: a try of the
 *  pattern reads at most a name's 32 characters, or one run of digits, which the match then passes. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(REFERENCE, (whole, decimal: string | undefined, hex: string | undefined, name: string | undefined, semi: string, at: number) => {
    if (decimal !== undefined) return character(Number(decimal));
    if (hex !== undefined) return character(parseInt(hex, 16));
    const named = NAMED.get(name!);
    if (named === undefined) return whole;
    if (semi) return named;
    const next = text.charCodeAt(at + whole.length);
    const joined = (next >= 48 && next <= 57) || ((next | 32) >= 97 && (next | 32) <= 122) || next === 61;
    return BARE.has(name!) && !joined ? named : whole;
  });
}
