import { act } from "react";

// Driving the console's SearchPicker (components/ui/search-picker.tsx, Headless UI's Combobox) in a test, as a person
// does: its field is a search box that opens a listbox of options as it is focused or typed in. The field and each
// option carry the value they stand for (data-value).

// The list's positioning watches its field's size; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

/** The search picker named `label` in `scope` (its search box), or null. */
export const searchPicker = (scope: ParentNode, label: string) => scope.querySelector<HTMLInputElement>(`input[data-search-picker][aria-label="${label}"]`);

/** Types `text` into a search picker's box, as a person does: the field's value, then its input event. */
export async function typeIn(field: HTMLInputElement, text: string) {
  await act(async () => {
    field.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

/** The list the search picker shows now, or null while it is closed. */
const list = (field: HTMLInputElement) => {
  const id = field.getAttribute("aria-controls");
  return id ? document.getElementById(id) : null;
};

/** What a search picker's list shows after typing `query` (default: whatever is typed now, the whole list for none):
 *  each option's text and value, and the line it reads when nothing matches. Leaves the list open. */
export async function shownIn(field: HTMLInputElement, query?: string) {
  if (query !== undefined) await typeIn(field, query);
  else if (!list(field)) {
    await act(async () => { field.parentElement!.querySelector<HTMLButtonElement>("button")!.click(); });
    await settle();
  }
  const open = list(field);
  if (!open) throw new Error(`the search picker ${field.getAttribute("aria-label")} opened no list`);
  return {
    options: [...open.querySelectorAll('[role="option"]')].map((o) => ({ text: o.textContent ?? "", value: o.getAttribute("data-value") ?? "", disabled: o.getAttribute("aria-disabled") === "true" })),
    nothing: open.querySelector("[data-search-nothing]")?.textContent ?? null,
  };
}

/** Picks `value` in a search picker: types `query` (default: nothing, the whole list) and presses that option. */
export async function searchPick(field: HTMLInputElement, value: string, query = "") {
  await shownIn(field, query);
  const option = list(field)?.querySelector<HTMLElement>(`[role="option"][data-value="${value}"]`);
  if (!option) throw new Error(`the search picker ${field.getAttribute("aria-label")} lists no option ${value} for “${query}”`);
  // A combobox option is picked on the pointer's press (a left mousedown), as Headless UI's Combobox takes it.
  await act(async () => { option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 })); });
  await settle();
}
