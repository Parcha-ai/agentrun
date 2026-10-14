/** Run in the page: whether any field holding a credential or a one-time code has a value. It looks at password fields, fields that say
 *  `one-time-code`, and fields whose name, id, label (a `<label>` for it or around it, or `aria-labelledby`), `aria-label` or placeholder names
 *  a code (otp, totp, 2fa, passcode, ...), in the document, in open shadow roots and in same-origin frames. The answer is `true` when one holds
 *  a value now (`why: "field"`), or held one since the last check (`why: "typed"`: the page keeps a flag, set by the fields' own `input` events,
 *  that a check reports once and clears). Anything it cannot read counts as a credential being present: a page that nests deeper than it reads
 *  (`why: "too_deep"`) and a visible frame whose content it cannot reach, a cross-origin frame such as a payment or sign-in widget
 *  (`why: "unreadable_frame"`). A frame with no box on the page is not a picture of anything and is not counted. The answer is `{ hold, why }`.
 *  What it cannot see at all (a closed shadow root, a value set by script with no event) is the host's to pause with `frames.pause`. (Elements are told by tag, not by class: a frame's elements are of its own realm.) */
export const CREDENTIAL_PROBE = `(() => {
  const named = /(^|[^a-z])(otp|totp|2fa|mfa|passcode|one[-_ ]?time|verification[-_ ]?code|security[-_ ]?code|auth(entication)?[-_ ]?code)([^a-z]|$)/i;
  const words = (el) => {
    let text = [el.name, el.id, el.getAttribute("aria-label") || "", el.placeholder || ""].join(" ");
    try { for (const label of el.labels || []) text += " " + label.textContent; } catch (error) { /* no labels */ }
    const ids = el.getAttribute("aria-labelledby");
    if (ids) { const root = el.getRootNode(); for (const id of ids.split(/\s+/)) { const node = root.getElementById ? root.getElementById(id) : null; if (node) text += " " + node.textContent; } }
    return text;
  };
  const like = (el) => el.localName === "input" && (el.type === "password" || el.autocomplete === "one-time-code" || named.test(words(el)));
  const state = window.__piFramesSecret || (window.__piFramesSecret = { seen: false });
  if (!state.listening) {
    state.listening = true;
    addEventListener("input", (event) => { const el = event.target; if (el && el.localName === "input" && el.value !== "" && like(el)) state.seen = true; }, true);
  }
  let blind = null;
  const shown = (el) => { const style = getComputedStyle(el); return el.clientWidth >= 2 && el.clientHeight >= 2 && style.display !== "none" && style.visibility !== "hidden"; };
  const scan = (root, depth) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.localName === "input" && el.value !== "" && like(el)) return true;
      const shadow = el.shadowRoot;
      const frame = el.localName === "iframe";
      if (!shadow && !frame) continue;
      if (depth >= 8) { blind = blind || "too_deep"; continue; }
      if (shadow && scan(shadow, depth + 1)) return true;
      if (frame) {
        let inside = null;
        try { inside = el.contentDocument; } catch (error) { inside = null; }
        if (inside) { if (scan(inside, depth + 1)) return true; }
        else if (shown(el)) blind = blind || "unreadable_frame";
      }
    }
    return false;
  };
  const found = scan(document, 0);
  const seen = state.seen;
  state.seen = false;
  if (found) return { hold: true, why: "field" };
  if (seen) return { hold: true, why: "typed" };
  return blind ? { hold: true, why: blind } : { hold: false, why: null };
})()`;
