import { Fragment, type ReactNode } from "react";

/** The scrubber's marker for a cut value (serve's secret-cut.ts MARKER): `[redacted:<rule>]`, and a dump's
 *  `[redacted:<rule> N lines]`. The bare `[redacted]` older cuts write names no rule and stays text. */
export const REDACTION_SOURCE = String.raw`\[redacted:[a-z0-9-]{1,64}(?: \d{1,9} lines)?\]`;
const REDACTION = new RegExp(REDACTION_SOURCE, "g");
/** A marker's rule: the word after "redacted:". */
const ruleOf = (marker: string) => /^\[redacted:([a-z0-9-]+)/.exec(marker)![1]!;
/** The class a marker's chip carries (styles.css): it reads as a cut, not as words the run wrote. */
export const REDACTION_CLASS = "redaction";

/** `text` with each marker drawn as a chip that keeps the marker's own words, so the page says what the bundle says. */
export function Redactions({ text }: { text: string }): ReactNode {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(REDACTION)) {
    if (m.index > at) parts.push(text.slice(at, m.index));
    parts.push(<span key={m.index} className={REDACTION_CLASS} data-rule={ruleOf(m[0])}>{m[0]}</span>);
    at = m.index + m[0].length;
  }
  if (!parts.length) return text;
  if (at < text.length) parts.push(text.slice(at));
  return <Fragment>{parts}</Fragment>;
}

/** The same chips in sanitized HTML (`markdown`'s DOM): each text node's markers wrapped in place, as text nodes. */
export function chipRedactions(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const hits: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (new RegExp(REDACTION_SOURCE).test(node.nodeValue ?? "")) hits.push(node as Text);
  for (const node of hits) {
    const text = node.nodeValue!;
    const out = doc.createDocumentFragment();
    let at = 0;
    for (const m of text.matchAll(REDACTION)) {
      if (m.index > at) out.append(text.slice(at, m.index));
      const chip = doc.createElement("span");
      chip.className = REDACTION_CLASS;
      chip.dataset.rule = ruleOf(m[0]);
      chip.textContent = m[0];
      out.append(chip);
      at = m.index + m[0].length;
    }
    if (at < text.length) out.append(text.slice(at));
    node.replaceWith(out);
  }
}
