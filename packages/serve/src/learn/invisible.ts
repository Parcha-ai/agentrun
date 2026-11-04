// The Pi learning guard's rule for hidden characters, which can carry instructions a reader of the file never sees.

// Format and default-ignorable characters (zero-width, bidi controls, tag characters, variation selectors), private use,
// lone surrogates, line and paragraph separators, the braille blank, and C0/C1 controls other than tab, newline and CR.
const HIDDEN = /[\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
const EMOJI_MODIFIER = /^\p{Emoji_Modifier}$/u;
const KEYCAP_BASE = /^[0-9#*]$/;
// Scripts whose words need a joiner or non-joiner between letters (a virama, then a consonant; Persian and Urdu).
const JOINER_SCRIPT = /^[\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Khmer}\p{Script=Myanmar}]$/u;
const JOINER_BEFORE = /^[\p{L}\p{M}]$/u;
const JOINER_AFTER = /^\p{L}$/u;
const ZWNJ = "\u200c";
const ZWJ = "\u200d";
const VS16 = "\ufe0f";
const KEYCAP = "\u20e3";

/** U+FE0F after an emoji, a ZWJ inside an emoji sequence, and a ZWJ or ZWNJ between letters of a script that needs
 *  them are text. Every other hidden character is not. */
function allowedHidden(chars: readonly string[], i: number): boolean {
  const ch = chars[i]!;
  const before = chars[i - 1] ?? "";
  const after = chars[i + 1] ?? "";
  if (ch === VS16) return PICTOGRAPH.test(before) || (KEYCAP_BASE.test(before) && after === KEYCAP);
  if (ch !== ZWJ && ch !== ZWNJ) return false;
  if (JOINER_BEFORE.test(before) && JOINER_AFTER.test(after) && JOINER_SCRIPT.test(before) && JOINER_SCRIPT.test(after)) return true;
  if (ch !== ZWJ || !PICTOGRAPH.test(after)) return false;
  return PICTOGRAPH.test(before) || EMOJI_MODIFIER.test(before) || (before === VS16 && PICTOGRAPH.test(chars[i - 2] ?? ""));
}

/** The first hidden character in `text`: its code point and its index in code points. */
export function hiddenCharacter(text: string): { code: number; at: number } | undefined {
  if (!HIDDEN.test(text)) return undefined;
  const chars = Array.from(text);
  for (const [i, ch] of chars.entries()) {
    if (HIDDEN.test(ch) && !allowedHidden(chars, i)) return { code: ch.codePointAt(0)!, at: i };
  }
  return undefined;
}
