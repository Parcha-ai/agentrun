import { flushSync } from "react-dom";

/** Read only on an explicit Paste/Replace click. Keep credentials in the uncontrolled password input, never state
 *  or markup. Clipboard access may be unavailable or refused: the focused input remains ready for manual paste. */
export async function pasteFromClipboard(open: () => void, target: () => HTMLInputElement | null) {
  // Start inside the click gesture, before opening the form or awaiting anything (required by some browsers).
  let read: Promise<string>;
  try { read = navigator.clipboard?.readText().catch(() => "") ?? Promise.resolve(""); }
  catch { read = Promise.resolve(""); }
  flushSync(open);
  const input = target();
  if (!input || input.disabled || input.readOnly) return;
  input.focus();
  const initial = input.value;
  let edited = false;
  const changed = () => { edited = true; };
  input.addEventListener("input", changed);
  try {
    const text = await read;
    // A late clipboard response must never fill a reopened form or overwrite the user's intervening edits.
    if (!text || !input.isConnected || edited || input.value !== initial || input.disabled || input.readOnly) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  } finally {
    input.removeEventListener("input", changed);
  }
}
